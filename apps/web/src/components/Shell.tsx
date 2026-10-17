import { useEffect, useState } from "react";
import { api, formatHashrate } from "../api";
import { usePoll } from "../usePoll";
import { syncPercent } from "./Bitcoin";
import { Icon, Logo, type IconName } from "./Icons";
import { StatusDot } from "./ui";

export type View = "home" | "bitcoin" | "blocks" | "mining" | "miners" | "ai" | "store" | "system";

export const NAV: { id: View; label: string; icon: IconName }[] = [
  { id: "home", label: "Overview", icon: "home" },
  { id: "bitcoin", label: "Node", icon: "bitcoin" },
  { id: "blocks", label: "Blocks", icon: "blocks" },
  { id: "mining", label: "Pool", icon: "pickaxe" },
  { id: "miners", label: "Miners", icon: "chip" },
  { id: "ai", label: "Nova AI", icon: "sparkles" },
  { id: "store", label: "Apps", icon: "apps" },
  { id: "system", label: "Settings", icon: "settings" },
];

type Theme = "auto" | "light" | "dark";
const THEME_ORDER: Theme[] = ["auto", "dark", "light"];

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
      // storage blocked: the theme still applies for this visit
    }
  }, [theme]);
  return [theme, setTheme] as const;
}

function useNow(ms: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

const BLOCK_SECONDS = 600;

// The header's clock is the chain tip of the owner's own node: block height,
// minutes since that block, and a hairline that fills over the average 10 minutes.
function ChainTip({ onOpen }: { onOpen: () => void }) {
  const { data } = usePoll(api.explorer, 15_000);
  const now = useNow(5_000);
  const tip = data?.blocks[0];
  const elapsed = tip ? Math.max(0, now / 1000 - tip.time) : 0;
  const minutes = Math.floor(elapsed / 60);
  return (
    <>
      <button className={`chain-tip ${tip ? "" : "idle"}`} onClick={onOpen} title={tip ? `Latest block from your node, ${minutes} min ago` : "Waiting for your node"}>
        <span className="mono-label">Block</span>
        <span className="num">{tip ? tip.height.toLocaleString() : "—"}</span>
        {tip && <span className="faint num">{minutes < 1 ? "now" : `${minutes}m`}</span>}
      </button>
      <span className="tip-line" aria-hidden style={{ transform: `scaleX(${tip ? Math.min(1, elapsed / BLOCK_SECONDS) : 0})` }} />
    </>
  );
}

export function Header({ view, onNavigate }: { view: View; onNavigate: (v: View) => void }) {
  const [theme, setTheme] = useTheme();
  const { data: btc } = usePoll(api.bitcoin, 10_000);
  const { data: miners } = usePoll(api.miners, 10_000);
  const { data: update } = usePoll(api.update, 300_000);

  const state = btc?.node.state;
  const nodeTone = !btc ? "idle" : state === "running" ? "success" : state === "error" || state === "waiting_for_storage" ? "danger" : state === "not_installed" || state === "stopped" ? "idle" : "warning";
  const nodeText = !btc ? "Node" : state === "running" ? "Synced" : state === "syncing" ? `Syncing ${syncPercent(btc).toFixed(1)}%` : state!.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
  const nextTheme = THEME_ORDER[(THEME_ORDER.indexOf(theme) + 1) % THEME_ORDER.length];

  return (
    <header className="header">
      <div className="header-row">
        <button className="brand" onClick={() => onNavigate("home")} aria-label="NovaEtherOS overview">
          <Logo size={24} />
          <strong>NovaEtherOS</strong>
        </button>
        <div className="header-status">
          <button className="chip" onClick={() => onNavigate("bitcoin")}>
            <StatusDot tone={nodeTone}>{nodeText}</StatusDot>
          </button>
          <button className="chip hide-sm" onClick={() => onNavigate("miners")}>
            <StatusDot tone={miners?.totals.online ? "success" : "idle"}>
              <span className="num">{miners ? formatHashrate(miners.totals.hashrate) : "Miners"}</span>
            </StatusDot>
          </button>
          <ChainTip onOpen={() => onNavigate("blocks")} />
          <button className="icon-btn" onClick={() => setTheme(nextTheme)} aria-label={`Theme: ${theme}. Switch to ${nextTheme}`} title={`Theme: ${theme}`}>
            <Icon name={theme === "auto" ? "monitor" : theme === "dark" ? "moon" : "sun"} size={16} />
          </button>
        </div>
      </div>
      <nav className="tabbar" aria-label="Main">
        {NAV.map((item) => (
          <button
            key={item.id}
            className={view === item.id ? "on" : ""}
            aria-current={view === item.id ? "page" : undefined}
            onClick={() => onNavigate(item.id)}
          >
            <Icon name={item.icon} size={16} />
            {item.label}
            {item.id === "system" && update?.available && <span className="tab-dot" aria-label="update available" />}
          </button>
        ))}
      </nav>
    </header>
  );
}
