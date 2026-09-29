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
  bitcoinLogs: () => fetch("/api/bitcoin/logs").then((r) => r.text()),
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
