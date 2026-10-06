import { useState } from "react";
import { Home } from "./components/Home";
import { AppStore } from "./components/AppStore";
import { Bitcoin } from "./components/Bitcoin";
import { Blocks } from "./components/Blocks";
import { Mining } from "./components/Mining";
import { Miners } from "./components/Miners";
import { System } from "./components/System";
import { Dock, type View } from "./components/Dock";

export default function App() {
  const [view, setView] = useState<View>("home");

  return (
    <div className="shell">
      <main className="content">
        {view === "home" && (
          <Home
            onOpenStore={() => setView("store")}
            onOpenBitcoin={() => setView("bitcoin")}
            onOpenSystem={() => setView("system")}
          />
        )}
        {view === "bitcoin" && <Bitcoin />}
        {view === "miners" && <Miners />}
        {view === "mining" && <Mining />}
        {view === "blocks" && <Blocks />}
        {view === "store" && <AppStore />}
        {view === "system" && <System />}
      </main>
      <Dock view={view} onChange={setView} />
    </div>
  );
}
