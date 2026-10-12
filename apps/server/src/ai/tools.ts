// The AI agent's tools. Files are limited to its workspace folder; commands run
// as the unprivileged `nova-agent` user in a locked-down systemd unit that can't
// write outside the workspace, read NovaEtherOS's data, or reach services on
// this machine (the dashboard, Bitcoin RPC, the pool).

import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { ToolSpec } from "./ollama.js";

const run = promisify(execFile);

export const MAX_OUTPUT = 12_000;
const SKIP_DIRS = new Set([".git", "node_modules", ".venv", "venv", "__pycache__", "dist", "build", ".next", "target"]);

const fn = (name: string, description: string, properties: Record<string, unknown>, required: string[] = []): ToolSpec => ({
  type: "function",
  function: { name, description, parameters: { type: "object", properties, required } },
});

export const TOOLS: ToolSpec[] = [
  fn("list_files", "List files and folders in the workspace (skips node_modules, .git and build output).", {
    path: { type: "string", description: "Folder relative to the workspace. Default: the workspace root." },
    depth: { type: "integer", description: "How many levels deep to list (1-5). Default 2." },
  }),
  fn("read_file", "Read a text file from the workspace, with line numbers.", {
    path: { type: "string", description: "File path relative to the workspace." },
    offset: { type: "integer", description: "First line to read (1-based). Default 1." },
    limit: { type: "integer", description: "Number of lines to read. Default 400." },
  }, ["path"]),
  fn("write_file", "Create or overwrite a file in the workspace with the given content. Creates folders as needed.", {
    path: { type: "string", description: "File path relative to the workspace." },
    content: { type: "string", description: "The complete new file content." },
  }, ["path", "content"]),
  fn("edit_file", "Replace an exact piece of text in a file. old_text must appear exactly once unless replace_all is true. Read the file first.", {
    path: { type: "string", description: "File path relative to the workspace." },
    old_text: { type: "string", description: "Exact text to replace, including whitespace." },
    new_text: { type: "string", description: "Replacement text." },
    replace_all: { type: "boolean", description: "Replace every occurrence. Default false." },
  }, ["path", "old_text", "new_text"]),
  fn("search", "Search file contents in the workspace with a regular expression. Returns file:line: text matches.", {
    pattern: { type: "string", description: "Regular expression (case-insensitive)." },
    path: { type: "string", description: "Folder to search, relative to the workspace. Default: everything." },
  }, ["pattern"]),
  fn("run_command", "Run a bash command in the workspace (e.g. git, npm, python3, node, tests, builds) and return its output and exit code. Has internet access, but no root and no access to this machine's own services.", {
    command: { type: "string", description: "The bash command line to run." },
    timeout: { type: "integer", description: "Seconds before the command is stopped (max 900). Default 120." },
  }, ["command"]),
  fn("nova_status", "Get a read-only summary of this NovaEtherOS machine: Bitcoin node sync, solo pool and miners.", {}),
];

// Tools the user has to approve first (unless auto-approve is on).
export const NEEDS_APPROVAL = new Set(["run_command"]);

export function truncate(text: string, max = MAX_OUTPUT) {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.7);
  return `${text.slice(0, head)}\n\n… [${text.length - max} characters cut] …\n\n${text.slice(text.length - (max - head))}`;
}

const within = (root: string, p: string) => p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

export class Workspace {
  private owner: { uid: number; gid: number } | null | undefined;

  constructor(readonly root: string, private user: string) {}

  // Is NovaEtherOS running as root on Linux (the real machine)?
  get sandboxed() {
    return process.platform === "linux" && process.getuid?.() === 0;
  }

  private async agentIds() {
    if (this.owner !== undefined) return this.owner;
    try {
      const uid = Number((await run("id", ["-u", this.user])).stdout.trim());
      const gid = Number((await run("id", ["-g", this.user])).stdout.trim());
      this.owner = { uid, gid };
    } catch {
      this.owner = null;
    }
    return this.owner;
  }

  async ensure() {
    fs.mkdirSync(this.root, { recursive: true });
    if (this.sandboxed) {
      const ids = await this.agentIds();
      if (ids) fs.chownSync(this.root, ids.uid, ids.gid);
    }
  }

  // Resolve a workspace-relative path, refusing anything (including symlinks)
  // that leads outside the workspace.
  resolve(rel = ".") {
    const root = fs.realpathSync(this.root);
    const abs = path.resolve(root, rel.replace(/^\/+/, ""));
    if (!within(root, abs)) throw new Error(`${rel} is outside the workspace.`);
    let existing = abs;
    while (!fs.existsSync(existing)) existing = path.dirname(existing);
    if (!within(root, fs.realpathSync(existing))) throw new Error(`${rel} points outside the workspace.`);
    return abs;
  }

