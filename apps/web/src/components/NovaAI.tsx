import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  api,
  formatBytes,
  type AIChat,
  type AIMessage,
  type AISettings,
  type AIStatus,
  type WorkspaceListing,
} from "../api";
import { usePoll } from "../usePoll";
import { ApiPanel } from "./ApiPanel";
import { Icon } from "./Icons";

type Tab = "chat" | "models" | "api" | "files";

const remember = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string | null) => {
    try {
      if (v == null) localStorage.removeItem(k);
      else localStorage.setItem(k, v);
    } catch {
      // storage blocked
    }
  },
};

export function NovaAI() {
  const [tab, setTab] = useState<Tab>("chat");
  const { data: status, error, refresh } = usePoll(api.ai, 4000);
  const ready = Boolean(status?.engine.reachable && status.models.length);

  return (
    <div className="ai-page">
      <header className="hero">
        <h1>Nova AI</h1>
        <p className="muted">
          {!status
            ? (error ?? "Loading…")
            : status.engine.reachable
              ? `Your own coding agent · Ollama ${status.engine.version} on ${status.engine.local ? "this machine" : status.engine.url}`
              : "Your own coding agent, running on your own hardware"}
        </p>
      </header>

      <div className="segmented ai-tabs">
        <button className={tab === "chat" ? "on" : ""} onClick={() => setTab("chat")}>Agent</button>
        <button className={tab === "models" ? "on" : ""} onClick={() => setTab("models")}>Models{status && !ready ? " ·" : ""}</button>
        <button className={tab === "files" ? "on" : ""} onClick={() => setTab("files")}>Workspace</button>
        <button className={tab === "api" ? "on" : ""} onClick={() => setTab("api")}>API</button>
      </div>

      {tab === "chat" && status && (ready ? <ChatView status={status} /> : <SetupHint status={status} onOpen={() => setTab("models")} />)}
      {tab === "models" && status && <ModelsView status={status} refresh={refresh} />}
      {tab === "api" && status && <ApiPanel status={status} />}
      {tab === "files" && <FilesView />}
    </div>
  );
}

function SetupHint({ status, onOpen }: { status: AIStatus; onOpen: () => void }) {
  const e = status.engine;
  return (
    <section className="panel glass ai-setup">
      <h2>{!e.reachable ? "Set up the AI engine" : "Download a model"}</h2>
      <p className="muted">
        {!e.reachable
          ? e.local && !e.installed
            ? "Nova AI runs on Ollama, installed natively on NovaEtherOS (no Docker). Install it once, then download a coding model."
            : `The AI engine at ${e.url} isn't answering.`
          : "The engine is running. Pick a coding model to download. The Models tab shows which ones fit this machine."}
      </p>
      <button className="btn" onClick={onOpen}>Open Models</button>
    </section>
  );
}

// ---------------------------------------------------------------- chat

