// Blocks & Mempool: a lightweight block explorer fed only by our own Bitcoin
// Core over RPC. Works on a pruned node (recent blocks are always kept) and
// needs no txindex, database or Electrum server.

import { RPC } from "./rpc.js";

const RECENT_BLOCKS = 15;
const TIP_POLL_MS = 5_000;
const MEMPOOL_POLL_MS = 15_000;

// Coinbase tags of well-known pools (matched case-insensitively).
const POOL_TAGS: [string, string][] = [
  ["Foundry USA", "Foundry USA"],
  ["AntPool", "AntPool"],
  ["ViaBTC", "ViaBTC"],
  ["F2Pool", "F2Pool"],
  ["七彩神仙鱼", "F2Pool"],
  ["SpiderPool", "SpiderPool"],
  ["MARA Pool", "MARA Pool"],
  ["MARA Made in USA", "MARA Pool"],
  ["Luxor", "Luxor"],
  ["Binance", "Binance Pool"],
  ["SBICrypto", "SBI Crypto"],
  ["SBI Crypto", "SBI Crypto"],
  ["Braiins", "Braiins Pool"],
  ["slush", "Braiins Pool"],
  ["Poolin", "Poolin"],
  ["BTC.com", "BTC.com"],
  ["OCEAN", "OCEAN"],
  ["SECPOOL", "SECPOOL"],
  ["Mining-Dutch", "Mining-Dutch"],
  ["WhitePool", "WhitePool"],
  ["ckpool", "Solo CK"],
  ["Public Pool", "Public Pool (solo)"],
  ["Nova Solo Pool", "Nova Solo Pool"],
  // Blocks found by this machine's built-in solo pool.
  ["/NovaEtherOS/", "NovaEtherOS"],
];

export interface BlockSummary {
  height: number;
  hash: string;
  previous: string | null;
  time: number;
  tx_count: number;
  size: number;
  weight: number;
  total_fee: number; // sats
  subsidy: number; // sats
  reward: number; // sats
  median_feerate: number | null; // sat/vB
  feerate_range: [number, number] | null; // 10th-90th percentile, sat/vB
  pool: string;
  payout_address: string | null;
}

export interface NextBlock {
  height: number;
  tx_count: number;
  weight: number;
  total_fee: number;
  subsidy: number;
  reward: number;
  feerate_min: number | null;
  feerate_median: number | null;
  feerate_max: number | null;
}

export interface MempoolSummary {
  tx_count: number;
  vsize: number; // total virtual size, vB
  usage: number; // memory, bytes
  max_usage: number;
  total_fee: number; // sats
  min_feerate: number; // sat/vB to get into this node's mempool
  blocks_to_clear: number; // roughly how many blocks' worth are waiting
}

export interface FeeEstimates {
  next_block: number | null;
  half_hour: number | null;
  hour: number | null;
  day: number | null;
}

const BTC = 1e8;

export function blockSubsidy(height: number) {
  const halvings = Math.floor(height / 210_000);
  return halvings >= 64 ? 0 : Math.floor((50 * BTC) / 2 ** halvings);
}

export function identifyPool(coinbaseHex: string): string {
  const text = Buffer.from(coinbaseHex, "hex").toString("utf8");
  const lower = text.toLowerCase();
  for (const [tag, name] of POOL_TAGS) {
    if (lower.includes(tag.toLowerCase())) return name;
  }
  return "Unknown";
}

