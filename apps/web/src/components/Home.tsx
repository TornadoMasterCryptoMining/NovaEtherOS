import { api, formatBytes } from "../api";
import { usePoll } from "../usePoll";
import { Widget } from "./Widget";

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

export function Home({ onOpenStore }: { onOpenStore: () => void }) {
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
