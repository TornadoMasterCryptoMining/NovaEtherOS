import { useEffect, useRef, useState } from "react";
import { api, type UpdateStatus } from "../api";
import { usePoll } from "../usePoll";

const fmtDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" });

export function System() {
  return (
    <div className="system">
      <header className="hero">
        <h1>Settings</h1>
        <p className="muted">NovaEtherOS system settings</p>
      </header>
      <div className="panels">
        <SoftwareUpdate />
      </div>
    </div>
  );
}

function SoftwareUpdate() {
  const { data: u, error, refresh } = usePoll(api.update, 4000);
  const [checking, setChecking] = useState(false);
  const [starting, setStarting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  // The version we were on when the update was started, to spot when it's done.
  const fromSha = useRef<string | null>(null);
  const [finished, setFinished] = useState<string | null>(null);

  useEffect(() => {
    if (!u || !fromSha.current || u.running) return;
    if (u.current && u.current.sha !== fromSha.current) {
      fromSha.current = null;
      setFinished(u.current.sha);
      // Load the new dashboard code.
      setTimeout(() => location.reload(), 2500);
    }
  }, [u]);

  async function check() {
    setChecking(true);
    setActionError(null);
    try {
      await api.updateCheck();
      refresh();
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setChecking(false);
    }
  }

  async function start(status: UpdateStatus) {
    setStarting(true);
    setActionError(null);
    try {
      fromSha.current = status.current?.sha ?? null;
      await api.updateStart();
      refresh();
    } catch (e) {
      fromSha.current = null;
      setActionError((e as Error).message);
    } finally {
      setStarting(false);
    }
  }

  // While updating, NovaEtherOS restarts and the API briefly disappears.
  const restarting = Boolean(fromSha.current) && Boolean(error);
  const updating = Boolean(u?.running) || restarting;

  return (
    <section className="panel glass wide">
      <h2>Software update</h2>
      {!u && !error && <p className="muted small">Loading…</p>}
      {u && (
        <>
          <dl className="facts">
            <dt>Installed</dt>
            <dd>{u.current ? `${u.current.sha} · ${fmtDate(u.current.date)} · ${u.current.message}` : "Unknown"}</dd>
            <dt>Latest</dt>
            <dd>{u.latest ? `${u.latest.sha} · ${fmtDate(u.latest.date)}` : "Not checked yet"}</dd>
            <dt>Last checked</dt>
            <dd>{u.last_check ? new Date(u.last_check).toLocaleString() : "Never"}</dd>
          </dl>

          {finished ? (
            <p className="big ok-text">Updated to {finished}. Reloading…</p>
          ) : updating ? (
            <p className="big">{restarting ? "Restarting NovaEtherOS…" : "Updating…"}</p>
          ) : u.available ? (
            <p className="big">Update available</p>
          ) : u.latest ? (
            <p className="big ok-text">You're up to date</p>
          ) : null}

          {u.available && !updating && !finished && u.changes.length > 0 && (
            <>
              <p className="small muted">What's new:</p>
              <ul className="changes">
                {u.changes.map((c) => (
                  <li key={c.sha}>
                    <span className="muted small">{fmtDate(c.date)}</span> {c.message}
                  </li>
                ))}
              </ul>
            </>
          )}

          {u.check_error && <p className="error small">Couldn't check for updates: {u.check_error}</p>}
          {u.unsupported && u.available && <p className="small muted">{u.unsupported}</p>}
          {actionError && <p className="error small">{actionError}</p>}

          <div className="actions">
            <button className="btn ghost" disabled={checking || updating} onClick={check}>
              {checking ? "Checking…" : "Check for updates"}
            </button>
            {u.available && !finished && (
              <button className="btn" disabled={updating || starting || Boolean(u.unsupported)} onClick={() => start(u)}>
                {updating ? "Updating…" : "Update now"}
              </button>
            )}
          </div>

          {(updating || u.log) && u.log && <pre className="logs">{u.log}</pre>}
          <p className="small muted">
            Updating restarts the dashboard for about a minute. Your Bitcoin node keeps running. You can also update from
            the terminal with <code>sudo nova update</code>.
          </p>
        </>
      )}
      {error && !restarting && <p className="error small">{error}</p>}
    </section>
  );
}
