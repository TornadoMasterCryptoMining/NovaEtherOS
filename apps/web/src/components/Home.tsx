import type { ReactNode } from "react";
import { api, formatBytes, formatDifficulty, formatDuration, formatHashrate } from "../api";
import { usePoll } from "../usePoll";
import { StatusPill, statusTone, syncPercent } from "./Bitcoin";
import { Icon, Ring } from "./Icons";
import type { View } from "./Shell";
import { Widget } from "./Widget";

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

function uptime(s: number) {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  return d ? `${d}d ${h}h` : `${h}h ${Math.floor((s % 3600) / 60)}m`;
}

export function Home({ onNavigate }: { onNavigate: (v: View) => void }) {
  const { data: sys, error } = usePoll(api.system, 3000);
  const { data: update } = usePoll(api.update, 300_000);
  const { data: apps } = usePoll(api.apps, 30_000);
  const installed = apps?.filter((a) => a.installed) ?? [];

  return (
    <div className="home">
      <header className="hero">
        <h1>{greeting()}</h1>
        <p className="muted">
          {sys ? `${sys.hostname} · ${sys.os} · up ${uptime(sys.uptime)}` : (error ?? "Connecting…")}
        </p>
      </header>

      {update?.available && (
        <button className="banner update-banner" onClick={() => onNavigate("system")}>
          <Icon name="update" />
          <span className="grow">
            <strong>A NovaEtherOS update is available.</strong>
            {update.latest && <span className="muted small"> {update.latest.sha}</span>}
          </span>
          <span className="btn">View update</span>
        </button>
      )}

      <div className="overview">
        <NodeCard onOpen={() => onNavigate("bitcoin")} />
        <MiningCard onOpen={() => onNavigate("miners")} onPool={() => onNavigate("mining")} />
        <AICard onOpen={() => onNavigate("ai")} />
      </div>

      <h2 className="section-title">This machine</h2>
      <section className="widgets">
        <Widget label="CPU" value={sys ? `${sys.cpu.load}%` : "–"} percent={sys?.cpu.load}
          detail={sys?.cpu.temp ? `${sys.cpu.temp}°C` : "Load"} />
        <Widget label="Memory" value={sys ? formatBytes(sys.memory.used) : "–"}
          percent={sys ? (sys.memory.used / sys.memory.total) * 100 : undefined}
          detail={sys ? `of ${formatBytes(sys.memory.total)}` : undefined} />
        <Widget label="Storage" value={sys?.storage ? formatBytes(sys.storage.used) : "–"}
          percent={sys?.storage ? (sys.storage.used / sys.storage.total) * 100 : undefined}
          detail={sys?.storage ? `of ${formatBytes(sys.storage.total)}` : undefined} />
        {sys?.battery && (
          <Widget label="Battery" value={`${sys.battery.percent}%`} percent={sys.battery.percent}
            detail={sys.battery.charging ? "Charging" : "On battery"} tone={sys.battery.percent < 20 && !sys.battery.charging ? "bad" : undefined} />
        )}
      </section>

      <h2 className="section-title">Apps</h2>
      <section className="app-grid">
        {installed.map((a) => (
          <a key={a.id} className="app-tile" href={`http://${location.hostname}:${a.port}`} target="_blank" rel="noreferrer">
            <div className="app-icon">{a.icon}</div>
            <span>{a.name}</span>
          </a>
        ))}
        <button className="app-tile" onClick={() => onNavigate("store")}>
          <div className="app-icon add"><Icon name="plus" /></div>
          <span>Add app</span>
        </button>
      </section>
    </div>
  );
}

function CardHead({ icon, title, tone, children }: { icon: Parameters<typeof Icon>[0]["name"]; title: string; tone: string; children?: ReactNode }) {
  return (
    <div className="ov-head">
      <span className={`ov-icon tone-${tone}`}><Icon name={icon} /></span>
      <strong>{title}</strong>
      <span className="grow" />
      {children}
    </div>
  );
}

