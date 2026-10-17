import { useState } from "react";
import { api, formatBytes, type AISettings, type AIStatus } from "../api";

export function ModelsView({ status, refresh }: { status: AIStatus; refresh: () => void }) {
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
      <section className="panel">
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

      <section className="panel">
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
        <section className="panel wide">
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
        <section className="panel wide">
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
        <section className="panel wide">
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
