import { useState } from "react";
import { Home } from "./components/Home";
import { AppStore } from "./components/AppStore";
import { Dock, type View } from "./components/Dock";

export default function App() {
  const [view, setView] = useState<View>("home");

  return (
    <div className="shell">
      <main className="content">
        {view === "home" && <Home onOpenStore={() => setView("store")} />}
        {view === "store" && <AppStore />}
      </main>
      <Dock view={view} onChange={setView} />
    </div>
  );
}
