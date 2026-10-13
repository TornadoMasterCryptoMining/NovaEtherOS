// Nova AI: a local coding-agent workstation on top of Ollama. Chats run on the
// server (closing the browser doesn't stop them); the dashboard polls for
// progress and approves commands.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { JsonStore } from "../bitcoin/store.js";
import { anyRunning, startJob, unitLog, unitRunning } from "../system-jobs.js";
import { CATALOG, fitsIn } from "./catalog.js";
import { Ollama, type ChatMessage, type PullProgress } from "./ollama.js";
import { NEEDS_APPROVAL, TOOLS, truncate, Workspace } from "./tools.js";

const NOVA_CLI = "/usr/local/bin/nova";
const INSTALL_PREFIX = "nova-ai";
const LOCAL_URL = "http://127.0.0.1:11434";
const MAX_STEPS = 30;
const OLLAMA_BINS = ["/usr/local/bin/ollama", "/usr/bin/ollama"];

export interface StoredMessage extends ChatMessage {
  at: number;
  args?: Record<string, unknown>; // for tool results: what the tool was called with
  note?: boolean; // NovaEtherOS's own notice, not sent to the model
  error?: boolean;
  stats?: { tokens: number; seconds: number };
}

export interface Chat {
  id: string;
  title: string;
  model: string;
  mode: "agent" | "chat";
  created_at: number;
  updated_at: number;
  messages: StoredMessage[];
}

interface Run {
  abort: AbortController;
  status: string;
  live: { content: string; thinking: string };
  pending: { name: string; args: Record<string, unknown>; resolve: (ok: boolean) => void } | null;
}

const defaults = {
  ollama_url: null as string | null, // null: the engine on this machine
  default_model: null as string | null,
  num_ctx: 8192,
  auto_approve: false,
  instructions: "", // extra instructions added to every chat
};
export type AISettings = typeof defaults;

function systemPrompt(chat: Chat, workspace: string, extra: string) {
  const lines = [
    "You are Nova, the AI agent built into NovaEtherOS, a personal home server (Debian Linux) that runs the owner's own Bitcoin node, solo mining pool and miners.",
    "You are an expert software engineer. Write correct, complete, working code and explain briefly what you did.",
    // Small open models often claim to be GPT-4 or ChatGPT (their training data is full of
    // its answers), so tell them exactly what they are.
    `You run locally on the owner's own hardware through Ollama, using the open model "${chat.model}". ` +
      `If asked what model or AI you are, say you are Nova running ${chat.model}. ` +
      "You are not GPT-4, ChatGPT or any OpenAI model, and nothing is sent to OpenAI or any other cloud service.",
  ];
  if (chat.mode === "agent") {
    lines.push(
      `You work inside the workspace folder ${workspace}. All file paths are relative to it.`,
      "Use your tools to get things done instead of telling the user to do them:",
      "- Look before you change: list_files, read_file and search to understand existing code.",
      "- Make changes with edit_file (small, exact replacements) or write_file (new files or full rewrites).",
      "- Use run_command to install dependencies, run code, tests and builds, and check that your changes work. Fix errors you find.",
      "- Commands run as an unprivileged user without sudo. Install tools per project (npm install, python3 -m venv .venv, pip install inside it).",
      "- nova_status shows the Bitcoin node, pool and miners.",
      "Call one tool at a time and wait for its result. When the task is done, reply with a short summary of what changed and how to use it.",
    );
  } else {
    lines.push("Format code in fenced code blocks with the language name.");
  }
  if (extra.trim()) lines.push("", "Owner's instructions:", extra.trim());
  return lines.join("\n");
}

// What the model gets to see of a stored message. Older tool output is
// shortened so long sessions fit in the context window.
function forModel(messages: StoredMessage[]): ChatMessage[] {
  const visible = messages.filter((m) => !m.note);
  return visible.map((m, i) => {
    const recent = i >= visible.length - 8;
    let content = m.role === "tool" && !recent ? truncate(m.content, 1500) : m.content;
    if (m.role === "assistant") content = content.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    const out: ChatMessage = { role: m.role, content };
    if (m.tool_calls) out.tool_calls = m.tool_calls;
    if (m.tool_name) out.tool_name = m.tool_name;
    return out;
  });
}

export class AIWorkstation {
  private settings: JsonStore<AISettings>;
  private installJob: JsonStore<{ started_at: number; unit: string | null }>;
  private chatsDir: string;
  private chats = new Map<string, Chat>();
  private runs = new Map<string, Run>();
  private pulls = new Map<string, { status: string; total: number; completed: number; error: string | null; abort: AbortController }>();
  readonly ollama: Ollama;
  readonly workspace: Workspace;

