import { useState } from "react";
import { Home } from "./components/Home";
import { AppStore } from "./components/AppStore";
import { Bitcoin } from "./components/Bitcoin";
import { Dock, type View } from "./components/Dock";

export default function App() {
  const [view, setView] = useState<View>("home");

  return (
    <div className="shell">
      <main className="content">
        {view === "home" && <Home onOpenStore={() => setView("store")} onOpenBitcoin={() => setView("bitcoin")} />}
        {view === "bitcoin" && <Bitcoin />}
        {view === "store" && <AppStore />}
      </main>
      <Dock view={view} onChange={setView} />
    </div>
  );
}