function median(sorted: number[]) {
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export class Explorer {
  private cache = new Map<string, BlockSummary>();
  private tip: string | null = null;
  private blocks: BlockSummary[] = [];
  private nextBlock: NextBlock | null = null;
  private nextBlockError: string | null = null;
  private mempool: MempoolSummary | null = null;
  private fees: FeeEstimates = { next_block: null, half_hour: null, hour: null, day: null };
  private updatedAt = 0;
  private timers: NodeJS.Timeout[] = [];

  constructor(private rpc: RPC) {}

  start() {
    const safely = (fn: () => Promise<void>) => () => void fn().catch(() => undefined);
    safely(() => this.refreshTip())();
    safely(() => this.refreshMempool())();
    this.timers.push(setInterval(safely(() => this.refreshTip()), TIP_POLL_MS));
    this.timers.push(setInterval(safely(() => this.refreshMempool()), MEMPOOL_POLL_MS));
  }

  stop() {
    this.timers.forEach(clearInterval);
    this.timers = [];
  }

  // --- blocks ----------------------------------------------------------------

  private async refreshTip() {
    const best: string = await this.rpc.call("getbestblockhash");
    if (best === this.tip) return;

    // Walk back from the new tip; only blocks we haven't seen cost RPC calls.
    // Rebuilding from the tip each time also handles chain reorganisations.
    const chain: BlockSummary[] = [];
    let hash: string | null = best;
    while (hash && chain.length < RECENT_BLOCKS) {
      const block: BlockSummary = this.cache.get(hash) ?? (await this.loadBlock(hash));
      this.cache.set(hash, block);
      chain.push(block);
      hash = block.previous;
    }

    this.blocks = chain;
    this.tip = best;
    this.updatedAt = Date.now();
    // Forget blocks that are no longer in the recent chain.
    const keep = new Set(chain.map((b) => b.hash));
    for (const h of this.cache.keys()) if (!keep.has(h)) this.cache.delete(h);

    // A new block changes the template and mempool right away.
    void this.refreshMempool().catch(() => undefined);
  }

  private async loadBlock(hash: string): Promise<BlockSummary> {
    const header = await this.rpc.call("getblockheader", [hash]);
    const base: BlockSummary = {
      height: header.height,
      hash,
      previous: header.previousblockhash ?? null,
      time: header.time,
      tx_count: header.nTx,
      size: 0,
      weight: 0,
      total_fee: 0,
      subsidy: blockSubsidy(header.height),
      reward: blockSubsidy(header.height),
      median_feerate: null,
      feerate_range: null,
      pool: "Unknown",
      payout_address: null,
    };

    try {
      const stats = await this.rpc.call("getblockstats", [
        hash,
        ["total_size", "total_weight", "totalfee", "subsidy", "feerate_percentiles"],
      ]);
      const p: number[] = stats.feerate_percentiles ?? [];
      Object.assign(base, {
        size: stats.total_size,
        weight: stats.total_weight,
        total_fee: stats.totalfee,
        subsidy: stats.subsidy,
        reward: stats.subsidy + stats.totalfee,
        median_feerate: p.length === 5 ? p[2] : null,
        feerate_range: p.length === 5 ? [p[0], p[4]] : null,
      });
    } catch {
      // Block data pruned or still downloading; header info is enough.
    }

    try {
      const block = await this.rpc.call("getblock", [hash, 1]);
      const coinbase = await this.rpc.call("getrawtransaction", [block.tx[0], true, hash]);
      base.pool = identifyPool(coinbase.vin[0]?.coinbase ?? "");
      const payout = coinbase.vout.find((o: any) => o.value > 0 && o.scriptPubKey?.address);
      base.payout_address = payout?.scriptPubKey.address ?? null;
      if (!base.size) {
        base.size = block.size;
        base.weight = block.weight;
      }
    } catch {
      // Pruned block: pool unknown.
    }
    return base;
  }

  // --- mempool, next block, fees ---------------------------------------------

  private async refreshMempool() {
    const info = await this.rpc.call("getmempoolinfo");
    this.mempool = {
      tx_count: info.size,
      vsize: info.bytes,
      usage: info.usage,
      max_usage: info.maxmempool,
      total_fee: Math.round((info.total_fee ?? 0) * BTC),
      min_feerate: round1((info.mempoolminfee ?? 0) * 1e5),
      // A block holds ~1,000,000 vB.
      blocks_to_clear: Math.ceil(info.bytes / 1_000_000),
    };

    try {
      const t = await this.rpc.call("getblocktemplate", [{ rules: ["segwit"] }], 20_000);
      const rates = (t.transactions as { fee: number; weight: number }[])
        .map((tx) => tx.fee / (tx.weight / 4))
        .sort((a, b) => a - b);
      const subsidy = blockSubsidy(t.height);
      this.nextBlock = {
        height: t.height,
        tx_count: t.transactions.length,
        weight: t.transactions.reduce((sum: number, tx: { weight: number }) => sum + tx.weight, 0),
        total_fee: t.coinbasevalue - subsidy,
        subsidy,
        reward: t.coinbasevalue,
        feerate_min: rates.length ? round1(rates[0]) : null,
        feerate_median: rates.length ? round1(median(rates)!) : null,
        feerate_max: rates.length ? round1(rates[rates.length - 1]) : null,
      };
      this.nextBlockError = null;
    } catch (err) {
      this.nextBlock = null;
      this.nextBlockError = (err as Error).message;
    }

    const estimate = async (blocks: number) => {
      try {
        const r = await this.rpc.call("estimatesmartfee", [blocks]);
        return r.feerate ? round1(r.feerate * 1e5) : null;
      } catch {
        return null;
      }
    };
    const [next_block, half_hour, hour, day] = await Promise.all([estimate(1), estimate(3), estimate(6), estimate(144)]);
    this.fees = { next_block, half_hour, hour, day };
    this.updatedAt = Date.now();
  }

  snapshot() {
    return {
      blocks: this.blocks,
      next_block: this.nextBlock,
      next_block_error: this.nextBlockError,
      mempool: this.mempool,
      fees: this.fees,
      updated_at: this.updatedAt,
    };
  }
}