  constructor(
    private opts: {
      dir: string;
      workspace: string;
      agentUser: string;
      protect: string[]; // folders commands may never see
      novaStatus: () => unknown;
    },
  ) {
    this.settings = new JsonStore(path.join(opts.dir, "settings.json"), defaults);
    this.installJob = new JsonStore(path.join(opts.dir, "install-job.json"), { started_at: 0, unit: null });
    this.chatsDir = path.join(opts.dir, "chats");
    this.ollama = new Ollama(() => this.url);
    this.workspace = new Workspace(opts.workspace, opts.agentUser);
  }

  start() {
    fs.mkdirSync(this.chatsDir, { recursive: true });
    for (const f of fs.readdirSync(this.chatsDir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const chat = JSON.parse(fs.readFileSync(path.join(this.chatsDir, f), "utf8")) as Chat;
        this.chats.set(chat.id, chat);
      } catch {
        // skip a damaged file
      }
    }
    void this.workspace.ensure().catch((err) => console.error("[ai] workspace:", err));
  }

  get url() {
    return this.settings.get("ollama_url") || LOCAL_URL;
  }

  get defaultModel() {
    return this.settings.get("default_model");
  }

  get contextSize() {
    return this.settings.get("num_ctx");
  }

  private get local() {
    return !this.settings.get("ollama_url");
  }

  private get installed() {
    return OLLAMA_BINS.some((b) => fs.existsSync(b));
  }

  // ----- engine & models -----

  async status() {
    const version = await this.ollama.version();
    let models: Awaited<ReturnType<Ollama["models"]>> = [];
    let loaded: Awaited<ReturnType<Ollama["loaded"]>> = [];
    if (version) {
      [models, loaded] = await Promise.all([
        this.ollama.models().catch(() => []),
        this.ollama.loaded().catch(() => []),
      ]);
    }
    const ram = os.totalmem();
    const installedNames = new Set(models.map((m) => m.name));
    return {
      engine: {
        url: this.url,
        local: this.local,
        installed: this.local ? this.installed : null,
        reachable: Boolean(version),
        version,
        can_install: process.platform === "linux" && process.getuid?.() === 0 && fs.existsSync(NOVA_CLI),
      },
      install_job: {
        running: (await unitRunning(this.installJob.get("unit"))) || (await anyRunning(INSTALL_PREFIX)),
        started_at: this.installJob.get("started_at"),
        log: await unitLog(this.installJob.get("unit"), this.installJob.get("started_at"), 120),
      },
      hardware: { ram, free_ram: os.freemem(), cpus: os.cpus().length, arch: os.arch() },
      models: models.map((m) => ({
        name: m.name,
        size: m.size,
        modified_at: m.modified_at,
        parameter_size: m.details?.parameter_size ?? null,
        quantization: m.details?.quantization_level ?? null,
        loaded: loaded.some((l) => l.name === m.name),
      })),
      catalog: CATALOG.map((c) => ({
        ...c,
        installed: installedNames.has(c.name),
        fits: this.local ? fitsIn(c.size, ram) : null,
      })),
      pulls: Object.fromEntries(
        [...this.pulls].map(([name, p]) => [name, { status: p.status, total: p.total, completed: p.completed, error: p.error }]),
      ),
      settings: this.settings.snapshot(),
      workspace: this.workspace.root,
      sandboxed: this.workspace.sandboxed,
    };
  }

  saveSettings(values: Partial<AISettings>) {
    const next: Partial<AISettings> = {};
    if ("ollama_url" in values) {
      const url = String(values.ollama_url ?? "").trim().replace(/\/+$/, "");
      if (url && !/^https?:\/\/[^\s/]+(:\d+)?$/.test(url)) throw new Error("Use an address like http://192.168.0.112:11434");
      next.ollama_url = url || null;
    }
    if ("default_model" in values) next.default_model = values.default_model ? String(values.default_model) : null;
    if ("num_ctx" in values) next.num_ctx = Math.min(Math.max(Number(values.num_ctx) || 8192, 2048), 131072);
    if ("auto_approve" in values) next.auto_approve = Boolean(values.auto_approve);
    if ("instructions" in values) next.instructions = String(values.instructions ?? "").slice(0, 4000);
    this.settings.update(next);
    return this.settings.snapshot();
  }

