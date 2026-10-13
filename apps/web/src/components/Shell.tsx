import { useEffect, useState } from "react";
import { api, formatHashrate } from "../api";
import { usePoll } from "../usePoll";
import { syncPercent } from "./Bitcoin";
import { Icon, Logo, type IconName } from "./Icons";

export type View = "home" | "bitcoin" | "blocks" | "mining" | "miners" | "ai" | "store" | "system";

export const NAV: { group: string; items: { id: View; label: string; icon: IconName; hint: string }[] }[] = [
  { group: "", items: [{ id: "home", label: "Overview", icon: "home", hint: "Everything at a glance" }] },
  {
    group: "Bitcoin",
    items: [
      { id: "bitcoin", label: "Node", icon: "bitcoin", hint: "Your own Bitcoin Core" },
      { id: "blocks", label: "Blocks & Mempool", icon: "blocks", hint: "Live from your node" },
      { id: "mining", label: "Solo Pool", icon: "pickaxe", hint: "Your own solo mining pool" },
      { id: "miners", label: "Miners", icon: "chip", hint: "Monitor and tune your miners" },
    ],
  },
  { group: "Intelligence", items: [{ id: "ai", label: "Nova AI", icon: "sparkles", hint: "Local coding agent and API" }] },
  {
    group: "System",
    items: [
      { id: "store", label: "Apps", icon: "apps", hint: "Self-hosted apps" },
      { id: "system", label: "Settings", icon: "settings", hint: "Storage and updates" },
    ],
  },
];

export const viewInfo = (v: View) => NAV.flatMap((g) => g.items).find((i) => i.id === v)!;

// ----- theme: follow the system, or force light/dark -----

type Theme = "auto" | "light" | "dark";

function loadTheme(): Theme {
  try {
    const t = localStorage.getItem("nova-theme");
    return t === "light" || t === "dark" ? t : "auto";
  } catch {
    return "auto";
  }
}

function useTheme() {
  const [theme, setTheme] = useState<Theme>(loadTheme);
  useEffect(() => {
    const root = document.documentElement;
    if (theme === "auto") delete root.dataset.theme;
    else root.dataset.theme = theme;
    try {
      localStorage.setItem("nova-theme", theme);
    } catch {
      // storage blocked
    }
  }, [theme]);
  return [theme, setTheme] as const;
}

export function Sidebar({ view, open, onChange, onClose }: {
  view: View;
  open: boolean;
  onChange: (v: View) => void;
  onClose: () => void;
}) {
  const [theme, setTheme] = useTheme();
  const { data: sys } = usePoll(api.system, 30_000);
  const { data: update } = usePoll(api.update, 300_000);

  return (
    <>
      <div className={`scrim ${open ? "show" : ""}`} onClick={onClose} />
      <aside className={`sidebar ${open ? "open" : ""}`}>
        <div className="brand">
          <Logo />
          <div>
            <strong>Nova<span>EtherOS</span></strong>
            <small>{sys?.hostname ?? "home server"}</small>
          </div>
          <button className="icon-btn only-mobile" onClick={onClose} aria-label="Close menu"><Icon name="close" /></button>
        </div>

        <nav className="nav">
          {NAV.map((g) => (
            <div key={g.group || "main"} className="nav-group">
              {g.group && <div className="nav-title">{g.group}</div>}
              {g.items.map((item) => (
                <button
                  key={item.id}
                  className={`nav-item ${view === item.id ? "active" : ""} ${item.id === "bitcoin" ? "btc" : ""}`}
                  onClick={() => onChange(item.id)}
                >
                  <Icon name={item.icon} />
                  <span>{item.label}</span>
                  {item.id === "system" && update?.available && <span className="nav-badge" title="Update available" />}
                </button>
              ))}
            </div>
          ))}
        </nav>

        <div className="sidebar-foot">
          <div className="theme-switch" role="radiogroup" aria-label="Theme">
            {(["auto", "light", "dark"] as const).map((t) => (
              <button key={t} className={theme === t ? "on" : ""} onClick={() => setTheme(t)} title={`${t[0].toUpperCase()}${t.slice(1)} theme`}>
                <Icon name={t === "auto" ? "monitor" : t === "light" ? "sun" : "moon"} size={16} />
              </button>
            ))}
          </div>
          <small className="faint">{update?.current ? `Version ${update.current.sha}` : "NovaEtherOS"}</small>
        </div>
      </aside>
    </>
  );
}

function useClock() {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

export function TopBar({ view, onMenu, onNavigate }: { view: View; onMenu: () => void; onNavigate: (v: View) => void }) {
  const { data: btc } = usePoll(api.bitcoin, 10_000);
  const { data: pool } = usePoll(api.pool, 10_000);
  const { data: ai } = usePoll(api.ai, 20_000);
  const now = useClock();
  const info = viewInfo(view);

  const pct = btc ? syncPercent(btc) : 0;
  const nodeTone = !btc ? "idle" : btc.node.state === "running" ? "ok" : btc.node.state === "error" || btc.node.state === "waiting_for_storage" ? "bad" : btc.node.state === "not_installed" || btc.node.state === "stopped" ? "idle" : "busy";
  const nodeText = !btc ? "Node" : btc.node.state === "running" ? "Synced" : btc.node.state === "syncing" ? `Syncing ${pct.toFixed(1)}%` : btc.node.state.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
  const online = pool?.workers.filter((w) => w.connected).length ?? 0;
  const aiReady = Boolean(ai?.engine.reachable && ai.models.length);

  return (
    <header className="topbar">
      <button className="icon-btn only-mobile" onClick={onMenu} aria-label="Open menu"><Icon name="menu" /></button>
      <div className="topbar-title">
        <Icon name={info.icon} size={18} />
        <span>{info.label}</span>
      </div>
      <div className="chips">
        <button className="chip" onClick={() => onNavigate("bitcoin")} title="Bitcoin node">
          <span className={`dot ${nodeTone}`} /> {nodeText}
        </button>
        <button className="chip hide-sm" onClick={() => onNavigate("mining")} title="Solo pool">
          <span className={`dot ${online ? "ok" : "idle"}`} /> {pool ? `${formatHashrate(pool.hashrate)} · ${online} miner${online === 1 ? "" : "s"}` : "Pool"}
        </button>
        <button className="chip hide-sm" onClick={() => onNavigate("ai")} title="Nova AI">
          <span className={`dot ${aiReady ? "ok" : ai?.engine.reachable ? "busy" : "idle"}`} /> {aiReady ? "AI ready" : ai?.engine.reachable ? "AI: no model" : "AI off"}
        </button>
        <span className="clock">{now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
      </div>
    </header>
  );
}
