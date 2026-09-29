import { useEffect, useState } from "react";
import { api, formatBTC, formatBytes, type BlockSummary, type ExplorerData } from "../api";
import { usePoll } from "../usePoll";

function timeAgo(unix: number, now: number) {
  const s = Math.max(0, Math.floor(now / 1000 - unix));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

const rate = (n: number) => (n < 10 ? n.toFixed(1) : String(Math.round(n)));
const satvb = (n: number | null | undefined) => (n == null ? "–" : `${rate(n)} sat/vB`);
const range = (lo: number | null, hi: number | null) => (lo == null || hi == null ? "" : `${rate(lo)} – ${rate(hi)} sat/vB`);
const fullness = (weight: number) => Math.min(100, (weight / 4_000_000) * 100);

// Re-render every 30 s so "x min ago" stays current.
function useNow() {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

export function Blocks() {
  const { data, error } = usePoll(api.explorer, 5000);
  const now = useNow();

  if (!data) {
    return (
      <div className="hero">
        <h1>Blocks & Mempool</h1>
        <p className="muted">{error ?? "Loading…"}</p>
      </div>
    );
  }

  const empty = data.blocks.length === 0;

  return (
    <div className="blocks-page">
      <header className="hero">
        <h1>Blocks & Mempool</h1>
        <p className="muted">Live from your own Bitcoin node</p>
      </header>

      {!data.installed && <p className="muted center">Bitcoin Core is not installed on this machine.</p>}
      {data.installed && empty && <p className="muted center">Waiting for Bitcoin Core to start…</p>}

      {!empty && (
        <div className="chain" role="list">
          <NextBlockCube data={data} />
          <div className="chain-divider" aria-hidden />
          {data.blocks.map((b) => (
            <BlockCube key={b.hash} block={b} now={now} />
          ))}
        </div>
      )}

      <div className="panels">
        <MempoolPanel data={data} />
        <FeesPanel data={data} />
        {!empty && <RecentBlocks blocks={data.blocks} now={now} />}
      </div>
    </div>
  );
}

function NextBlockCube({ data }: { data: ExplorerData }) {
  const n = data.next_block;
  return (
    <div className="cube next" role="listitem">
      <div className="cube-fill" style={{ height: `${n ? fullness(n.weight) : 0}%` }} />
      <div className="cube-body">
        <span className="cube-label">Next block</span>
        {n ? (
          <>
            <strong>~{satvb(n.feerate_median)}</strong>
            <span className="small">{range(n.feerate_min, n.feerate_max)}</span>
            <span className="small">{n.tx_count.toLocaleString()} txs</span>
            <span className="small muted-strong">In ~10 min</span>
            <span className="cube-reward">{formatBTC(n.reward, 3)}</span>
          </>
        ) : (
          <span className="small">{data.next_block_error ? "Available once synced" : "…"}</span>
        )}
      </div>
    </div>
  );
}

function BlockCube({ block: b, now }: { block: BlockSummary; now: number }) {
  return (
    <div className={`cube ${b.pool === "NovaEtherOS" ? "mine" : ""}`} role="listitem" title={b.hash}>
      <div className="cube-fill" style={{ height: `${fullness(b.weight)}%` }} />
      <div className="cube-body">
        <span className="cube-label">{b.height.toLocaleString()}</span>
        <strong>~{satvb(b.median_feerate)}</strong>
        {b.feerate_range && <span className="small">{range(b.feerate_range[0], b.feerate_range[1])}</span>}
        <span className="small">{b.tx_count.toLocaleString()} txs</span>
        <span className="small muted-strong">{timeAgo(b.time, now)}</span>
        <span className="cube-reward">{formatBTC(b.reward, 3)}</span>
      </div>
      <span className="cube-foot small" title={b.pool}>
        {b.pool === "NovaEtherOS" ? "⛏️ Your block!" : b.pool}
      </span>
    </div>
  );
}

function MempoolPanel({ data }: { data: ExplorerData }) {
  const m = data.mempool;
  return (
    <section className="panel glass">
      <h2>Mempool</h2>
      {!m ? (
        <p className="small muted">Waiting for data…</p>
      ) : (
        <>
          <p className="big">{m.tx_count.toLocaleString()} unconfirmed</p>
          <dl className="facts">
            <dt>Size</dt>
            <dd>
              {(m.vsize / 1e6).toFixed(2)} vMB · about {m.blocks_to_clear} block{m.blocks_to_clear === 1 ? "" : "s"} worth
            </dd>
            <dt>Waiting fees</dt>
            <dd>{formatBTC(m.total_fee, 4)}</dd>
            <dt>Lowest fee accepted</dt>
            <dd>{satvb(m.min_feerate)}</dd>
            <dt>Memory</dt>
            <dd>
              {formatBytes(m.usage)} of {formatBytes(m.max_usage)}
            </dd>
          </dl>
          <div className="bar">
            <div style={{ width: `${Math.min(100, (m.usage / m.max_usage) * 100)}%` }} />
          </div>
        </>
      )}
    </section>
  );
}

function FeesPanel({ data }: { data: ExplorerData }) {
  const f = data.fees;
  const tiles: [string, number | null][] = [
    ["Next block", f.next_block],
    ["~30 min", f.half_hour],
    ["~1 hour", f.hour],
    ["~1 day", f.day],
  ];
  return (
    <section className="panel glass">
      <h2>Fee estimates</h2>
      <p className="small muted">What senders are paying miners to get confirmed. These fees go to whoever mines the block.</p>
      <div className="fee-tiles">
        {tiles.map(([label, v]) => (
          <div key={label} className="fee-tile">
            <span className="widget-label">{label}</span>
            <strong>{satvb(v)}</strong>
          </div>
        ))}
      </div>
    </section>
  );
}

function RecentBlocks({ blocks, now }: { blocks: BlockSummary[]; now: number }) {
  return (
    <section className="panel glass wide">
      <h2>Recent blocks</h2>
      <div className="table-wrap">
        <table className="blocks-table">
          <thead>
            <tr>
              <th>Height</th>
              <th>Mined</th>
              <th>Pool</th>
              <th>Txs</th>
              <th>Size</th>
              <th>Fees</th>
              <th>Reward</th>
            </tr>
          </thead>
          <tbody>
            {blocks.map((b) => (
              <tr key={b.hash}>
                <td className="mono">{b.height.toLocaleString()}</td>
                <td>{timeAgo(b.time, now)}</td>
                <td>{b.pool}</td>
                <td>{b.tx_count.toLocaleString()}</td>
                <td>{b.size ? `${(b.size / 1e6).toFixed(2)} MB` : "–"}</td>
                <td>{formatBTC(b.total_fee, 4)}</td>
                <td>{formatBTC(b.reward, 4)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
