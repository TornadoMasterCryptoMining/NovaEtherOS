export type View = "home" | "store";

const items: { id: View; label: string; icon: string }[] = [
  { id: "home", label: "Home", icon: "🏠" },
  { id: "store", label: "App Store", icon: "🛍️" },
];

export function Dock({ view, onChange }: { view: View; onChange: (v: View) => void }) {
  return (
    <nav className="dock glass">
      {items.map((item) => (
        <button
          key={item.id}
          className={`dock-item ${view === item.id ? "active" : ""}`}
          onClick={() => onChange(item.id)}
          title={item.label}
        >
          <span>{item.icon}</span>
        </button>
      ))}
    </nav>
  );
}
