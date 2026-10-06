import { useEffect, useState } from "react";
import { api, formatBytes, formatGB, type BitcoinSettings, type BitcoinStatus, type MiningCheck } from "../api";
import { usePoll } from "../usePoll";

const STATE_LABELS: Record<BitcoinStatus["node"]["state"], string> = {
  not_installed: "Not installed",
  starting: "Starting",
  syncing: "Syncing",
  running: "Synced",
  waiting_for_storage: "Waiting for space",
  error: "Error",
  stopped: "Stopped",
};

export function statusTone(state: BitcoinStatus["node"]["state"]) {
  if (state === "running") return "ok";
  if (state === "error" || state === "waiting_for_storage") return "bad";
  if (state === "not_installed" || state === "stopped") return "idle";
  return "busy";
}

export function StatusPill({ state }: { state: BitcoinStatus["node"]["state"] }) {
  return <span className={`pill ${statusTone(state)}`}>{STATE_LABELS[state]}</span>;
}

export function syncPercent(s: BitcoinStatus) {
  if (s.node.ibd === false) return 100;
  return Math.min(100, (s.node.progress ?? 0) * 100);
}

export function Bitcoin() {
  const { data: s, error, refresh } = usePoll(api.bitcoin, 5000);

  if (!s) {
    return (
      <div className="hero">
        <h1>Bitcoin Node</h1>
        <p className="muted">{error ?? "Loading…"}</p>
      </div>
    );
  }

  const { node, storage } = s;
  const plan = storage.plan;
  const scan = storage.scan;

  return (
    <div className="bitcoin">
      <header className="hero">
        <h1>Bitcoin Node</h1>
        <p className="muted">
          <StatusPill state={node.state} /> {node.version ? `${node.version} · ` : ""}
          {node.message}
        </p>
      </header>

      {storage.restart_needed && <RestartBanner onDone={refresh} />}

      <section className="widgets">
        <Stat label="Sync" value={`${syncPercent(s).toFixed(2)}%`} percent={syncPercent(s)}
          detail={node.blocks != null ? `Block ${node.blocks.toLocaleString()} of ${node.headers?.toLocaleString()}` : undefined} />
        <Stat label="Peers" value={String(node.peers ?? 0)}
          detail={node.peers != null ? `${node.peers_in ?? 0} in · ${node.peers_out ?? 0} out` : undefined} />
        <Stat label="Mempool" value={node.mempool_bytes != null ? formatBytes(node.mempool_bytes) : "–"}
          detail={node.mempool_tx != null ? `${node.mempool_tx.toLocaleString()} transactions` : undefined} />
        <Stat label="On disk" value={node.size_on_disk != null ? formatGB(node.size_on_disk, 1) : "–"}
          detail={node.pruned ? "Pruned" : node.size_on_disk != null ? "Full node" : undefined} />
      </section>

      <div className="panels">
        <section className="panel glass">
          <h2>Smart Storage</h2>
          {plan && (
            <>
              <p className="big">
                {plan.status === "insufficient"
                  ? "Not enough space"
                  : plan.mode === "full"
                    ? "Full node"
                    : `Pruned · ${formatGB(plan.prune_mib * 1024 * 1024)}`}
              </p>
              {plan.reasons.map((r) => (
                <p key={r} className="small">{r}</p>
              ))}
            </>
          )}
          {scan && (
            <dl className="facts">
              <dt>Drive</dt>
              <dd>
                {formatGB(scan.disk_free)} free of {formatGB(scan.disk_total)}
                {scan.rotational != null && ` · ${scan.rotational ? "HDD" : "SSD"}`}
              </dd>
              <dt>Data folder</dt>
              <dd className="mono">{storage.data_dir}</dd>
              <dt>Bitcoin uses</dt>
              <dd>{formatGB(scan.bitcoin_used, 1)}</dd>
              {plan && (
                <>
                  <dt>Reserve</dt>
                  <dd>{formatGB(plan.reserve_bytes)} kept free for the OS</dd>
                </>
              )}
              <dt>Machine</dt>
              <dd>
                {scan.model ?? scan.arch} · {formatBytes(scan.ram)} RAM · {scan.cpus} CPUs
              </dd>
              {s.profile && (
                <>
                  <dt>Profile</dt>
                  <dd>
                    {s.profile.tier} · dbcache {s.profile.dbcache} MiB · {s.profile.maxconnections} peers
                  </dd>
                </>
              )}
            </dl>
          )}
        </section>

        <Settings status={s} onSaved={refresh} />
        <Connect status={s} />
        <MiningCheckPanel disabled={!s.installed} />
        <Activity status={s} />
      </div>
    </div>
  );
}

function Stat({ label, value, percent, detail }: { label: string; value: string; percent?: number; detail?: string }) {
  return (
    <div className="widget glass">
      <div className="widget-label">{label}</div>
      <div className="widget-value">{value}</div>
      {detail && <div className="muted small">{detail}</div>}
      {percent != null && (
        <div className="bar">
          <div style={{ width: `${percent}%` }} />
        </div>
      )}
    </div>
  );
}

function RestartBanner({ onDone }: { onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="banner glass">
      <span>New settings are saved. Restart Bitcoin Core to apply them.</span>
      <button className="btn" disabled={busy}
        onClick={async () => {
          setBusy(true);
          await api.bitcoinRestart().catch(() => undefined);
          setBusy(false);
          onDone();
        }}>
        {busy ? "Restarting…" : "Restart now"}
      </button>
    </div>
  );
}

