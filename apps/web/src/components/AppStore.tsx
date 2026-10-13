import { useCallback, useState } from "react";
import { api, type AppLogin, type StoreApp } from "../api";
import { usePoll } from "../usePoll";
import { copyText } from "./NovaAI";

export function AppStore() {
  const { data: apps, error, refresh } = usePoll(api.apps, 10000);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("All");
  const [open, setOpen] = useState<{ id: string; panel: "login" | "logs" } | null>(null);

  async function toggle(app: StoreApp) {
    if (app.installed && !confirm(`Uninstall ${app.name}? Its data stays on disk, so reinstalling picks up where you left off.`)) return;
    setBusy(app.id);
    setActionError(null);
    try {
      await (app.installed ? api.uninstall(app.id) : api.install(app.id));
      // Show how to log in right after installing.
      setOpen(app.installed ? null : { id: app.id, panel: "login" });
      refresh();
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const show = (id: string, panel: "login" | "logs") =>
    setOpen(open?.id === id && open.panel === panel ? null : { id, panel });

  const categories = ["All", "Installed", ...new Set((apps ?? []).map((a) => a.category).sort())];
  const q = query.trim().toLowerCase();
  const shown = (apps ?? []).filter(
    (a) =>
      (category === "All" || (category === "Installed" ? a.installed : a.category === category)) &&
      (!q || `${a.name} ${a.tagline} ${a.category}`.toLowerCase().includes(q)),
  );

  return (
    <div className="store">
      <header className="hero">
        <h1>Apps</h1>
        <p className="muted">
          {apps ? `${apps.length} self-hosted apps · ${apps.filter((a) => a.installed).length} installed` : "One-click self-hosted apps"}
        </p>
      </header>

      <div className="store-bar">
        <input type="search" placeholder="Search apps" value={query} onChange={(e) => setQuery(e.target.value)} />
        <div className="store-cats">
          {categories.map((c) => (
            <button key={c} className={`cat ${category === c ? "on" : ""}`} onClick={() => setCategory(c)}>{c}</button>
          ))}
        </div>
      </div>

      {(error || actionError) && <p className="error">{actionError ?? error}</p>}
      {apps && shown.length === 0 && <p className="muted center">No apps match.</p>}

      <div className="store-grid">
        {shown.map((a) => (
          <div key={a.id} className={`store-card ${open?.id === a.id ? "expanded" : ""}`}>
            <div className="store-row">
              <div className="app-icon">{a.icon}</div>
              <div className="store-info">
                <div className="store-title">
                  <strong>{a.name}</strong>
                  {a.installed && <span className="pill ok">Installed</span>}
                </div>
                <span className="faint small">{a.category} · port {a.port}</span>
                <p className="small">{a.tagline}</p>
              </div>
            </div>
            <div className="store-actions">
              {a.installed && (
                <>
                  <a className="btn" href={`http://${location.hostname}:${a.port}${a.path ?? ""}`} target="_blank" rel="noreferrer">Open</a>
                  <button className={`btn ghost ${open?.id === a.id && open.panel === "login" ? "pressed" : ""}`} onClick={() => show(a.id, "login")}>Login</button>
                  <button className={`btn ghost ${open?.id === a.id && open.panel === "logs" ? "pressed" : ""}`} onClick={() => show(a.id, "logs")}>Logs</button>
                </>
              )}
              <button
                className={a.installed ? "btn ghost push-right" : "btn"}
                disabled={busy === a.id}
                onClick={() => toggle(a)}
              >
                {busy === a.id ? (a.installed ? "Removing…" : "Installing…") : a.installed ? "Uninstall" : "Install"}
              </button>
            </div>
            {a.installed && open?.id === a.id && open.panel === "login" && <LoginPanel app={a} />}
            {a.installed && open?.id === a.id && open.panel === "logs" && <LogsPanel app={a} />}
          </div>
        ))}
      </div>
      <p className="small faint center store-note">
        Apps run in Docker. The first install downloads the app, which can take a few minutes.
      </p>
    </div>
  );
}

function Secret({ label, value }: { label: string; value: string }) {
  const [reveal, setReveal] = useState(false);
  const [copied, setCopied] = useState(false);
  return (
    <div className="secret">
      <span className="faint small">{label}</span>
      <code>{reveal ? value : "•".repeat(Math.min(value.length, 16))}</code>
      <button className="link" onClick={() => setReveal((r) => !r)}>{reveal ? "Hide" : "Show"}</button>
      <button className="link" onClick={() => copyText(value).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })}>
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

function LoginPanel({ app }: { app: StoreApp }) {
  const fetchLogin = useCallback(() => api.appLogin(app.id), [app.id]);
  const { data, error, refresh } = usePoll(fetchLogin, 60_000);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function reset(first: boolean) {
    if (!first && !confirm(`Make a new password for ${app.name}? The old one stops working. ${app.name} restarts for a few seconds.`)) return;
    setBusy(true);
    setErr(null);
    try {
      await api.appLoginReset(app.id);
      refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const login: AppLogin | null = data;
  return (
    <div className="store-panel">
      {!login && <p className="small muted">{error ?? "Loading…"}</p>}
      {login && (
        <>
          {login.user && (
            <div className="secret">
              <span className="faint small">User</span>
              <code>{login.user}</code>
            </div>
          )}
          {login.secrets.map((s) => s.value && <Secret key={s.label} label={s.label} value={s.value} />)}
          {login.needs_reset ? (
            <>
              <p className="small">{app.name} was installed before NovaEtherOS managed its password. Set one now (it restarts for a few seconds):</p>
              <button className="btn" disabled={busy} onClick={() => reset(true)}>{busy ? "Setting…" : "Set a password"}</button>
            </>
          ) : (
            login.can_reset && (
              <button className="link" disabled={busy} onClick={() => reset(false)}>{busy ? "Making a new password…" : "Make a new password"}</button>
            )
          )}
          {login.hint && <p className="small muted">{login.hint}</p>}
          {err && <p className="error small left">{err}</p>}
        </>
      )}
    </div>
  );
}

function LogsPanel({ app }: { app: StoreApp }) {
  const fetchLogs = useCallback(() => api.appLogs(app.id), [app.id]);
  const { data, error, refresh } = usePoll(fetchLogs, 10_000);
  return (
    <div className="store-panel">
      <div className="files-head">
        <span className="small muted">Last 300 lines from {app.name}. Look here for first-start passwords and errors.</span>
        <button className="link" onClick={refresh}>Refresh</button>
      </div>
      <pre className="logs">{data?.logs ?? error ?? "Loading…"}</pre>
    </div>
  );
}
