export type View = "home" | "bitcoin" | "blocks" | "store" | "system";

const items: { id: View; label: string; icon: string }[] = [
  { id: "home", label: "Home", icon: "🏠" },
  { id: "bitcoin", label: "Bitcoin Node", icon: "₿" },
  { id: "blocks", label: "Blocks & Mempool", icon: "🧊" },
  { id: "store", label: "App Store", icon: "🛍️" },
  { id: "system", label: "Settings", icon: "⚙️" },
];

export function Dock({ view, onChange }: { view: View; onChange: (v: View) => void }) {
  return (
    <nav className="dock glass">
      {items.map((item) => (
        <button
          key={item.id}
          className={`dock-item ${view === item.id ? "active" : ""} ${item.id === "bitcoin" ? "btc" : ""}`}
          onClick={() => onChange(item.id)}
          title={item.label}
        >
          <span>{item.icon}</span>
        </button>
      ))}
    </nav>
  );
}