  relative(abs: string) {
    return path.relative(fs.realpathSync(this.root), abs).split(path.sep).join("/") || ".";
  }

  // Files the dashboard writes belong to the agent user, so its commands can change them.
  private async chownUp(abs: string) {
    if (!this.sandboxed) return;
    const ids = await this.agentIds();
    if (!ids) return;
    const root = fs.realpathSync(this.root);
    for (let p = abs; within(root, p) && p !== root; p = path.dirname(p)) fs.chownSync(p, ids.uid, ids.gid);
  }

  list(rel = ".", depth = 2) {
    const start = this.resolve(rel);
    const lines: string[] = [];
    const walk = (dir: string, level: number, indent: string) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
      for (const e of entries) {
        if (lines.length >= 400) return;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          const skipped = SKIP_DIRS.has(e.name);
          lines.push(`${indent}${e.name}/${skipped ? " (skipped)" : ""}`);
          if (!skipped && level < depth) walk(full, level + 1, indent + "  ");
        } else {
          let size = 0;
          try {
            size = fs.statSync(full).size;
          } catch {
            // broken link
          }
          lines.push(`${indent}${e.name} (${size} bytes)`);
        }
      }
    };
    walk(start, 1, "");
    if (lines.length >= 400) lines.push("… (more entries not shown)");
    return lines.length ? lines.join("\n") : "(empty folder)";
  }

  // Directory listing for the dashboard's file browser.
  entries(rel = ".") {
    const dir = this.resolve(rel);
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .map((e) => {
        let size = 0;
        let mtime = 0;
        try {
          const st = fs.statSync(path.join(dir, e.name));
          size = st.size;
          mtime = st.mtimeMs;
        } catch {
          // broken link
        }
        return { name: e.name, dir: e.isDirectory(), size, mtime };
      })
      .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
  }

  readText(rel: string, maxBytes = 2_000_000) {
    const abs = this.resolve(rel);
    const st = fs.statSync(abs);
    if (st.isDirectory()) throw new Error(`${rel} is a folder. Use list_files.`);
    if (st.size > maxBytes) throw new Error(`${rel} is too big to read (${st.size} bytes).`);
    const buf = fs.readFileSync(abs);
    if (buf.subarray(0, 8000).includes(0)) throw new Error(`${rel} is a binary file.`);
    return buf.toString("utf8");
  }

  read(rel: string, offset = 1, limit = 400) {
    const lines = this.readText(rel).split("\n");
    const from = Math.max(1, Math.floor(offset));
    const slice = lines.slice(from - 1, from - 1 + Math.max(1, Math.floor(limit)));
    const body = slice.map((l, i) => `${String(from + i).padStart(5)}  ${l}`).join("\n");
    const more = from - 1 + slice.length < lines.length ? `\n… (${lines.length} lines total; read more with offset)` : "";
    return truncate(body + more, 40_000);
  }

  async write(rel: string, content: string) {
    if (content.length > 2_000_000) throw new Error("File content is too big (max 2 MB).");
    const abs = this.resolve(rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const existed = fs.existsSync(abs);
    fs.writeFileSync(abs, content);
    await this.chownUp(abs);
    return `${existed ? "Updated" : "Created"} ${this.relative(abs)} (${content.split("\n").length} lines).`;
  }

  async edit(rel: string, oldText: string, newText: string, replaceAll = false) {
    if (!oldText) throw new Error("old_text is empty.");
    const text = this.readText(rel);
    const count = text.split(oldText).length - 1;
    if (count === 0) throw new Error(`old_text was not found in ${rel}. Read the file again and copy the text exactly.`);
    if (count > 1 && !replaceAll) {
      throw new Error(`old_text appears ${count} times in ${rel}. Include more surrounding lines, or set replace_all.`);
    }
    const updated = replaceAll ? text.split(oldText).join(newText) : text.replace(oldText, () => newText);
    fs.writeFileSync(this.resolve(rel), updated);
    return `Edited ${rel} (${replaceAll ? count : 1} replacement${count > 1 && replaceAll ? "s" : ""}).`;
  }

  search(pattern: string, rel = ".") {
    let re: RegExp;
    try {
      re = new RegExp(pattern, "i");
    } catch {
      re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    }
    const start = this.resolve(rel);
    const out: string[] = [];
    let files = 0;
    const walk = (dir: string) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (out.length >= 150 || files >= 3000) return;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (!SKIP_DIRS.has(e.name)) walk(full);
          continue;
        }
        files++;
        let buf: Buffer;
        try {
          if (fs.statSync(full).size > 1_000_000) continue;
          buf = fs.readFileSync(full);
        } catch {
          continue;
        }
        if (buf.subarray(0, 8000).includes(0)) continue;
        const lines = buf.toString("utf8").split("\n");
        for (let i = 0; i < lines.length && out.length < 150; i++) {
          if (re.test(lines[i])) out.push(`${this.relative(full)}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
        }
      }
    };
    fs.statSync(start).isDirectory() ? walk(start) : walk(path.dirname(start));
    return out.length ? out.join("\n") + (out.length >= 150 ? "\n… (more matches not shown)" : "") : "No matches.";
  }

  // Addresses that belong to this machine: the sandbox may not connect to them.
  private ownAddresses() {
    const addrs = ["localhost", "link-local", "multicast"];
    for (const list of Object.values(os.networkInterfaces())) {
      for (const a of list ?? []) if (!a.internal) addrs.push(a.address);
    }
    return addrs.join(" ");
  }

  // A local DNS resolver (e.g. systemd-resolved on 127.0.0.53) must stay reachable.
  private localResolvers() {
    try {
      return fs
        .readFileSync("/etc/resolv.conf", "utf8")
        .split("\n")
        .map((l) => l.match(/^\s*nameserver\s+(\S+)/)?.[1])
        .filter((ip): ip is string => Boolean(ip && (ip.startsWith("127.") || ip === "::1")));
    } catch {
      return [];
    }
  }

  async runCommand(command: string, timeoutS: number, signal: AbortSignal, protect: string[]) {
    const timeout = Math.min(Math.max(Math.floor(timeoutS) || 120, 5), 900);
    let cmd: string;
    let args: string[];
    let unit: string | null = null;

    if (this.sandboxed) {
      const ids = await this.agentIds();
      if (!ids) throw new Error(`The ${this.user} user is missing. Run 'sudo nova update' on the NovaEtherOS machine.`);
      const home = path.dirname(fs.realpathSync(this.root));
      unit = `nova-agent-cmd-${Date.now()}`;
      cmd = "systemd-run";
      const resolvers = this.localResolvers();
      args = [
        "--unit", unit, "--quiet", "--pipe", "--wait", "--collect",
        `--uid=${this.user}`, `--gid=${this.user}`, `--working-directory=${fs.realpathSync(this.root)}`,
        "-E", `HOME=${home}`, "-E", "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "-E", "TERM=dumb", "-E", "CI=1",
        "-p", `RuntimeMaxSec=${timeout}`,
        "-p", "NoNewPrivileges=yes",
        "-p", "PrivateTmp=yes",
        "-p", "ProtectSystem=strict",
        "-p", "ProtectHome=yes",
        "-p", `ReadWritePaths=${home}`,
        "-p", `InaccessiblePaths=${protect.map((p) => `-${p}`).join(" ")}`,
        "-p", `IPAddressDeny=${this.ownAddresses()}`,
        ...(resolvers.length ? ["-p", `IPAddressAllow=${resolvers.join(" ")}`] : []),
        "-p", "MemoryMax=75%",
        "-p", "CPUWeight=20",
        "--", "/bin/bash", "-lc", command,
      ];
    } else {
      // Development machine: run directly in the workspace.
      cmd = process.platform === "win32" ? "cmd.exe" : "/bin/bash";
      args = process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-lc", command];
    }

    return new Promise<string>((resolve) => {
      const child = spawn(cmd, args, {
        cwd: this.sandboxed ? undefined : this.root,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      let output = "";
      let stopped: string | null = null;
      const add = (d: Buffer) => {
        output += d.toString("utf8");
        if (output.length > 400_000) output = output.slice(-200_000);
      };
      child.stdout.on("data", add);
      child.stderr.on("data", add);
      const stop = (why: string) => {
        if (stopped) return;
        stopped = why;
        if (unit) execFile("systemctl", ["kill", "--signal=SIGKILL", unit], () => undefined);
        child.kill("SIGKILL");
      };
      const timer = setTimeout(() => stop(`timed out after ${timeout}s`), (timeout + 5) * 1000);
      const onAbort = () => stop("stopped by the user");
      signal.addEventListener("abort", onAbort, { once: true });
      child.on("error", (err) => {
        output += `\n${err.message}`;
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        const status = stopped ? `Command ${stopped}.` : `Exit code: ${code ?? "unknown"}`;
        resolve(`${truncate(output.trimEnd()) || "(no output)"}\n\n${status}`);
      });
    });
  }
}
