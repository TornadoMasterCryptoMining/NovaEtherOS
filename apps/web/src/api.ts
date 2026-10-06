export interface SystemStats {
  hostname: string;
  os: string;
  uptime: number;
  cpu: { load: number; temp: number | null };
  memory: { used: number; total: number };
  storage: { used: number; total: number } | null;
  battery: { percent: number; charging: boolean } | null;
}

export interface StoreApp {
  id: string;
  name: string;
  tagline: string;
  category: string;
  port: number;
  icon: string;
  installed: boolean;
}

export type StorageMode = "auto" | "full" | "prune";

export interface BitcoinSettings {
  storage_mode: StorageMode;
  prune_gb: number;
  reserve_gb: number | null;
  confirm_resync: boolean;
  dbcache_mb: number | null;
  txindex: boolean;
}

export interface BitcoinStatus {
  installed: boolean;
  node: {
    state: "not_installed" | "starting" | "syncing" | "running" | "waiting_for_storage" | "error" | "stopped";
    message: string;
    blocks?: number;
    headers?: number;
    progress?: number;
    ibd?: boolean;
    size_on_disk?: number;
    pruned?: boolean;
    peers?: number;
    peers_in?: number;
    peers_out?: number;
    version?: string;
    mempool_bytes?: number;
    mempool_tx?: number;
  };
  storage: {
    data_dir: string;
    scan: {
      disk_total: number;
      disk_free: number;
      bitcoin_used: number;
      ram: number;
      cpus: number;
      arch: string;
      model: string | null;
      rotational: boolean | null;
      datadir_pruned: boolean;
    } | null;
    plan: {
      status: "ok" | "insufficient";
      mode: "full" | "pruned";
      prune_mib: number;
      reasons: string[];
      budget_bytes: number;
      reserve_bytes: number;
      required_full_bytes: number;
      full_node_possible: boolean;
    } | null;
    applied: { mode: string; prune_mib: number; txindex: boolean } | null;
    restart_needed: boolean;
  };
  profile: { tier: string; dbcache: number; maxmempool: number; maxconnections: number } | null;
  settings: BitcoinSettings;
  connection: {
    host: string;
    rpc_port: number;
    p2p_port: number;
    rpc_user: string;
    rpc_pass: string;
    zmq: Record<string, number>;
  };
  events: { time: number; level: "info" | "error"; message: string }[];
}

export interface MiningCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface BlockSummary {
  height: number;
  hash: string;
  time: number;
  tx_count: number;
  size: number;
  weight: number;
  total_fee: number;
  subsidy: number;
  reward: number;
  median_feerate: number | null;
  feerate_range: [number, number] | null;
  pool: string;
  payout_address: string | null;
}

export interface ExplorerData {
  installed: boolean;
  blocks: BlockSummary[];
  next_block: {
    height: number;
    tx_count: number;
    weight: number;
    total_fee: number;
    subsidy: number;
    reward: number;
    feerate_min: number | null;
    feerate_median: number | null;
    feerate_max: number | null;
  } | null;
  next_block_error: string | null;
  mempool: {
    tx_count: number;
    vsize: number;
    usage: number;
    max_usage: number;
    total_fee: number;
    min_feerate: number;
    blocks_to_clear: number;
  } | null;
  fees: { next_block: number | null; half_hour: number | null; hour: number | null; day: number | null };
  updated_at: number;
}

export interface PoolStatus {
  host: string;
  ready: boolean;
  status: string;
  port: number;
  error: string | null;
  hashrate: number;
  workers: {
    name: string;
    address: string;
    connected: boolean;
    remote: string | null;
    difficulty: number | null;
    hashrate: number;
    accepted: number;
    rejected: number;
    best: number;
    last_share: number | null;
  }[];
  template: { height: number; reward: number; tx_count: number } | null;
  network_difficulty: number | null;
  expected_seconds: number | null;
  selftest: { ok: boolean; result: string | null; height: number; time: number } | null;
  found: {
    height: number;
    hash: string;
    worker: string;
    address: string;
    reward: number;
    time: number;
    accepted: boolean;
    result: string | null;
  }[];
  best_share: { difficulty: number; worker: string; time: number } | null;
  totals: { accepted: number; rejected: number };
}