  async install() {
    if (!(process.platform === "linux" && process.getuid?.() === 0 && fs.existsSync(NOVA_CLI))) {
      throw new Error("The AI engine can only be installed on the NovaEtherOS machine.");
    }
    if ((await unitRunning(this.installJob.get("unit"))) || (await anyRunning(INSTALL_PREFIX))) {
      throw new Error("The AI engine is already being installed.");
    }
    const startedAt = Date.now();
    const unit = await startJob(INSTALL_PREFIX, [NOVA_CLI, "ai-install"]);
    this.installJob.update({ started_at: startedAt, unit });
  }

  pull(name: string) {
    name = name.trim();
    if (!/^[\w.\-/:]+$/.test(name)) throw new Error("Enter a model name like qwen2.5-coder:3b");
    const existing = this.pulls.get(name);
    if (existing && !existing.error) throw new Error(`${name} is already downloading.`);
    const p = { status: "starting", total: 0, completed: 0, error: null as string | null, abort: new AbortController() };
    this.pulls.set(name, p);
    void this.ollama
      .pull(
        name,
        (prog: PullProgress) => {
          p.status = prog.status;
          if (prog.total) {
            p.total = prog.total;
            p.completed = prog.completed ?? 0;
          }
        },
        p.abort.signal,
      )
      .then(() => {
        this.pulls.delete(name);
        if (!this.settings.get("default_model")) this.settings.update({ default_model: name });
      })
      .catch((err) => {
        p.error = p.abort.signal.aborted ? "Cancelled." : (err as Error).message;
      });
  }

  cancelPull(name: string) {
    const p = this.pulls.get(name);
    if (!p) return;
    if (p.error) this.pulls.delete(name);
    else p.abort.abort();
  }

  async removeModel(name: string) {
    await this.ollama.remove(name);
    if (this.settings.get("default_model") === name) this.settings.update({ default_model: null });
  }

  // ----- chats -----

