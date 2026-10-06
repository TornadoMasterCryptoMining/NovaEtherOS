import { useState } from "react";
import {
  api,
  formatDifficulty,
  formatHashrate,
  type MinerSettings,
  type MinersStatus,
} from "../api";
import { usePoll } from "../usePoll";

type Miner = MinersStatus["miners"][number];

function uptime(s: number | null) {
  if (s == null) return "–";
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

function tempTone(t: number | null) {
  if (t == null) return "";
  return t >= 70 ? "hot" : t >= 62 ? "warm" : "";
}

export function Miners() {
  const { data, error, refresh } = usePoll(api.miners, 5000);
  const [ip, setIp] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  async function add() {
    setMsg(null);
    try {
      await api.minerAdd(ip.trim());
      setIp("");
      refresh();
    } catch (e) {
      setMsg((e as Error).message);
    }
  }

  return (
    <div className="miners-page">
      <header className="hero">
        <h1>Miners</h1>
        <p className="muted">
          {data
            ? `${data.totals.online} online · ${formatHashrate(data.totals.hashrate)} · ${data.totals.power.toFixed(0)} W`
            : (error ?? "Loading…")}
        </p>
      </header>

      {data && (
        <div className="miner-toolbar glass">
          <button className="btn ghost" disabled={data.scanning} onClick={() => api.minersScan().then(refresh)}>
            {data.scanning
              ? `Scanning… ${data.scan_progress.done}/${data.scan_progress.total}`
              : "Scan network"}
          </button>
          <span className="small muted">
            {data.last_scan ? `Last scan ${new Date(data.last_scan).toLocaleTimeString()} · rescans every 30 min` : "Finding miners…"}
          </span>
          <div className="add-ip">
            <input placeholder="Add by IP, e.g. 192.168.0.109" value={ip} onChange={(e) => setIp(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && add()} />
            <button className="btn" onClick={add} disabled={!ip.trim()}>Add</button>
          </div>
          {msg && <p className="error small">{msg}</p>}
        </div>
      )}

      {data && data.miners.length === 0 && !data.scanning && (
        <p className="muted center">No miners found yet. Make sure they're on the same network, or add one by IP.</p>
      )}

      <div className="miner-grid">
        {data?.miners.map((m) => <MinerCard key={m.id} m={m} limits={data.limits} onChange={refresh} />)}
      </div>
    </div>
  );
}

function MinerCard({ m, limits, onChange }: { m: Miner; limits: MinersStatus["limits"]; onChange: () => void }) {
  const s = m.stats;
  const [tuning, setTuning] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const name = s?.nickname || s?.hostname || m.ip;

  async function restart() {
    if (!confirm(`Restart ${name}? It stops mining for about 30 seconds.`)) return;
    await api.minerRestart(m.id).catch(() => undefined);
    setNote("Restarting…");
  }

  async function remove() {
    if (!confirm(`Remove ${name} from NovaEtherOS? Network scans won't add it back (add it by IP to undo).`)) return;
    await api.minerRemove(m.id);
    onChange();
  }

  return (
    <section className={`miner glass ${m.online ? "" : "offline"}`}>
      <div className="miner-head">
        <div>
          <strong>{name}</strong>
          <div className="small muted">
            {[s?.model, s?.asic].filter(Boolean).join(" · ")} · <a href={`http://${m.ip}`} target="_blank" rel="noreferrer">{m.ip}</a>
          </div>
        </div>
        <span className={`pill ${m.online ? (s?.overheat ? "bad" : "ok") : "idle"}`}>
          {!m.online ? "Offline" : s?.overheat ? "Overheated" : "Online"}
        </span>
      </div>

      {m.error && <p className="error small">{m.error}</p>}

      {s && (
        <>
          <div className="miner-stats">
            <div><span className="widget-label">Hashrate</span><b>{formatHashrate(s.hashrate)}</b>
              {s.hashrate_1h != null && <span className="small muted">1h {formatHashrate(s.hashrate_1h)}</span>}</div>
            <div><span className="widget-label">Chip temp</span><b className={tempTone(s.temp)}>{s.temp?.toFixed(1) ?? "–"}°C</b>
              <span className="small muted">VR {s.vr_temp?.toFixed(0) ?? "–"}°C</span></div>
            <div><span className="widget-label">Power</span><b>{s.power.toFixed(1)} W</b>
              <span className="small muted">{s.efficiency ? `${s.efficiency.toFixed(1)} J/TH` : " "}</span></div>
            <div><span className="widget-label">Best diff</span><b>{s.best_diff != null ? formatDifficulty(s.best_diff) : "–"}</b>
              <span className="small muted">session {s.best_session_diff != null ? formatDifficulty(s.best_session_diff) : "–"}</span></div>
          </div>

          <dl className="facts">
            <dt>Clock / voltage</dt>
            <dd>{s.frequency ?? "–"} MHz · {s.core_voltage ?? "–"} mV{s.core_voltage_actual ? ` (actual ${s.core_voltage_actual.toFixed(0)})` : ""}</dd>
            <dt>Fan</dt>
            <dd>{s.fan_percent ?? "–"}% · {s.fan_rpm?.toLocaleString() ?? "–"} rpm · {s.auto_fan ? `auto, target ${s.temp_target}°C` : "fixed"}</dd>
            <dt>Shares</dt>
            <dd>{s.shares_accepted?.toLocaleString() ?? "–"} accepted · {s.shares_rejected ?? 0} rejected</dd>
            <dt>Pool</dt>
            <dd>
              {m.on_nova_pool && <span className="pill ok">Your pool</span>}{" "}
              <span className="mono small">{(s.pool.url ?? "–").replace(/^stratum\+tcp:\/\//, "")}:{s.pool.port}</span>
              {s.pool.using_fallback && <span className="small muted"> (on backup)</span>}
              {!m.on_nova_pool && m.nova_pool_backup && <span className="small muted"> · your pool is the backup</span>}
            </dd>
            <dt>Uptime</dt>
            <dd>{uptime(s.uptime)} · {s.firmware} {s.version}</dd>
          </dl>
        </>
      )}

      {note && <p className="small muted">{note}</p>}

      {s && m.online && (
        <div className="actions">
          <button className="btn ghost" onClick={() => setTuning((t) => !t)} disabled={s.locked}>
            {s.locked ? "Settings locked on miner" : tuning ? "Close" : "Tune"}
          </button>
          <button className="btn ghost" onClick={restart}>Restart</button>
          <button className="btn ghost" onClick={remove}>Remove</button>
        </div>
      )}
      {!m.online && (
        <div className="actions">
          <button className="btn ghost" onClick={remove}>Remove</button>
        </div>
      )}

      {tuning && s && (
        <TuneForm
          m={m}
          limits={limits}
          onDone={(text) => {
            setTuning(false);
            setNote(text);
            onChange();
          }}
        />
      )}
    </section>
  );
}

function TuneForm({ m, limits, onDone }: { m: Miner; limits: MinersStatus["limits"]; onDone: (note: string) => void }) {
  const s = m.stats!;
  const [freq, setFreq] = useState(s.frequency ?? 525);
  const [volt, setVolt] = useState(s.core_voltage ?? 1150);
  const [autoFan, setAutoFan] = useState(s.auto_fan);
  const [fan, setFan] = useState(s.manual_fan ?? 100);
  const [target, setTarget] = useState(s.temp_target ?? 60);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    const change: MinerSettings = {};
    if (freq !== s.frequency) change.frequency = freq;
    if (volt !== s.core_voltage) change.coreVoltage = volt;
    if (autoFan !== s.auto_fan) change.autofanspeed = autoFan;
    if (autoFan && target !== s.temp_target) change.temptarget = target;
    if (!autoFan && fan !== s.manual_fan) change.manualFanSpeed = fan;
    if (!Object.keys(change).length) return onDone("No changes.");
    if ((change.frequency || change.coreVoltage) &&
      !confirm("Changing clock or voltage restarts the miner. Higher values mean more heat and power. Continue?")) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await api.minerSettings(m.id, change);
      onDone(r.restarted ? "Saved. The miner is restarting to apply it." : "Saved.");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const L = limits;
  return (
    <div className="tune">
      <label className="field">
        Clock: {freq} MHz
        <input type="range" min={L.frequency.min} max={L.frequency.max} step={5} value={freq}
          onChange={(e) => setFreq(Number(e.target.value))} />
      </label>
      <label className="field">
        Core voltage: {volt} mV
        <input type="range" min={L.coreVoltage.min} max={L.coreVoltage.max} step={5} value={volt}
          onChange={(e) => setVolt(Number(e.target.value))} />
      </label>
      <div className="segmented">
        <button className={autoFan ? "on" : ""} onClick={() => setAutoFan(true)}>Auto fan</button>
        <button className={!autoFan ? "on" : ""} onClick={() => setAutoFan(false)}>Fixed fan</button>
      </div>
      {autoFan ? (
        <label className="field">
          Target chip temperature: {target}°C
          <input type="range" min={L.temptarget.min} max={L.temptarget.max} value={target}
            onChange={(e) => setTarget(Number(e.target.value))} />
        </label>
      ) : (
        <label className="field">
          Fan speed: {fan}%
          <input type="range" min={L.manualFanSpeed.min} max={L.manualFanSpeed.max} value={fan}
            onChange={(e) => setFan(Number(e.target.value))} />
        </label>
      )}
      <p className="small muted">
        Limits match the miner's own settings page. Watch the chip temperature after raising clock or voltage; above
        about 65°C, lower them again.
      </p>
      {err && <p className="error small">{err}</p>}
      <button className="btn" disabled={busy} onClick={save}>{busy ? "Saving…" : "Apply"}</button>
    </div>
  );
}
