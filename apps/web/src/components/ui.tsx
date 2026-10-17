import type { ReactNode } from "react";
import { Icon } from "./Icons";

// Placeholder blocks shaped like the content that is loading.
export function Skeleton({ height = 16, width = "100%" }: { height?: number; width?: number | string }) {
  return <span className="skeleton" style={{ height, width }} aria-hidden />;
}

// A page whose first data hasn't arrived: real header, skeleton body.
export function PageLoading({ title, error }: { title: string; error?: string | null }) {
  return (
    <div>
      <header className="hero">
        <h1>{title}</h1>
      </header>
      {error ? (
        <ErrorNote message={error} />
      ) : (
        <div className="panels" aria-busy="true" aria-label={`Loading ${title}`}>
          {[0, 1].map((i) => (
            <section key={i} className="panel">
              <Skeleton width={120} height={12} />
              <Skeleton height={28} width="45%" />
              <Skeleton height={12} />
              <Skeleton height={12} width="80%" />
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

// The dashboard couldn't reach its own API. usePoll keeps retrying, so say so.
export function ErrorNote({ message }: { message: string }) {
  return (
    <div className="notice danger" role="alert">
      <Icon name="alert" size={16} />
      <div>
        <strong>Can't reach NovaEtherOS</strong>
        <p className="small">{message}. Retrying automatically.</p>
      </div>
    </div>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {children && <p className="small muted">{children}</p>}
      {action}
    </div>
  );
}

export function StatusDot({ tone, children }: { tone: "success" | "warning" | "danger" | "idle"; children: ReactNode }) {
  return (
    <span className={`status ${tone}`}>
      <span className="dot" aria-hidden />
      {children}
    </span>
  );
}

// Apps without an official logo get a neutral two-letter tile.
export function Monogram({ name, size = 40 }: { name: string; size?: number }) {
  const letters = name
    .replace(/[^A-Za-z0-9 -]/g, "")
    .split(/[\s-]+/)
    .filter(Boolean)
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  return (
    <span className="monogram" style={{ width: size, height: size }} aria-hidden>
      {letters.length === 2 ? letters : name.slice(0, 2).toUpperCase()}
    </span>
  );
}

// Pass / fail / pending mark for check lists.
export function CheckMark({ ok }: { ok: boolean | null }) {
  if (ok === null) return <span className="check-mark pending" aria-label="pending" />;
  return (
    <span className={`check-mark ${ok ? "pass" : "fail"}`} aria-label={ok ? "passed" : "failed"}>
      <Icon name={ok ? "check" : "x"} size={12} />
    </span>
  );
}