function NodeCard({ onOpen }: { onOpen: () => void }) {
  const { data: s } = usePoll(api.bitcoin, 5000);
  const pct = s ? syncPercent(s) : 0;
  const plan = s?.storage.plan;
  return (
    <button className="ov-card" onClick={onOpen}>
      <CardHead icon="bitcoin" title="Bitcoin node" tone="btc">{s && <StatusPill state={s.node.state} />}</CardHead>
      <div className="ov-body">
        <Ring percent={pct} tone={s && statusTone(s.node.state) === "bad" ? "bad" : "btc"}>
          <b>{pct >= 100 ? "100" : pct.toFixed(1)}%</b>
          <small>synced</small>
        </Ring>
        <dl className="ov-stats">
          <dt>Block</dt><dd>{s?.node.blocks?.toLocaleString() ?? "–"}</dd>
          <dt>Peers</dt><dd>{s?.node.peers ?? "–"}</dd>
          <dt>Storage</dt>
          <dd>{!plan || plan.status !== "ok" ? "–" : plan.mode === "full" ? "Full node" : `Pruned ${formatBytes(plan.prune_mib * 1048576)}`}</dd>
        </dl>
      </div>
      <p className="ov-foot">{s?.node.message ?? "Connecting…"}</p>
    </button>
  );
}

function MiningCard({ onOpen, onPool }: { onOpen: () => void; onPool: () => void }) {
  const { data: m } = usePoll(api.miners, 10_000);
  const { data: p } = usePoll(api.pool, 10_000);
  const onPoolCount = m?.miners.filter((x) => x.on_nova_pool && x.online).length ?? 0;
  const stranded = m?.miners.filter((x) => x.stranded).length ?? 0;
  return (
    <button className="ov-card" onClick={onOpen}>
      <CardHead icon="pickaxe" title="Mining" tone="accent">
        {m && <span className={`pill ${m.totals.online ? "ok" : "idle"}`}>{m.totals.online} online</span>}
      </CardHead>
      <div className="ov-figure">
        <b>{m ? formatHashrate(m.totals.hashrate) : "–"}</b>
        <small>{m ? `${m.totals.power.toFixed(0)} W across ${m.miners.length} miner${m.miners.length === 1 ? "" : "s"}` : " "}</small>
      </div>
      <dl className="ov-stats row">
        <dt>Solo pool</dt><dd>{p ? formatHashrate(p.hashrate) : "–"}</dd>
        <dt>Best share</dt><dd>{p?.best_share ? formatDifficulty(p.best_share.difficulty) : "–"}</dd>
        <dt>Block odds</dt><dd>{p?.expected_seconds ? `~${formatDuration(p.expected_seconds)}` : "–"}</dd>
      </dl>
      <p className="ov-foot">
        {onPoolCount ? `${onPoolCount} mining to your own pool` : stranded ? "" : "No miners on your own pool yet. "}
        {stranded > 0 && <span className="warn-inline">{stranded} on backup pool{m?.auto_reconnect ? ", reconnecting" : ""}</span>}
        {!onPoolCount && !stranded && <span className="link" role="link" onClick={(e) => { e.stopPropagation(); onPool(); }}>How to connect</span>}
      </p>
    </button>
  );
}

function AICard({ onOpen }: { onOpen: () => void }) {
  const { data: ai } = usePoll(api.ai, 20_000);
  const ready = Boolean(ai?.engine.reachable && ai.models.length);
  const model = ai?.settings.default_model ?? ai?.models[0]?.name;
  return (
    <button className="ov-card" onClick={onOpen}>
      <CardHead icon="sparkles" title="Nova AI" tone="ai">
        {ai && <span className={`pill ${ready ? "ok" : ai.engine.reachable ? "busy" : "idle"}`}>{ready ? "Ready" : ai.engine.reachable ? "No model" : "Off"}</span>}
      </CardHead>
      <div className="ov-figure">
        <b className={ready ? "mono-figure" : ""}>{ready ? model : ai?.engine.reachable ? "Pick a model" : "Not set up"}</b>
        <small>{ai?.engine.reachable ? `Ollama ${ai.engine.version} · ${ai.models.length} model${ai.models.length === 1 ? "" : "s"}` : "Local coding agent, running on your hardware"}</small>
      </div>
      <p className="ov-foot">
        {ready ? "Build, fix and explain code, or use it from your apps through the API." : "Install the AI engine and a model to get started."}
        <span className="ov-go">Open <Icon name="arrow" size={14} /></span>
      </p>
    </button>
  );
}
