import { useEffect, useState } from "react";
import {
  api,
  formatBTC,
  formatDifficulty,
  formatDuration,
  formatHashrate,
  type PoolStatus,
} from "../api";
import { usePoll } from "../usePoll";

const short = (addr: string) => (addr.length > 20 ? `${addr.slice(0, 10)}…${addr.slice(-6)}` : addr);

function ago(ms: number | null, now: number) {
  if (!ms) return "never";
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  return `${Math.floor(s / 3600)} h ago`;
}

function useNow(ms = 5000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export function Mining() {
  const { data: p, error } = usePoll(api.pool, 5000);
  const now = useNow();

  if (!p) {
    return (
      <div className="hero">
        <h1>Solo Mining</h1>
        <p className="muted">{error ?? "Loading…"}</p>
      </div>
    );
  }

  const online = p.workers.filter((w) => w.connected).length;

  return (
    <div className="mining">
      <header className="hero">
        <h1>Solo Mining</h1>
        <p className="muted">
          <span className={`pill ${p.ready ? "ok" : "busy"}`}>{p.ready ? "Mining" : "Waiting"}</span> {p.status}
        </p>
      </header>

      {p.found.some((b) => b.accepted) && (
        <div className="banner glass found-banner">
          <span>
            🎉 You found {p.found.filter((b) => b.accepted).length === 1 ? "a block" : `${p.found.filter((b) => b.accepted).length} blocks`}!
            Latest: block {p.found.find((b) => b.accepted)!.height.toLocaleString()} ·{" "}
            {formatBTC(p.found.find((b) => b.accepted)!.reward, 4)}
          </span>
        </div>
      )}

      <section className="widgets">
        <div className="widget glass">
          <div className="widget-label">Your hashrate</div>
          <div className="widget-value">{formatHashrate(p.hashrate)}</div>
          <div className="muted small">{online} miner{online === 1 ? "" : "s"} online</div>
        </div>
        <div className="widget glass">
          <div className="widget-label">Expected time to a block</div>
          <div className="widget-value">{p.expected_seconds ? formatDuration(p.expected_seconds) : "–"}</div>
          <div className="muted small">Solo mining is a lottery: any share can win</div>
        </div>
        <div className="widget glass">
          <div className="widget-label">Best share</div>
          <div className="widget-value">{p.best_share ? formatDifficulty(p.best_share.difficulty) : "–"}</div>
          <div className="muted small">
            {p.network_difficulty ? `Block needs ${formatDifficulty(p.network_difficulty)}` : " "}
          </div>
        </div>
        <div className="widget glass">
          <div className="widget-label">Next block reward</div>
          <div className="widget-value">{p.template ? formatBTC(p.template.reward, 3) : "–"}</div>
          <div className="muted small">{p.template ? `Block ${p.template.height.toLocaleString()} · all yours` : " "}</div>
        </div>
      </section>

      <div className="panels">
        <section className="panel glass">
          <h2>Connect your miner</h2>
          <p className="small muted">In your Bitaxe / NerdMiner / Antminer pool settings:</p>
          <dl className="facts mono">
            <dt>Pool address</dt>
            <dd>{p.host}</dd>
            <dt>Port</dt>
            <dd>{p.port}</dd>
            <dt>User</dt>
            <dd>&lt;your bitcoin address&gt;.&lt;worker name&gt;</dd>
            <dt>Password</dt>
            <dd>x</dd>
          </dl>
          <p className="small muted">
            Rewards go straight to the address in the user name. No pool fee. Tip: set a public solo pool (e.g.
            public-pool.io, port 21496) as the backup pool so mining continues while your node syncs or restarts.
          </p>
        </section>

        <section className="panel glass">
          <h2>Pool health</h2>
          <ul className="checks">
            <li className={p.ready ? "ok" : "bad"}>
              <strong>{p.ready ? "✓" : "…"} Work from your node</strong>
              <span className="small muted">
                {p.template ? `Building block ${p.template.height.toLocaleString()} with ${p.template.tx_count.toLocaleString()} transactions` : p.status}
              </span>
            </li>
            <li className={p.selftest ? (p.selftest.ok ? "ok" : "bad") : ""}>
              <strong>{p.selftest ? (p.selftest.ok ? "✓" : "✗") : "…"} Block format self-test</strong>
              <span className="small muted">
                {p.selftest
                  ? p.selftest.ok
                    ? `Bitcoin Core accepts blocks built by this pool (checked at height ${p.selftest.height.toLocaleString()})`
                    : `Bitcoin Core rejected a test block: ${p.selftest.result}. Found blocks may be lost; please report this.`
                  : "Runs automatically on every new block"}
              </span>
            </li>
            <li className="ok">
              <strong>
                Shares: {p.totals.accepted.toLocaleString()} accepted · {p.totals.rejected.toLocaleString()} rejected
              </strong>
            </li>
          </ul>
          {p.error && <p className="error small">{p.error}</p>}
        </section>

        <section className="panel glass wide">
          <h2>Miners</h2>
          {p.workers.length === 0 ? (
            <p className="small muted">No miners yet. Point a miner at {p.host}:{p.port} to start.</p>
          ) : (
            <div className="table-wrap">
              <table className="blocks-table">
                <thead>
                  <tr>
                    <th>Worker</th>
                    <th>Pays to</th>
                    <th>Hashrate</th>
                    <th>Difficulty</th>
                    <th>Best share</th>
                    <th>Shares</th>
                    <th>Last share</th>
                  </tr>
                </thead>
                <tbody>
                  {p.workers.map((w) => (
                    <tr key={`${w.address}.${w.name}`}>
                      <td>
                        <span className={`dot ${w.connected ? "on" : ""}`} /> {w.name}
                        {w.remote && <span className="muted small"> · {w.remote}</span>}
                      </td>
                      <td className="mono" title={w.address}>{short(w.address)}</td>
                      <td>{formatHashrate(w.hashrate)}</td>
                      <td>{w.difficulty != null ? formatDifficulty(w.difficulty) : "–"}</td>
                      <td>{formatDifficulty(w.best)}</td>
                      <td>
                        {w.accepted.toLocaleString()}
                        {w.rejected > 0 && <span className="muted small"> / {w.rejected} rejected</span>}
                      </td>
                      <td>{ago(w.last_share, now)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {p.found.length > 0 && <FoundBlocks found={p.found} />}
      </div>
    </div>
  );
}

function FoundBlocks({ found }: { found: PoolStatus["found"] }) {
  return (
    <section className="panel glass wide">
      <h2>Blocks found</h2>
      <ul className="events">
        {found.map((b) => (
          <li key={b.hash} className={b.accepted ? "" : "error"}>
            <strong>Block {b.height.toLocaleString()}</strong> · {b.worker} · {formatBTC(b.reward, 8)} to{" "}
            <span className="mono">{short(b.address)}</span> · {new Date(b.time).toLocaleString()} ·{" "}
            {b.accepted ? "accepted by the network ✓" : `rejected: ${b.result}`}
          </li>
        ))}
      </ul>
    </section>
  );
}