function Settings({ status, onSaved }: { status: BitcoinStatus; onSaved: () => void }) {
  const [form, setForm] = useState<BitcoinSettings>(status.settings);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // Pick up changes saved elsewhere, but don't clobber the form while editing.
  const serverKey = JSON.stringify(status.settings);
  useEffect(() => setForm(status.settings), [serverKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = <K extends keyof BitcoinSettings>(k: K, v: BitcoinSettings[K]) => {
    setSaved(false);
    setForm((f) => ({ ...f, [k]: v }));
  };
  const needsResync = form.storage_mode === "full" && status.storage.scan?.datadir_pruned;

  async function save() {
    setSaving(true);
    try {
      await api.bitcoinSettings(form);
      setSaved(true);
      onSaved();
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="panel glass">
      <h2>Settings</h2>
      <div className="segmented">
        {(["auto", "full", "prune"] as const).map((m) => (
          <button key={m} className={form.storage_mode === m ? "on" : ""} onClick={() => set("storage_mode", m)}>
            {m === "auto" ? "Automatic" : m === "full" ? "Full node" : "Prune"}
          </button>
        ))}
      </div>
      {form.storage_mode === "prune" && (
        <label className="field">
          Keep recent blocks (GB)
          <input type="number" min={1} value={form.prune_gb} onChange={(e) => set("prune_gb", Number(e.target.value))} />
        </label>
      )}
      {needsResync && (
        <label className="check warn">
          <input type="checkbox" checked={form.confirm_resync} onChange={(e) => set("confirm_resync", e.target.checked)} />
          Re-download the whole blockchain to become a full node (takes days)
        </label>
      )}
      <details>
        <summary>Advanced</summary>
        <label className="field">
          Reserve free space (GB, blank = automatic)
          <input type="number" min={0} value={form.reserve_gb ?? ""}
            onChange={(e) => set("reserve_gb", e.target.value === "" ? null : Number(e.target.value))} />
        </label>
        <label className="field">
          Database cache (MiB, blank = automatic)
          <input type="number" min={4} value={form.dbcache_mb ?? ""}
            onChange={(e) => set("dbcache_mb", e.target.value === "" ? null : Number(e.target.value))} />
        </label>
        <label className="check">
          <input type="checkbox" checked={form.txindex} onChange={(e) => set("txindex", e.target.checked)} />
          Transaction index (full node only)
        </label>
      </details>
      <button className="btn" disabled={saving} onClick={save}>
        {saving ? "Saving…" : saved ? "Saved" : "Save settings"}
      </button>
    </section>
  );
}

function Connect({ status }: { status: BitcoinStatus }) {
  const [reveal, setReveal] = useState(false);
  const c = status.connection;
  return (
    <section className="panel glass">
      <h2>Connect</h2>
      <p className="small muted">Use these in pool software, Sparrow, Specter or Nunchuk (choose Bitcoin Core).</p>
      <dl className="facts mono">
        <dt>Host</dt>
        <dd>{c.host}</dd>
        <dt>RPC port</dt>
        <dd>{c.rpc_port}</dd>
        <dt>RPC user</dt>
        <dd>{c.rpc_user}</dd>
        <dt>RPC password</dt>
        <dd>
          {reveal ? c.rpc_pass : "••••••••••••"}{" "}
          <button className="link" onClick={() => setReveal((r) => !r)}>{reveal ? "hide" : "show"}</button>
        </dd>
        <dt>P2P port</dt>
        <dd>{c.p2p_port}</dd>
        <dt>ZMQ</dt>
        <dd>
          {Object.entries(c.zmq).map(([k, v]) => (
            <div key={k}>{k}: {v}</div>
          ))}
        </dd>
      </dl>
    </section>
  );
}

function MiningCheckPanel({ disabled }: { disabled: boolean }) {
  const [checks, setChecks] = useState<MiningCheck[] | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <section className="panel glass">
      <h2>Mining check</h2>
      <p className="small muted">Tests that the node is synced, has peers and can build a block template for miners.</p>
      {checks && (
        <ul className="checks">
          {checks.map((c) => (
            <li key={c.name} className={c.ok ? "ok" : "bad"}>
              <strong>{c.ok ? "✓" : "✗"} {c.name}</strong>
              <span className="small muted">{c.detail}</span>
            </li>
          ))}
        </ul>
      )}
      <button className="btn" disabled={busy || disabled}
        onClick={async () => {
          setBusy(true);
          setChecks(await api.bitcoinMiningCheck().catch(() => null));
          setBusy(false);
        }}>
        {busy ? "Checking…" : "Run mining check"}
      </button>
    </section>
  );
}

function Activity({ status }: { status: BitcoinStatus }) {
  const [logs, setLogs] = useState<string | null>(null);
  return (
    <section className="panel glass wide">
      <h2>Activity</h2>
      {status.events.length === 0 && <p className="small muted">No events yet.</p>}
      <ul className="events">
        {status.events.map((e, i) => (
          <li key={i} className={e.level}>
            <span className="muted small">{new Date(e.time * 1000).toLocaleString()}</span> {e.message}
          </li>
        ))}
      </ul>
      {status.installed && (
        <button className="btn ghost" onClick={async () => setLogs(logs ? null : await api.bitcoinLogs())}>
          {logs ? "Hide logs" : "Show Bitcoin Core logs"}
        </button>
      )}
      {logs && <pre className="logs">{logs}</pre>}
    </section>
  );
}
