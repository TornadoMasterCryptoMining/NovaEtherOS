import { useEffect, useRef, useState } from "react";
import { api, type AIChat, type AIMessage, type AIStatus } from "../api";
import { usePoll } from "../usePoll";
import { ModelsView } from "./AIModels";
import { FilesView } from "./AIWorkspace";
import { ApiPanel } from "./ApiPanel";
import { Icon, type IconName } from "./Icons";
import { CodeBlock, Markdown } from "./Markdown";
import { PageLoading } from "./ui";

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

  if (!status) return <PageLoading title="Nova AI" error={error} />;

  const tabs: [Tab, string][] = [["chat", "Agent"], ["models", "Models"], ["files", "Workspace"], ["api", "API"]];
  return (
    <div className="ai-page">
      <header className="hero">
        <h1>Nova AI</h1>
        <p className="muted">
          {status.engine.reachable
            ? `Local coding agent · Ollama ${status.engine.version} on ${status.engine.local ? "this machine" : status.engine.url}`
            : "Local coding agent and text API, running on your own hardware"}
        </p>
      </header>

      <div className="tabs" role="tablist" aria-label="Nova AI">
        {tabs.map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? "on" : ""} onClick={() => setTab(id)}>
            {label}
            {id === "models" && !ready && <span className="tab-dot" aria-label="needs setup" />}
          </button>
        ))}
      </div>

      {error && <p className="small error left">Lost contact with NovaEtherOS: {error}. Retrying.</p>}
      {tab === "chat" && (ready ? <ChatView status={status} /> : <SetupHint status={status} onOpen={() => setTab("models")} />)}
      {tab === "models" && <ModelsView status={status} refresh={refresh} />}
      {tab === "api" && <ApiPanel status={status} />}
      {tab === "files" && <FilesView />}
    </div>
  );
}

function SetupHint({ status, onOpen }: { status: AIStatus; onOpen: () => void }) {
  const e = status.engine;
  return (
    <section className="panel ai-setup">
      <h2>{!e.reachable ? "Set up the AI engine" : "Download a model"}</h2>
      <p className="small muted">
        {!e.reachable
          ? e.local && !e.installed
            ? "Nova AI runs on Ollama, installed natively on NovaEtherOS (no Docker). Install it once, then download a coding model."
            : `The AI engine at ${e.url} isn't answering.`
          : "The engine is running. Pick a coding model to download. The Models tab shows which ones fit this machine."}
      </p>
      <button className="btn" onClick={onOpen}>{!e.reachable ? "Set up the engine" : "Choose a model"}</button>
    </section>
  );
}

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
      <aside className="ai-sidebar">
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

      <section className="ai-main">
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

const TOOL_LABELS: Record<string, [IconName, string]> = {
  list_files: ["folder", "Listed files"],
  read_file: ["file", "Read"],
  write_file: ["pencil", "Wrote"],
  edit_file: ["pencil", "Edited"],
  search: ["search", "Searched"],
  run_command: ["terminal", "Ran"],
  nova_status: ["activity", "Checked NovaEtherOS"],
};

function toolSummary(name: string, args: Record<string, unknown> = {}) {
  if (name === "run_command") return String(args.command ?? "");
  if (name === "search") return String(args.pattern ?? "");
  if (name === "nova_status") return "";
  return String(args.path ?? ".");
}

function ToolCard({ m }: { m: AIMessage }) {
  const name = m.tool_name ?? "tool";
  const [icon, label] = TOOL_LABELS[name] ?? ["wrench", name];
  const args = m.args ?? {};
  const failed = /^Error:|declined|Exit code: [1-9]|timed out/.test(m.content);
  return (
    <details className={`tool-card ${failed ? "failed" : ""}`}>
      <summary>
        <Icon name={icon} size={16} /> <b>{label}</b> <code className="tool-arg">{toolSummary(name, args)}</code>
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

