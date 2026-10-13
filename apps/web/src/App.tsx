import { useEffect, useState } from "react";
import { Home } from "./components/Home";
import { AppStore } from "./components/AppStore";
import { Bitcoin } from "./components/Bitcoin";
import { Blocks } from "./components/Blocks";
import { Mining } from "./components/Mining";
import { Miners } from "./components/Miners";
import { System } from "./components/System";
import { NovaAI } from "./components/NovaAI";
import { NAV, Sidebar, TopBar, type View } from "./components/Shell";

const VIEWS = new Set<string>(NAV.flatMap((g) => g.items.map((i) => i.id)));
const fromHash = (): View => {
  const h = location.hash.replace(/^#\/?/, "");
  return (VIEWS.has(h) ? h : "home") as View;
};

export default function App() {
  // The page lives in the URL (#/miners), so reloads and the back button work.
  const [view, setView] = useState<View>(fromHash);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    const onHash = () => setView(fromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const go = (v: View) => {
    setMenuOpen(false);
    if (v !== view) {
      location.hash = `/${v}`;
      window.scrollTo({ top: 0 });
    }
  };

  return (
    <div className="shell">
      <Sidebar view={view} open={menuOpen} onChange={go} onClose={() => setMenuOpen(false)} />
      <div className="main">
        <TopBar view={view} onMenu={() => setMenuOpen(true)} onNavigate={go} />
        <main className={`content view-${view}`}>
          {view === "home" && <Home onNavigate={go} />}
          {view === "bitcoin" && <Bitcoin />}
          {view === "miners" && <Miners />}
          {view === "mining" && <Mining />}
          {view === "blocks" && <Blocks />}
          {view === "ai" && <NovaAI />}
          {view === "store" && <AppStore />}
          {view === "system" && <System />}
        </main>
      </div>
    </div>
  );
}