  private save(chat: Chat) {
    chat.updated_at = Date.now();
    const file = path.join(this.chatsDir, `${chat.id}.json`);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(chat));
    fs.renameSync(`${file}.tmp`, file);
  }

  private get(id: string) {
    const chat = this.chats.get(id);
    if (!chat) throw new Error("Chat not found.");
    return chat;
  }

  list() {
    return [...this.chats.values()]
      .sort((a, b) => b.updated_at - a.updated_at)
      .map((c) => ({ id: c.id, title: c.title, model: c.model, mode: c.mode, updated_at: c.updated_at, running: this.runs.has(c.id) }));
  }

  create(model?: string, mode?: string) {
    const chat: Chat = {
      id: crypto.randomBytes(6).toString("hex"),
      title: "New chat",
      model: model || this.settings.get("default_model") || "",
      mode: mode === "chat" ? "chat" : "agent",
      created_at: Date.now(),
      updated_at: Date.now(),
      messages: [],
    };
    this.chats.set(chat.id, chat);
    this.save(chat);
    return this.view(chat.id);
  }

  view(id: string) {
    const chat = this.get(id);
    const run = this.runs.get(id);
    return {
      ...chat,
      running: Boolean(run),
      status: run?.status ?? null,
      live: run ? run.live : null,
      pending: run?.pending ? { name: run.pending.name, args: run.pending.args } : null,
    };
  }

  remove(id: string) {
    this.stop(id);
    this.chats.delete(id);
    fs.rmSync(path.join(this.chatsDir, `${id}.json`), { force: true });
  }

  stop(id: string) {
    const run = this.runs.get(id);
    if (!run) return;
    run.abort.abort();
    run.pending?.resolve(false);
  }

  approve(id: string, ok: boolean) {
    const run = this.runs.get(id);
    if (!run?.pending) throw new Error("Nothing is waiting for approval.");
    run.pending.resolve(ok);
  }

  send(id: string, content: string, model?: string, mode?: string) {
    const chat = this.get(id);
    if (this.runs.has(id)) throw new Error("Nova is still working on this chat. Stop it first.");
    if (!content.trim()) throw new Error("Type a message first.");
    if (model) chat.model = model;
    if (mode === "agent" || mode === "chat") chat.mode = mode;
    if (!chat.model) throw new Error("Download a model first (Models tab).");
    if (chat.title === "New chat") chat.title = content.trim().split("\n")[0].slice(0, 60);
    chat.messages.push({ role: "user", content, at: Date.now() });
    this.save(chat);

    const run: Run = { abort: new AbortController(), status: "Thinking…", live: { content: "", thinking: "" }, pending: null };
    this.runs.set(id, run);
    void this.loop(chat, run)
      .catch((err) => this.push(chat, { role: "assistant", content: `Error: ${(err as Error).message}`, error: true, note: true }))
      .finally(() => this.runs.delete(id));
    return this.view(id);
  }

  private push(chat: Chat, m: Omit<StoredMessage, "at">) {
    chat.messages.push({ ...m, at: Date.now() });
    this.save(chat);
  }

  private async loop(chat: Chat, run: Run) {
    const signal = run.abort.signal;
    let useTools = chat.mode === "agent";

    for (let step = 0; step < MAX_STEPS; step++) {
      run.status = step ? "Thinking about the result…" : "Thinking…";
      run.live = { content: "", thinking: "" };
      let reply;
      try {
        reply = await this.ollama.chat({
          model: chat.model,
          messages: [
            { role: "system", content: systemPrompt({ ...chat, mode: useTools ? "agent" : "chat" }, this.workspace.root, this.settings.get("instructions")) },
            ...forModel(chat.messages),
          ],
          tools: useTools ? TOOLS : undefined,
          options: { num_ctx: this.settings.get("num_ctx") },
          signal,
          onDelta: (d) => {
            run.status = "Writing…";
            run.live.content += d.content;
            run.live.thinking += d.thinking;
          },
        });
      } catch (err) {
        if (signal.aborted) {
          if (run.live.content) this.push(chat, { role: "assistant", content: run.live.content });
          this.push(chat, { role: "assistant", content: "Stopped.", note: true });
          return;
        }
        const message = (err as Error).message;
        if (useTools && /does not support tools/i.test(message)) {
          useTools = false;
          this.push(chat, {
            role: "assistant",
            content: `${chat.model} can't use tools, so this reply is chat-only. Pick a model marked "agent" to let Nova work on files and run commands.`,
            note: true,
          });
          step--;
          continue;
        }
        if (/fetch failed|ECONNREFUSED/i.test(message)) {
          throw new Error(`Can't reach the AI engine at ${this.url}. Check the Models tab.`);
        }
        throw err;
      }

      const { message, stats } = reply;
      this.push(chat, { ...message, stats });
      if (!message.tool_calls?.length) return;

      for (const call of message.tool_calls) {
        const name = call.function.name;
        let args = call.function.arguments ?? {};
        if (typeof args === "string") {
          try {
            args = JSON.parse(args);
          } catch {
            args = {};
          }
        }
        if (signal.aborted) return;

        if (NEEDS_APPROVAL.has(name) && !this.settings.get("auto_approve")) {
          run.status = "Waiting for your approval";
          const ok = await new Promise<boolean>((resolve) => (run.pending = { name, args, resolve }));
          run.pending = null;
          if (signal.aborted) {
            this.push(chat, { role: "assistant", content: "Stopped.", note: true });
            return;
          }
          if (!ok) {
            this.push(chat, { role: "tool", tool_name: name, args, content: "The user declined to run this. Ask them what to do instead, or try another way." });
            continue;
          }
        }

        run.status = name === "run_command" ? `Running: ${String(args.command ?? "").slice(0, 80)}` : `Using ${name}…`;
        let output: string;
        try {
          output = await this.runTool(name, args, signal);
        } catch (err) {
          output = `Error: ${(err as Error).message}`;
        }
        this.push(chat, { role: "tool", tool_name: name, args, content: truncate(output) });
        if (signal.aborted) {
          this.push(chat, { role: "assistant", content: "Stopped.", note: true });
          return;
        }
      }
    }
    this.push(chat, {
      role: "assistant",
      content: `Paused after ${MAX_STEPS} steps. Say "continue" to let Nova keep going.`,
      note: true,
    });
  }

  private async runTool(name: string, a: Record<string, unknown>, signal: AbortSignal): Promise<string> {
    const ws = this.workspace;
    const str = (k: string) => (a[k] == null ? undefined : String(a[k]));
    const num = (k: string) => (a[k] == null || a[k] === "" ? undefined : Number(a[k]));
    switch (name) {
      case "list_files":
        return ws.list(str("path"), Math.min(Math.max(num("depth") ?? 2, 1), 5));
      case "read_file":
        return ws.read(str("path") ?? "", num("offset"), num("limit"));
      case "write_file":
        return ws.write(str("path") ?? "", str("content") ?? "");
      case "edit_file":
        return ws.edit(str("path") ?? "", str("old_text") ?? "", str("new_text") ?? "", a.replace_all === true || a.replace_all === "true");
      case "search":
        return ws.search(str("pattern") ?? "", str("path"));
      case "run_command":
        return ws.runCommand(str("command") ?? "", num("timeout") ?? 120, signal, this.opts.protect);
      case "nova_status":
        return JSON.stringify(this.opts.novaStatus(), null, 1);
      default:
        throw new Error(`Unknown tool ${name}.`);
    }
  }
}
