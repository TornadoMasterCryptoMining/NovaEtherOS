import { api, formatBytes } from "../api";
import { usePoll } from "../usePoll";
import { Widget } from "./Widget";
import { StatusPill, syncPercent } from "./Bitcoin";

function BitcoinCard({ onOpen }: { onOpen: () => void }) {
  const { data: s } = usePoll(api.bitcoin, 5000);
  if (!s) return null;
  const pct = syncPercent(s);
  const plan = s.storage.plan;
  return (
    <button className="btc-card glass" onClick={onOpen}>
      <div className="btc-card-head">
        <span className="btc-logo">₿</span>
        <strong>Bitcoin Node</strong>
        <StatusPill state={s.node.state} />
      </div>
      <div className="btc-card-stats">
        <div>
          <span className="widget-label">Sync</span>
          <span className="widget-value">{pct.toFixed(pct === 100 ? 0 : 2)}%</span>
        </div>
        <div>
          <span className="widget-label">Block</span>
          <span className="widget-value">{s.node.blocks?.toLocaleString() ?? "–"}</span>
        </div>
        <div>
          <span className="widget-label">Peers</span>
          <span className="widget-value">{s.node.peers ?? "–"}</span>
        </div>
        <div>
          <span className="widget-label">Storage</span>
          <span className="widget-value">
            {!plan || plan.status !== "ok" ? "–" : plan.mode === "full" ? "Full" : formatBytes(plan.prune_mib * 1024 * 1024)}
          </span>
        </div>
      </div>
      <div className="bar">
        <div style={{ width: `${pct}%` }} />
      </div>
      <p className="muted small">{s.node.message}</p>
    </button>
  );
}

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

export function Home({ onOpenStore, onOpenBitcoin }: { onOpenStore: () => void; onOpenBitcoin: () => void }) {
  const { data: sys, error } = usePoll(api.system, 3000);
  const { data: apps } = usePoll(api.apps, 10000);
  const installed = apps?.filter((a) => a.installed) ?? [];

  return (
    <div className="home">
      <header className="hero">
        <h1>{greeting()}</h1>
        <p className="muted">
          {sys
            ? `${sys.hostname} · ${sys.os} · up ${Math.floor(sys.uptime / 3600)}h`
            : (error ?? "Connecting…")}
        </p>
      </header>

      <section className="widgets">
        <Widget
          label="CPU"
          value={sys ? `${sys.cpu.load}%` : "–"}
          percent={sys?.cpu.load}
          detail={sys?.cpu.temp ? `${sys.cpu.temp}°C` : undefined}
        />
        <Widget
          label="Memory"
          value={sys ? formatBytes(sys.memory.used) : "–"}
          percent={sys ? (sys.memory.used / sys.memory.total) * 100 : undefined}
          detail={sys ? `of ${formatBytes(sys.memory.total)}` : undefined}
        />
        <Widget
          label="Storage"
          value={sys?.storage ? formatBytes(sys.storage.used) : "–"}
          percent={sys?.storage ? (sys.storage.used / sys.storage.total) * 100 : undefined}
          detail={sys?.storage ? `of ${formatBytes(sys.storage.total)}` : undefined}
        />
        {sys?.battery && (
          <Widget
            label="Battery"
            value={`${sys.battery.percent}%`}
            percent={sys.battery.percent}
            detail={sys.battery.charging ? "Charging" : "On battery"}
          />
        )}
      </section>

      <BitcoinCard onOpen={onOpenBitcoin} />

      <section className="app-grid">
        {installed.map((a) => (
          <a
            key={a.id}
            className="app-tile"
            href={`http://${location.hostname}:${a.port}`}
            target="_blank"
            rel="noreferrer"
          >
            <div className="app-icon glass">{a.icon}</div>
            <span>{a.name}</span>
          </a>
        ))}
        <button className="app-tile" onClick={onOpenStore}>
          <div className="app-icon glass add">+</div>
          <span>Add app</span>
        </button>
      </section>
    </div>
  );
}
