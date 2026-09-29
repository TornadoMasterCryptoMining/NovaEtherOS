export function Widget({
  label,
  value,
  percent,
  detail,
}: {
  label: string;
  value: string;
  percent?: number;
  detail?: string;
}) {
  return (
    <div className="widget glass">
      <div className="widget-label">{label}</div>
      <div className="widget-value">{value}</div>
      {detail && <div className="muted small">{detail}</div>}
      <div className="bar">
        <div style={{ width: `${Math.min(100, percent ?? 0)}%` }} />
      </div>
    </div>
  );
}
