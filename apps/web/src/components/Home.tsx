import { useEffect, useState } from "react";
import { api, formatBTC, formatBytes, formatDifficulty, formatHashrate, type MinersStatus } from "../api";
import { usePoll } from "../usePoll";
import { statusTone, syncPercent } from "./Bitcoin";
import { Icon } from "./Icons";
import type { View } from "./Shell";
import { EmptyState, ErrorNote, Monogram, Skeleton, StatusDot } from "./ui";

const TONE = { ok: "success", busy: "warning", bad: "danger", idle: "idle" } as const;
const MAX_WEIGHT = 4_000_000;

function useNow(ms = 15_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

function ago(unixSeconds: number, now: number) {
  const m = Math.max(0, Math.floor((now / 1000 - unixSeconds) / 60));
  return m < 1 ? "now" : m < 60 ? `${m}m ago` : `${Math.floor(m / 60)}h ${m % 60}m ago`;
}

function uptime(s: number) {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  return d ? `${d}d ${h}h` : `${h}h ${Math.floor((s % 3600) / 60)}m`;
}

const satvb = (n: number | null | undefined) => (n == null ? "—" : `${n < 10 ? n.toFixed(1) : Math.round(n)}`);

export function Home({ onNavigate }: { onNavigate: (v: View) => void }) {
  const { data: sys, error } = usePoll(api.system, 5000);
  const { data: update } = usePoll(api.update, 300_000);

  return (
    <div className="mission">
      <header className="mission-head">
        <div>
          <h1>Overview</h1>
          <p className="muted small">
            {sys ? `${sys.hostname} · ${sys.os} · up ${uptime(sys.uptime)}` : error ? "" : <Skeleton width={260} height={12} />}
          </p>
        </div>
        {update?.available && (
          <button className="btn ghost sm" onClick={() => onNavigate("system")}>
            <Icon name="update" size={14} /> Update to {update.latest?.sha ?? "latest"}
          </button>
        )}
      </header>

      {error && <ErrorNote message={error} />}

      <ChainRail onOpen={() => onNavigate("blocks")} />

      <section className="instruments" aria-label="Live instruments">
        <HashrateInstrument onOpen={() => onNavigate("miners")} />
        <NodeInstrument onOpen={() => onNavigate("bitcoin")} />
        <MachineInstrument />
      </section>

      <MinerTable onOpen={() => onNavigate("miners")} onPool={() => onNavigate("mining")} />

      <div className="mission-split">
        <ActivityLog />
        <div className="mission-side">
          <AIStrip onOpen={() => onNavigate("ai")} />
          <AppsStrip onOpen={() => onNavigate("store")} />
        </div>
      </div>
    </div>
  );
}

// The chain as a timeline: the block being built, then the latest blocks.
// Bar height is how full each block is.
function ChainRail({ onOpen }: { onOpen: () => void }) {
  const { data: x } = usePoll(api.explorer, 10_000);
  const now = useNow();

  if (!x) return <section className="rail"><Skeleton height={112} /></section>;
  if (!x.blocks.length) {
    return (
      <section className="rail">
        <EmptyState title={x.installed ? "Waiting for your node" : "No blockchain data yet"}>
          {x.installed
            ? "Blocks appear here as soon as Bitcoin Core is running."
            : "The block timeline shows live data once the built-in Bitcoin node runs on this machine."}
        </EmptyState>
      </section>
    );
  }

  const n = x.next_block;
  return (
    <section className="rail" aria-label="Blockchain timeline">
      <div className="rail-meta">
        <span className="mono-label">Chain</span>
        <span className="small muted num">
          {x.mempool ? `${x.mempool.tx_count.toLocaleString()} tx waiting · ` : ""}next block {satvb(x.fees.next_block)} sat/vB · 1 h {satvb(x.fees.hour)} sat/vB
        </span>
        <button className="link push-right" onClick={onOpen}>Open explorer</button>
      </div>
      <ol className="rail-track">
        <li className="rail-block next" title="The block your node would mine next">
          <span className="rail-bar"><span style={{ transform: `scaleY(${n ? Math.min(1, n.weight / MAX_WEIGHT) : 0})` }} /></span>
          <span className="rail-height num">{n ? n.height.toLocaleString() : "next"}</span>
          <span className="rail-sub num">{n ? `${satvb(n.feerate_median)} sat/vB` : "—"}</span>
          <span className="rail-sub num">{n ? formatBTC(n.reward, 3) : ""}</span>
        </li>
        {x.blocks.slice(0, 10).map((b) => (
          <li key={b.hash} className={`rail-block ${b.pool === "NovaEtherOS" ? "mine" : ""}`} title={`${b.pool} · ${b.tx_count.toLocaleString()} transactions`}>
            <span className="rail-bar"><span style={{ transform: `scaleY(${Math.min(1, b.weight / MAX_WEIGHT)})` }} /></span>
            <span className="rail-height num">{b.height.toLocaleString()}</span>
            <span className="rail-sub num">{ago(b.time, now)}</span>
            <span className="rail-sub truncate">{b.pool === "NovaEtherOS" ? "Your pool" : b.pool}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

// Line chart of the last 24 h of fleet hashrate.
function Sparkline({ points }: { points: MinersStatus["history"] }) {
  if (points.length < 2) return <div className="spark empty small faint">Collecting history: one point a minute</div>;
  const w = 320;
  const h = 64;
  const max = Math.max(...points.map((p) => p.hashrate)) || 1;
  const t0 = points[0].t;
  const span = points[points.length - 1].t - t0 || 1;
  const xy = points.map((p) => [((p.t - t0) / span) * w, h - 4 - (p.hashrate / max) * (h - 8)] as const);
  const line = xy.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  return (
    <svg className="spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img" aria-label="Fleet hashrate over time">
      <path d={`${line} L${w},${h} L0,${h} Z`} className="spark-area" />
      <path d={line} className="spark-line" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function HashrateInstrument({ onOpen }: { onOpen: () => void }) {
  const { data: m } = usePoll(api.miners, 10_000);
  const hist = m?.history ?? [];
  const avg = hist.length ? hist.reduce((s, p) => s + p.hashrate, 0) / hist.length : null;
  const hours = hist.length ? Math.max(1, Math.round((hist[hist.length - 1].t - hist[0].t) / 3_600_000)) : 0;
  const th = m ? m.totals.hashrate / 1e12 : 0;

  return (
    <button className="instrument" onClick={onOpen}>
      <span className="mono-label">Fleet hashrate</span>
      {!m ? <Skeleton height={36} width="60%" /> : (
        <span className="instrument-value num">{formatHashrate(m.totals.hashrate)}</span>
      )}
      <Sparkline points={hist} />
      <dl className="kv row">
        <dt>{hours ? `${hours} h avg` : "Average"}</dt><dd className="num">{avg != null ? formatHashrate(avg) : "—"}</dd>
        <dt>Power</dt><dd className="num">{m ? `${m.totals.power.toFixed(1)} W` : "—"}</dd>
        <dt>Efficiency</dt><dd className="num">{m && th > 0 ? `${(m.totals.power / th).toFixed(1)} J/TH` : "—"}</dd>
      </dl>
    </button>
  );
}

function NodeInstrument({ onOpen }: { onOpen: () => void }) {
  const { data: s } = usePoll(api.bitcoin, 5000);
  const pct = s ? syncPercent(s) : 0;
  const plan = s?.storage.plan;
  return (
    <button className="instrument" onClick={onOpen}>
      <span className="mono-label">Bitcoin node</span>
      {!s ? <Skeleton height={36} width="50%" /> : !s.installed ? (
        <>
          <span className="instrument-value muted">Not installed</span>
          <span className="small muted">Run the NovaEtherOS installer on the Debian machine to add the built-in node.</span>
        </>
      ) : (
        <>
          <span className="instrument-value num">{pct >= 100 ? "Synced" : `${pct.toFixed(2)}%`}</span>
          <span className="progress"><span style={{ transform: `scaleX(${pct / 100})` }} /></span>
          <StatusDot tone={TONE[statusTone(s.node.state)]}>{s.node.message.split(".")[0]}</StatusDot>
          <dl className="kv row">
            <dt>Height</dt><dd className="num">{s.node.blocks?.toLocaleString() ?? "—"}</dd>
            <dt>Peers</dt><dd className="num">{s.node.peers ?? "—"}</dd>
            <dt>Storage</dt><dd>{!plan || plan.status !== "ok" ? "—" : plan.mode === "full" ? "Full" : `Pruned ${formatBytes(plan.prune_mib * 1048576)}`}</dd>
          </dl>
        </>
      )}
    </button>
  );
}

function Gauge({ label, percent, value }: { label: string; percent: number | null; value: string }) {
  const tone = percent == null ? "" : percent >= 90 ? "danger" : percent >= 75 ? "warning" : "";
  return (
    <div className="gauge">
      <span className="gauge-label">{label}</span>
      <span className={`gauge-bar ${tone}`}><span style={{ transform: `scaleX(${(percent ?? 0) / 100})` }} /></span>
      <span className="gauge-value num">{value}</span>
    </div>
  );
}

function MachineInstrument() {
  const { data: sys } = usePoll(api.system, 5000);
  const pct = (used: number, total: number) => (total ? (used / total) * 100 : 0);
  return (
    <div className="instrument static">
      <span className="mono-label">This machine</span>
      {!sys ? <Skeleton height={96} /> : (
        <div className="gauges">
          <Gauge label="CPU" percent={sys.cpu.load} value={`${sys.cpu.load}%${sys.cpu.temp ? ` · ${sys.cpu.temp}°C` : ""}`} />
          <Gauge label="Memory" percent={pct(sys.memory.used, sys.memory.total)} value={`${formatBytes(sys.memory.used)} / ${formatBytes(sys.memory.total)}`} />
          {sys.storage && (
            <Gauge label="Disk" percent={pct(sys.storage.used, sys.storage.total)} value={`${formatBytes(sys.storage.used)} / ${formatBytes(sys.storage.total)}`} />
          )}
          {sys.battery && (
            <Gauge label="Battery" percent={sys.battery.charging ? null : 100 - sys.battery.percent} value={`${sys.battery.percent}%${sys.battery.charging ? " · charging" : ""}`} />
          )}
        </div>
      )}
    </div>
  );
}

function MinerTable({ onOpen, onPool }: { onOpen: () => void; onPool: () => void }) {
  const { data: m } = usePoll(api.miners, 10_000);
  return (
    <section className="panel flush">
      <div className="panel-head padded">
        <h2>Miners</h2>
        {m && <span className="small muted num">{m.totals.online} of {m.miners.length} online</span>}
        <button className="btn ghost sm push-right" onClick={onOpen}>Manage miners</button>
      </div>
      {!m ? (
        <div className="padded"><Skeleton height={80} /></div>
      ) : m.miners.length === 0 ? (
        <div className="padded">
          <EmptyState title="No miners found yet">NovaEtherOS scans your network for Bitaxe-family miners every 30 minutes.</EmptyState>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="blocks-table">
            <thead>
              <tr>
                <th>Miner</th>
                <th className="r">Hashrate</th>
                <th className="r">1 h</th>
                <th className="r">Temp</th>
                <th className="r">Power</th>
                <th className="r">J/TH</th>
                <th>Pool</th>
                <th className="r">Shares</th>
                <th className="r">Best</th>
              </tr>
            </thead>
            <tbody>
              {m.miners.map((x) => {
                const s = x.stats;
                return (
                  <tr key={x.id} className={x.online ? "" : "dim"}>
                    <td>
                      <StatusDot tone={!x.online ? "idle" : s?.overheat ? "danger" : "success"}>
                        <span>{s?.nickname || s?.hostname || x.ip}</span>
                      </StatusDot>
                      <span className="faint small mono"> {x.ip}</span>
                    </td>
                    <td className="r num">{x.online && s ? formatHashrate(s.hashrate) : "offline"}</td>
                    <td className="r num muted">{s?.hashrate_1h != null ? formatHashrate(s.hashrate_1h) : "—"}</td>
                    <td className={`r num ${s?.temp != null && s.temp >= 70 ? "error" : ""}`}>{s?.temp != null ? `${s.temp.toFixed(1)}°` : "—"}</td>
                    <td className="r num">{s ? `${s.power.toFixed(1)} W` : "—"}</td>
                    <td className="r num muted">{s?.efficiency ? s.efficiency.toFixed(1) : "—"}</td>
                    <td>
                      <span className={`tag ${x.on_nova_pool ? "accent" : x.stranded ? "warning" : ""}`}>
                        {x.on_nova_pool ? "Your pool" : x.stranded ? "Backup" : "Other"}
                      </span>
                    </td>
                    <td className="r num">{s?.shares_accepted?.toLocaleString() ?? "—"}</td>
                    <td className="r num">{s?.best_diff != null ? formatDifficulty(s.best_diff) : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {m && m.miners.length > 0 && !m.miners.some((x) => x.on_nova_pool) && (
        <p className="small muted padded">
          None of your miners mine to your own pool yet. <button className="link" onClick={onPool}>How to connect them</button>
        </p>
      )}
    </section>
  );
}

function ActivityLog() {
  const { data: s } = usePoll(api.bitcoin, 10_000);
  const events = (s?.events ?? []).slice(0, 8);
  return (
    <section className="panel">
      <div className="panel-head"><h2>Activity</h2></div>
      {!s ? <Skeleton height={96} /> : events.length === 0 ? (
        <p className="small muted">Nothing yet. Node, pool and miner events appear here.</p>
      ) : (
        <ol className="log">
          {events.map((e, i) => (
            <li key={i} className={e.level}>
              <time className="mono faint">{new Date(e.time * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
              <span>{e.message}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function AIStrip({ onOpen }: { onOpen: () => void }) {
  const { data: ai } = usePoll(api.ai, 20_000);
  const ready = Boolean(ai?.engine.reachable && ai.models.length);
  const model = ai?.settings.default_model ?? ai?.models[0]?.name;
  return (
    <button className="strip" onClick={onOpen}>
      <Icon name="sparkles" size={16} />
      <span className="grow">
        <strong>Nova AI</strong>
        <span className="small muted"> · {!ai ? "…" : ready ? model : ai.engine.reachable ? "no model downloaded" : "not set up"}</span>
      </span>
      {ai && <StatusDot tone={ready ? "success" : ai.engine.reachable ? "warning" : "idle"}>{ready ? "Ready" : "Set up"}</StatusDot>}
    </button>
  );
}

function AppsStrip({ onOpen }: { onOpen: () => void }) {
  const { data: apps } = usePoll(api.apps, 30_000);
  const installed = apps?.filter((a) => a.installed) ?? [];
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Apps</h2>
        <button className="link push-right" onClick={onOpen}>Browse {apps?.length ?? ""} apps</button>
      </div>
      {!apps ? <Skeleton height={40} /> : installed.length === 0 ? (
        <p className="small muted">No apps installed yet.</p>
      ) : (
        <ul className="app-list">
          {installed.map((a) => (
            <li key={a.id}>
              <a href={`http://${location.hostname}:${a.port}${a.path ?? ""}`} target="_blank" rel="noreferrer">
                <Monogram name={a.name} size={24} />
                <span className="grow">{a.name}</span>
                <span className="faint small num">:{a.port}</span>
                <Icon name="external" size={14} />
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
