import { useState } from "react";
import { api, formatBytes, type Drive } from "../api";
import { usePoll } from "../usePoll";

function driveIcon(d: Drive) {
  if (d.empty) return "🗂️";
  if (d.transport === "usb") return "🔌";
  return d.system ? "💻" : "💽";
}

function connection(d: Drive) {
  if (d.empty) return "Empty slot";
  if (d.transport === "usb") return "USB";
  if (d.transport === "nvme") return "Internal NVMe";
  if (d.transport === "sata") return "Internal SATA";
  return d.transport ?? "Drive";
}

export function StoragePanel() {
  const { data: s, error, refresh } = usePoll(api.storage, 4000);
  const [selected, setSelected] = useState<string | null>(null);
  const [startedFor, setStartedFor] = useState<string | null>(null);

  // While a move runs NovaEtherOS restarts, so the API briefly disappears.
  const busy = Boolean(s?.job.running) || (Boolean(startedFor) && Boolean(error));

  return (
    <section className="panel glass wide">
      <h2>Storage</h2>
      {!s && <p className="small muted">{error ?? "Loading…"}</p>}
      {s && !s.supported && <p className="small muted">Drives can only be managed on the NovaEtherOS machine.</p>}
      {s && (
        <p className="small">
          Bitcoin data folder: <span className="mono">{s.data_dir}</span>
        </p>
      )}
      {s?.error && <p className="error small">{s.error}</p>}

      <div className="drive-list">
        {s?.drives.map((d) => {
          const eligible = !d.system && !d.empty && !d.bitcoin;
          return (
            <div key={d.path} className={`drive ${d.empty ? "dim" : ""} ${d.bitcoin ? "is-btc" : ""}`}>
              <div className="drive-head">
                <span className="drive-icon">{driveIcon(d)}</span>
                <div className="drive-title">
                  <strong>{d.model}</strong>
                  <span className="small muted">
                    {d.empty ? "No disk inserted" : formatBytes(d.size)} · {connection(d)} · <span className="mono">{d.path}</span>
                  </span>
                </div>
                <div className="drive-badges">
                  {d.system && <span className="pill idle">System disk</span>}
                  {d.bitcoin && <span className="pill ok">Bitcoin data</span>}
                </div>
              </div>

              {d.partitions.map((p) => (
                <div key={p.path} className="folder">
                  <span>📁</span>
                  <span className="mono small">{p.mountpoints[0] ?? `${p.path} (not mounted)`}</span>
                  <span className="small muted">
                    {p.label ? `${p.label} · ` : ""}
                    {p.fstype ?? "unformatted"}
                    {p.free != null && p.total ? ` · ${formatBytes(p.free)} free of ${formatBytes(p.total)}` : ""}
                  </span>
                  {p.free != null && p.total ? (
                    <div className="bar">
                      <div style={{ width: `${((p.total - p.free) / p.total) * 100}%` }} />
                    </div>
                  ) : null}
                </div>
              ))}

              {eligible && !busy && selected !== d.path && (
                <button className="btn" onClick={() => setSelected(d.path)}>
                  Use for Bitcoin node
                </button>
              )}
              {eligible && selected === d.path && !busy && (
                <ConfirmMove
                  drive={d}
                  onCancel={() => setSelected(null)}
                  onStarted={() => {
                    setStartedFor(d.path);
                    setSelected(null);
                    refresh();
                  }}
                />
              )}
            </div>
          );
        })}
      </div>

      {(busy || s?.job.log) && (
        <>
          <p className="big">{busy ? "Moving the Bitcoin node…" : "Last drive operation"}</p>
          {busy && (
            <p className="small muted">
              NovaEtherOS restarts during this, so the page may stop updating for a moment. Copying existing node data can
              take a while.
            </p>
          )}
          {s?.job.log && <pre className="logs">{s.job.log}</pre>}
        </>
      )}
    </section>
  );
}

function ConfirmMove({ drive, onCancel, onStarted }: { drive: Drive; onCancel: () => void; onStarted: () => void }) {
  const [text, setText] = useState("");
  const [deleteOld, setDeleteOld] = useState(true);
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function go() {
    setSending(true);
    setErr(null);
    try {
      await api.useForBitcoin(drive.path, text, deleteOld);
      onStarted();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="confirm">
      <p className="warn-text">
        ⚠️ Everything on <strong>{drive.model}</strong> ({formatBytes(drive.size)}) will be <strong>erased</strong>. The
        drive is then formatted, mounted automatically at every boot, and the Bitcoin node moves onto it.
      </p>
      <label className="check">
        <input type="checkbox" checked={deleteOld} onChange={(e) => setDeleteOld(e.target.checked)} />
        Delete the old copy on the internal disk afterwards (frees up space)
      </label>
      <label className="field">
        Type ERASE to confirm
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="ERASE" autoComplete="off" />
      </label>
      {err && <p className="error small">{err}</p>}
      <div className="actions">
        <button className="btn ghost" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn danger" disabled={text !== "ERASE" || sending} onClick={go}>
          {sending ? "Starting…" : "Erase and move"}
        </button>
      </div>
    </div>
  );
}