function ChatView({ status }: { status: AIStatus }) {
  const { data: chats, refresh: refreshChats } = usePoll(api.aiChats, 4000);
  const [activeId, setActiveId] = useState<string | null>(() => remember.get("nova-ai-chat"));
  const [chat, setChat] = useState<AIChat | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const select = (id: string | null) => {
    setActiveId(id);
    remember.set("nova-ai-chat", id);
    if (!id) setChat(null);
  };

  // Poll the open chat: fast while Nova is working, slow otherwise.
  const running = Boolean(chat?.running);
  useEffect(() => {
    if (!activeId) return;
    let alive = true;
    const load = () =>
      api
        .aiChat(activeId)
        .then((c) => alive && setChat(c))
        .catch(() => {
          if (alive) select(null);
        });
    load();
    const t = setInterval(load, running ? 700 : 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [activeId, running]);

  async function newChat() {
    select(null);
  }

  async function remove(id: string) {
    if (!confirm("Delete this chat? Files Nova made stay in the workspace.")) return;
    await api.aiDeleteChat(id);
    if (id === activeId) select(null);
    refreshChats();
  }

  async function send(text: string, model: string, mode: string) {
    setErr(null);
    try {
      let id = activeId;
      if (!id) {
        const created = await api.aiNewChat(model, mode);
        id = created.id;
        select(id);
      }
      setChat(await api.aiSend(id, text, model, mode));
      refreshChats();
      return true;
    } catch (e) {
      setErr((e as Error).message);
      return false;
    }
  }

  return (
    <div className="ai-chat-layout">
      <aside className="ai-sidebar glass">
        <button className="btn" onClick={newChat}>+ New chat</button>
        <ul className="chat-list">
          {chats?.map((c) => (
            <li key={c.id} className={c.id === activeId ? "on" : ""}>
              <button className="chat-item" onClick={() => select(c.id)} title={c.title}>
                {c.running && <span className="dot on" />}
                <span className="chat-title">{c.title}</span>
                <span className="small muted">{c.mode === "agent" ? "agent" : "chat"} · {c.model.split(":")[0]}</span>
              </button>
              <button className="chat-del" onClick={() => remove(c.id)} title="Delete chat">✕</button>
            </li>
          ))}
        </ul>
      </aside>

      <section className="ai-main glass">
        <Messages chat={activeId ? chat : null} workspace={status.workspace} />
        {chat?.pending && activeId && <Approval chat={chat} onDone={() => api.aiChat(activeId).then(setChat)} />}
        {err && <p className="error small">{err}</p>}
        <Composer
          status={status}
          chat={activeId ? chat : null}
          onSend={send}
          onStop={() => activeId && api.aiStop(activeId)}
        />
      </section>
    </div>
  );
}

const EXAMPLES = [
  "Build a small Python script that prints my Bitcoin node's sync progress every minute",
  "Create a React + Vite app with a todo list and run its build to check it works",
  "Clone https://github.com/TornadoMasterCryptoMining/NovaEtherOS and explain how the solo pool works",
  "Check my miners and tell me which one is running hottest",
];

function Messages({ chat, workspace }: { chat: AIChat | null; workspace: string }) {
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const liveLen = (chat?.live?.content.length ?? 0) + (chat?.live?.thinking.length ?? 0);

  useEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [chat?.id, chat?.messages.length, liveLen, chat?.pending]);

  if (!chat || !chat.messages.length) {
    return (
      <div className="messages empty" ref={box}>
        <div className="ai-welcome">
          <span className="ai-logo"><Icon name="sparkles" size={26} /></span>
          <h2>What should Nova build?</h2>
          <p className="muted small">
            In <b>Agent</b> mode Nova reads and writes files in its workspace (<code>{workspace}</code>), runs commands and
            tests, and fixes its own mistakes. You approve every command first.
          </p>
          <ul className="examples">{EXAMPLES.map((e) => <li key={e} className="small">{e}</li>)}</ul>
        </div>
      </div>
    );
  }

  return (
    <div
      className="messages"
      ref={box}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
    >
      {chat.messages.map((m, i) => <MessageView key={i} m={m} />)}
      {chat.running && (
        <>
          {chat.live && (chat.live.content || chat.live.thinking) && (
            <MessageView m={{ role: "assistant", content: chat.live.content, thinking: chat.live.thinking, at: 0 }} live />
          )}
          <p className="ai-status small"><span className="spinner" /> {chat.status}</p>
        </>
      )}
    </div>
  );
}

// Thinking models put their reasoning in `thinking`, or inline in <think> tags.
function splitThinking(content: string, thinking?: string) {
  let think = thinking ?? "";
  let text = content;
  const open = text.indexOf("<think>");
  if (open >= 0) {
    const close = text.indexOf("</think>", open);
    think += text.slice(open + 7, close >= 0 ? close : undefined);
    text = text.slice(0, open) + (close >= 0 ? text.slice(close + 8) : "");
  }
  return { think: think.trim(), text: text.trim() };
}

function MessageView({ m, live }: { m: AIMessage; live?: boolean }) {
  if (m.role === "user") {
    return <div className="msg user"><div className="bubble">{m.content}</div></div>;
  }
  if (m.role === "tool") return <ToolCard m={m} />;

  const { think, text } = splitThinking(m.content, m.thinking);
  if (!text && !think) return null;
  return (
    <div className={`msg assistant ${m.note ? "note" : ""} ${m.error ? "err" : ""}`}>
      {think && (
        <details className="thinking">
          <summary>
            {live && !text ? "Thinking…" : "Thought process"}
            <span className="faint"> · {think.split(/s+/).length.toLocaleString()} words</span>
          </summary>
          <div className="think-text">{think}</div>
        </details>
      )}
      {text && <Markdown text={text} />}
      {live && <span className="caret" />}
      {m.stats && m.stats.tokens > 0 && m.stats.seconds > 0 && (
        <div className="small muted msg-stats">{m.stats.tokens} tokens · {(m.stats.tokens / m.stats.seconds).toFixed(1)} tokens/s</div>
      )}
    </div>
  );
}

const TOOL_LABELS: Record<string, [string, string]> = {
  list_files: ["📂", "Listed files"],
  read_file: ["📄", "Read"],
  write_file: ["✍️", "Wrote"],
  edit_file: ["✏️", "Edited"],
  search: ["🔎", "Searched"],
  run_command: ["⌨️", "Ran"],
  nova_status: ["🛰️", "Checked NovaEtherOS"],
};

function toolSummary(name: string, args: Record<string, unknown> = {}) {
  if (name === "run_command") return String(args.command ?? "");
  if (name === "search") return String(args.pattern ?? "");
  if (name === "nova_status") return "";
  return String(args.path ?? ".");
}

function ToolCard({ m }: { m: AIMessage }) {
  const name = m.tool_name ?? "tool";
  const [icon, label] = TOOL_LABELS[name] ?? ["🛠️", name];
  const args = m.args ?? {};
  const failed = /^Error:|declined|Exit code: [1-9]|timed out/.test(m.content);
  return (
    <details className={`tool-card ${failed ? "failed" : ""}`}>
      <summary>
        <span>{icon}</span> <b>{label}</b> <code className="tool-arg">{toolSummary(name, args)}</code>
      </summary>
      {name === "write_file" && typeof args.content === "string" && <CodeBlock lang={String(args.path ?? "")} code={args.content} />}
      {name === "edit_file" && (
        <div className="diff">
          <pre className="del">{String(args.old_text ?? "")}</pre>
          <pre className="add">{String(args.new_text ?? "")}</pre>
        </div>
      )}
      <pre className="logs">{m.content}</pre>
    </details>
  );
}

function Approval({ chat, onDone }: { chat: AIChat; onDone: () => void }) {
  const p = chat.pending!;
  const [busy, setBusy] = useState(false);
  const answer = async (ok: boolean) => {
    setBusy(true);
    try {
      await api.aiApprove(chat.id, ok);
    } finally {
      setBusy(false);
      onDone();
    }
  };
  return (
    <div className="approval">
      <div className="small"><b>Nova wants to run a command</b> in its workspace (as the unprivileged <code>nova-agent</code> user):</div>
      <pre className="cmd">{String(p.args.command ?? JSON.stringify(p.args))}</pre>
      <div className="actions">
        <button className="btn" disabled={busy} onClick={() => answer(true)}>Run it</button>
        <button className="btn ghost" disabled={busy} onClick={() => answer(false)}>Don't run</button>
      </div>
    </div>
  );
}

function Composer({
  status,
  chat,
  onSend,
  onStop,
}: {
  status: AIStatus;
  chat: AIChat | null;
  onSend: (text: string, model: string, mode: string) => Promise<boolean>;
  onStop: () => void;
}) {
  const models = status.models.map((m) => m.name);
  const fallback = status.settings.default_model && models.includes(status.settings.default_model) ? status.settings.default_model : models[0];
  const [model, setModel] = useState(chat?.model && models.includes(chat.model) ? chat.model : fallback);
  const [mode, setMode] = useState<"agent" | "chat">(chat?.mode ?? "agent");
  const [text, setText] = useState(() => remember.get("nova-ai-draft") ?? "");
  const [sending, setSending] = useState(false);

  // Adopt the chat's model/mode once it has loaded.
  const loadedFor = useRef<string | null>(null);
  useEffect(() => {
    if (chat && loadedFor.current !== chat.id) {
      loadedFor.current = chat.id;
      if (chat.model && models.includes(chat.model)) setModel(chat.model);
      setMode(chat.mode);
    }
  }, [chat, models]);

  const update = (v: string) => {
    setText(v);
    remember.set("nova-ai-draft", v || null);
  };

  async function send() {
    if (!text.trim() || !model || sending) return;
    setSending(true);
    if (await onSend(text, model, mode)) update("");
    setSending(false);
  }

  return (
    <div className="composer">
      <textarea
        rows={3}
        value={text}
        placeholder={mode === "agent" ? "Ask Nova to build, fix or explain something…" : "Ask anything…"}
        onChange={(e) => update(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void send();
          }
        }}
      />
      <div className="composer-bar">
        <select value={model} onChange={(e) => setModel(e.target.value)} title="Model">
          {models.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <div className="segmented mini">
          <button className={mode === "agent" ? "on" : ""} onClick={() => setMode("agent")} title="Nova uses tools: files and commands">Agent</button>
          <button className={mode === "chat" ? "on" : ""} onClick={() => setMode("chat")} title="Just talk, no tools">Chat</button>
        </div>
        <span className="small muted grow">Enter to send · Shift+Enter for a new line</span>
        {chat?.running ? (
          <button className="btn danger" onClick={onStop}>Stop</button>
        ) : (
          <button className="btn" disabled={!text.trim() || !model || sending} onClick={send}>Send</button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- markdown

export function copyText(text: string) {
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
  // The dashboard is plain http on the LAN, where the clipboard API is off.
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  document.execCommand("copy");
  ta.remove();
  return Promise.resolve();
}

export function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="code-block">
      <div className="code-head">
        <span>{lang || "code"}</span>
        <button className="link" onClick={() => copyText(code).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre><code>{code}</code></pre>
    </div>
  );
}

function inline(text: string): ReactNode[] {
  return text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g).map((part, i) => {
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) return <code key={i}>{part.slice(1, -1)}</code>;
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) return <strong key={i}>{part.slice(2, -2)}</strong>;
    return part;
  });
}

function Markdown({ text }: { text: string }) {
  // Odd parts are inside ``` fences (an unclosed fence while streaming counts as code).
  const parts = text.split("```");
  return (
    <>
      {parts.map((part, i) => {
        if (i % 2 === 1) {
          const nl = part.indexOf("\n");
          const lang = nl >= 0 ? part.slice(0, nl).trim() : "";
          const code = nl >= 0 ? part.slice(nl + 1) : part;
          return <CodeBlock key={i} lang={lang} code={code.replace(/\n$/, "")} />;
        }
        const body = part.replace(/^\n+|\n+$/g, "");
        if (!body) return null;
        return (
          <div key={i} className="md-text">
            {body.split("\n").map((line, j) => (
              <Fragment key={j}>
                {j > 0 && "\n"}
                {/^#{1,6}\s/.test(line) ? <strong className="md-h">{inline(line.replace(/^#+\s/, ""))}</strong> : inline(line)}
              </Fragment>
            ))}
          </div>
        );
      })}
    </>
  );
}

// ---------------------------------------------------------------- models

function ModelsView({ status, refresh }: { status: AIStatus; refresh: () => void }) {
  const e = status.engine;
  const [msg, setMsg] = useState<string | null>(null);
  const [custom, setCustom] = useState("");
  const [url, setUrl] = useState(status.settings.ollama_url ?? "");

  const act = async (fn: () => Promise<unknown>) => {
    setMsg(null);
    try {
      await fn();
    } catch (err) {
      setMsg((err as Error).message);
    }
    refresh();
  };

  const pulls = Object.entries(status.pulls);
  const ramGB = status.hardware.ram / 1e9;

  return (
    <div className="panels">
      <section className="panel glass">
        <h2>AI engine</h2>
        <p>
          <span className={`pill ${e.reachable ? "ok" : status.install_job.running ? "busy" : "bad"}`}>
            {e.reachable ? `Running · Ollama ${e.version}` : status.install_job.running ? "Installing…" : e.local && !e.installed ? "Not installed" : "Not reachable"}
          </span>
        </p>
        <p className="small muted">
          {e.local
            ? "Ollama runs natively on this machine as a systemd service, only reachable from NovaEtherOS itself."
            : `Using the Ollama engine on ${e.url}.`}
        </p>
        {e.local && !e.installed && !status.install_job.running && (
          e.can_install
            ? <button className="btn" onClick={() => act(api.aiInstall)}>Install AI engine</button>
            : <p className="small muted">Install it on the NovaEtherOS machine with <code>sudo nova ai-install</code>.</p>
        )}
        {(status.install_job.running || (status.install_job.log && !e.reachable)) && (
          <pre className="logs">{status.install_job.log || "Starting…"}</pre>
        )}
        {e.local && e.installed && !e.reachable && !status.install_job.running && (
          <p className="small muted">Ollama is installed but not answering. On the machine: <code>sudo systemctl restart ollama</code></p>
        )}

        <details>
          <summary>Use a more powerful computer</summary>
          <p className="small muted">
            Big coding models need a lot of memory. If you have a PC with a graphics card, install Ollama on it, set
            <code>OLLAMA_HOST=0.0.0.0</code> there so it listens on your network, and enter its address here. Nova runs its
            tools on NovaEtherOS either way.
          </p>
          <div className="add-ip">
            <input placeholder="http://192.168.0.112:11434" value={url} onChange={(ev) => setUrl(ev.target.value)} />
            <button className="btn" onClick={() => act(() => api.aiSettings({ ollama_url: url }))}>Save</button>
          </div>
          {!e.local && (
            <button className="link" onClick={() => { setUrl(""); void act(() => api.aiSettings({ ollama_url: null })); }}>
              Use this machine's engine again
            </button>
          )}
        </details>
        {msg && <p className="error small">{msg}</p>}
      </section>

      <section className="panel glass">
        <h2>Agent settings</h2>
        <label className="field">
          Context window (how much of the conversation and files Nova can keep in mind)
          <select
            value={status.settings.num_ctx}
            onChange={(ev) => act(() => api.aiSettings({ num_ctx: Number(ev.target.value) }))}
          >
            {[4096, 8192, 16384, 32768, 65536].map((n) => (
              <option key={n} value={n}>{n.toLocaleString()} tokens{n === 8192 ? " (default)" : n >= 32768 ? " (needs lots of RAM)" : ""}</option>
            ))}
          </select>
        </label>
        <label className="field">
          Thinking (models that reason before answering)
          <select value={status.settings.thinking} onChange={(ev) => act(() => api.aiSettings({ thinking: ev.target.value as AISettings["thinking"] }))}>
            <option value="auto">Automatic: only models of 4B+ think (small ones overthink)</option>
            <option value="on">On: always think first (slower, sometimes smarter)</option>
            <option value="off">Off: answer straight away (fastest)</option>
          </select>
        </label>
        <label className="check warn">
          <input
            type="checkbox"
            checked={status.settings.auto_approve}
            onChange={(ev) => act(() => api.aiSettings({ auto_approve: ev.target.checked }))}
          />
          <span>Run commands without asking. Commands stay sandboxed to the workspace, but Nova can download and run anything from the internet.</span>
        </label>
        <Instructions initial={status.settings.instructions} onSave={(v) => act(() => api.aiSettings({ instructions: v }))} />
        <p className="small muted">
          Workspace: <code>{status.workspace}</code>
          {status.sandboxed ? " · commands run as nova-agent with no access to this machine's own services or data." : ""}
        </p>
      </section>

      {status.models.length > 0 && (
        <section className="panel glass wide">
          <h2>Your models</h2>
          <div className="model-list">
            {status.models.map((m) => (
              <div key={m.name} className="model-row">
                <div className="grow">
                  <b className="mono">{m.name}</b>{" "}
                  {status.settings.default_model === m.name && <span className="pill ok">Default</span>}{" "}
                  {m.loaded && <span className="pill busy">In memory</span>}
                  <div className="small muted">{formatBytes(m.size)} · {[m.parameter_size, m.quantization].filter(Boolean).join(" · ")}</div>
                </div>
                {status.settings.default_model !== m.name && (
                  <button className="btn ghost" onClick={() => act(() => api.aiSettings({ default_model: m.name }))}>Make default</button>
                )}
                <button
                  className="btn ghost"
                  onClick={() => confirm(`Delete ${m.name}? You can download it again later.`) && act(() => api.aiRemoveModel(m.name))}
                >
                  Delete
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      {pulls.length > 0 && (
        <section className="panel glass wide">
          <h2>Downloads</h2>
          {pulls.map(([name, p]) => (
            <div key={name} className="model-row">
              <div className="grow">
                <b className="mono">{name}</b>
                <div className={`small ${p.error ? "error left" : "muted"}`}>
                  {p.error ?? `${p.status}${p.total ? ` · ${formatBytes(p.completed)} of ${formatBytes(p.total)}` : ""}`}
                </div>
                {!p.error && <div className="bar"><div style={{ width: `${p.total ? (p.completed / p.total) * 100 : 2}%` }} /></div>}
              </div>
              <button className="btn ghost" onClick={() => act(() => api.aiCancelPull(name))}>{p.error ? "Dismiss" : "Cancel"}</button>
            </div>
          ))}
        </section>
      )}

      {e.reachable && (
        <section className="panel glass wide">
          <h2>Get a coding model</h2>
          <p className="small muted">
            {e.local
              ? `This machine has ${ramGB.toFixed(0)} GB of RAM, shared with the Bitcoin node. Models marked "fits" will run; bigger ones need a more powerful computer (see AI engine).`
              : "Models download onto the remote engine."}
          </p>
          <div className="catalog">
            {status.catalog.map((c) => (
              <div key={c.name} className={`catalog-card ${c.fits === false ? "dim" : ""}`}>
                <div className="catalog-head">
                  <b>{c.label}</b>
                  {c.fits === true && <span className="pill ok">Fits</span>}
                  {c.fits === false && <span className="pill bad">Too big here</span>}
                </div>
                <span className="small muted mono">{c.name} · {(c.size / 1e9).toFixed(1)} GB</span>
                <span className="small">{c.note}</span>
                <button
                  className="btn ghost"
                  disabled={c.installed || c.name in status.pulls}
                  onClick={() => {
                    if (c.fits === false && !confirm(`${c.label} probably won't fit in this machine's memory. Download anyway?`)) return;
                    void act(() => api.aiPull(c.name));
                  }}
                >
                  {c.installed ? "Installed" : c.name in status.pulls ? "Downloading…" : "Download"}
                </button>
              </div>
            ))}
          </div>
          <div className="add-ip">
            <input placeholder="Any model from ollama.com/library, e.g. llama3.2:3b" value={custom} onChange={(ev) => setCustom(ev.target.value)} />
            <button className="btn" disabled={!custom.trim()} onClick={() => act(() => api.aiPull(custom)).then(() => setCustom(""))}>Download</button>
          </div>
        </section>
      )}
    </div>
  );
}

function Instructions({ initial, onSave }: { initial: string; onSave: (v: string) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <label className="field">
      Standing instructions for Nova (optional)
      <textarea rows={3} value={value} placeholder="e.g. Prefer TypeScript. Keep explanations short." onChange={(e) => setValue(e.target.value)} />
      {value !== initial && <button className="btn ghost" onClick={() => onSave(value)}>Save instructions</button>}
    </label>
  );
}

// ---------------------------------------------------------------- files

function FilesView() {
  const [dir, setDir] = useState(".");
  const [listing, setListing] = useState<WorkspaceListing | null>(null);
  const [file, setFile] = useState<{ path: string; content: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(() => {
    api.aiWorkspace(dir).then((l) => { setListing(l); setErr(null); }).catch((e) => setErr((e as Error).message));
  }, [dir]);
  useEffect(load, [load]);

  const join = (name: string) => (dir === "." ? name : `${dir}/${name}`);
  const crumbs = dir === "." ? [] : dir.split("/");

  async function open(name: string) {
    const p = join(name);
    try {
      setFile({ path: p, content: (await api.aiWorkspaceFile(p)).content });
    } catch (e) {
      setFile({ path: p, content: (e as Error).message });
    }
  }

  return (
    <div className="panels">
      <section className="panel glass">
        <div className="files-head">
          <div className="crumbs">
            <button className="link" onClick={() => { setDir("."); setFile(null); }}>workspace</button>
            {crumbs.map((c, i) => (
              <Fragment key={i}>
                {" / "}
                <button className="link" onClick={() => { setDir(crumbs.slice(0, i + 1).join("/")); setFile(null); }}>{c}</button>
              </Fragment>
            ))}
          </div>
          <button className="link" onClick={load}>Refresh</button>
        </div>
        {err && <p className="error small">{err}</p>}
        {listing && listing.entries.length === 0 && <p className="muted small">Empty. Ask Nova to build something and its files show up here.</p>}
        <ul className="file-list">
          {listing?.entries.map((e) => (
            <li key={e.name}>
              <button
                className={`file-item ${file?.path === join(e.name) ? "on" : ""}`}
                onClick={() => (e.dir ? (setDir(join(e.name)), setFile(null)) : open(e.name))}
              >
                <span>{e.dir ? "📁" : "📄"}</span>
                <span className="grow mono small">{e.name}</span>
                {!e.dir && <span className="small muted">{formatBytes(e.size)}</span>}
              </button>
            </li>
          ))}
        </ul>
      </section>
      {file && (
        <section className="panel glass">
          <div className="files-head">
            <b className="mono small">{file.path}</b>
            <button className="link" onClick={() => setFile(null)}>Close</button>
          </div>
          <CodeBlock lang={file.path.split(".").pop() ?? ""} code={file.content} />
        </section>
      )}
    </div>
  );
}
