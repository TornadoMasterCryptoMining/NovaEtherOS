import { useState } from "react";
import { api } from "../api";
import { usePoll } from "../usePoll";

export function AppStore() {
  const { data: apps, error, refresh } = usePoll(api.apps, 10000);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("All");

  async function toggle(id: string, name: string, installed: boolean) {
    if (installed && !confirm(`Uninstall ${name}? Its data stays on disk, so reinstalling picks up where you left off.`)) return;
    setBusy(id);
    setActionError(null);
    try {
      await (installed ? api.uninstall(id) : api.install(id));
      refresh();
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

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
          <div key={a.id} className="store-card">
            <div className="app-icon">{a.icon}</div>
            <div className="store-info">
              <div className="store-title">
                <strong>{a.name}</strong>
                {a.installed && <span className="pill ok">Installed</span>}
              </div>
              <span className="faint small">{a.category} · port {a.port}</span>
              <p className="small">{a.tagline}</p>
            </div>
            <div className="store-actions">
              {a.installed && (
                <a className="btn" href={`http://${location.hostname}:${a.port}${a.path ?? ""}`} target="_blank" rel="noreferrer">Open</a>
              )}
              <button
                className={a.installed ? "btn ghost" : "btn"}
                disabled={busy === a.id}
                onClick={() => toggle(a.id, a.name, a.installed)}
              >
                {busy === a.id ? (a.installed ? "Removing…" : "Installing…") : a.installed ? "Uninstall" : "Install"}
              </button>
            </div>
          </div>
        ))}
      </div>
      <p className="small faint center store-note">
        Apps run in Docker. The first install downloads the app, which can take a few minutes.
      </p>
    </div>
  );
}