export function formatHashrate(hs: number) {
  const units = ["H/s", "KH/s", "MH/s", "GH/s", "TH/s", "PH/s", "EH/s"];
  let i = 0;
  while (hs >= 1000 && i < units.length - 1) {
    hs /= 1000;
    i++;
  }
  return `${hs.toFixed(hs >= 100 || i === 0 ? 0 : 2)} ${units[i]}`;
}

export function formatDifficulty(d: number) {
  const units = ["", "K", "M", "G", "T", "P"];
  let i = 0;
  while (d >= 1000 && i < units.length - 1) {
    d /= 1000;
    i++;
  }
  return `${d.toFixed(d >= 100 || i === 0 ? (d < 10 ? 2 : 0) : 2)}${units[i]}`;
}

export function formatDuration(seconds: number) {
  const minute = 60, hour = 3600, day = 86400, year = 365.25 * day;
  if (seconds < hour) return `${Math.round(seconds / minute)} minutes`;
  if (seconds < day) return `${(seconds / hour).toFixed(1)} hours`;
  if (seconds < year) return `${Math.round(seconds / day)} days`;
  const years = seconds / year;
  return `${years < 1000 ? Math.round(years).toLocaleString() : formatDifficulty(years)} years`;
}

export function formatBTC(sats: number, digits = 8) {
  return `${(sats / 1e8).toFixed(digits)} BTC`;
}

export interface Commit {
  sha: string;
  date: string;
  message: string;
}

export interface UpdateStatus {
  current: Commit | null;
  latest: Commit | null;
  available: boolean;
  changes: Commit[];
  last_check: number;
  check_error: string | null;
  running: boolean;
  started_at: number;
  log: string;
  unsupported: string | null;
}

const post = (url: string, body?: unknown) =>
  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function json<T>(res: Response): Promise<T> {
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? res.statusText);
  return body;
}

export const api = {
  system: () => fetch("/api/system").then((r) => json<SystemStats>(r)),
  apps: () => fetch("/api/apps").then((r) => json<StoreApp[]>(r)),
  install: (id: string) => fetch(`/api/apps/${id}/install`, { method: "POST" }).then(json),
  uninstall: (id: string) => fetch(`/api/apps/${id}/uninstall`, { method: "POST" }).then(json),
  bitcoin: () => fetch("/api/bitcoin").then((r) => json<BitcoinStatus>(r)),
  bitcoinSettings: (s: Partial<BitcoinSettings>) => post("/api/bitcoin/settings", s).then((r) => json<BitcoinStatus>(r)),
  bitcoinRestart: () => post("/api/bitcoin/restart").then(json),
  bitcoinMiningCheck: () => fetch("/api/bitcoin/mining-check").then((r) => json<MiningCheck[]>(r)),
  pool: () => fetch("/api/pool").then((r) => json<PoolStatus>(r)),
  explorer: () => fetch("/api/bitcoin/explorer").then((r) => json<ExplorerData>(r)),
  bitcoinLogs: () => fetch("/api/bitcoin/logs").then((r) => r.text()),
  update: () => fetch("/api/update").then((r) => json<UpdateStatus>(r)),
  updateCheck: () => post("/api/update/check").then((r) => json<UpdateStatus>(r)),
  updateStart: () => post("/api/update").then(json),
};

export function formatGB(bytes: number, digits = 0) {
  return `${(bytes / 1e9).toFixed(digits)} GB`;
}

export function formatBytes(n: number) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i > 2 ? 1 : 0)} ${units[i]}`;
}
