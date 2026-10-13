export function Widget({
  label,
  value,
  percent,
  detail,
  tone,
}: {
  label: string;
  value: string;
  percent?: number;
  detail?: string;
  tone?: "ok" | "warn" | "bad";
}) {
  // Meters turn amber/red as they fill up, unless a tone is given.
  const auto = percent == null ? undefined : percent >= 90 ? "bad" : percent >= 75 ? "warn" : undefined;
  return (
    <div className="widget glass">
      <div className="widget-label">{label}</div>
      <div className="widget-value">{value}</div>
      {detail && <div className="muted small">{detail}</div>}
      {percent != null && (
        <div className={`bar ${tone ?? auto ?? ""}`}>
          <div style={{ width: `${Math.min(100, percent)}%` }} />
        </div>
      )}
    </div>
  );
}
