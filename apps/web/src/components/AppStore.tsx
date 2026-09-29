import { useState } from "react";
import { api } from "../api";
import { usePoll } from "../usePoll";

export function AppStore() {
  const { data: apps, error, refresh } = usePoll(api.apps, 10000);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  async function toggle(id: string, installed: boolean) {
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

  return (
    <div className="store">
      <header className="hero">
        <h1>App Store</h1>
        <p className="muted">One-click self-hosted apps, running in Docker.</p>
      </header>
      {(error || actionError) && <p className="error">{actionError ?? error}</p>}
      <div className="store-grid">
        {apps?.map((a) => (
          <div key={a.id} className="store-card glass">
            <div className="app-icon">{a.icon}</div>
            <div className="store-info">
              <strong>{a.name}</strong>
              <span className="muted small">{a.category}</span>
              <p className="small">{a.tagline}</p>
            </div>
            <button
              className={a.installed ? "btn ghost" : "btn"}
              disabled={busy === a.id}
              onClick={() => toggle(a.id, a.installed)}
            >
              {busy === a.id ? "Working…" : a.installed ? "Uninstall" : "Install"}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
