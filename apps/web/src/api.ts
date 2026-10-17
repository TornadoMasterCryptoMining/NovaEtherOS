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
  path?: string; // web UI path, e.g. /admin/ for Pi-hole
  installed: boolean;
}

export interface AppLogin {
  user: string | null;
  hint: string | null;
  secrets: { label: string; value: string | null }[];
  can_reset: boolean;
  needs_reset: boolean;
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

export interface MinerStats {
  hostname: string | null;
  nickname: string | null;
  model: string | null;
  asic: string | null;
  firmware: string | null;
  version: string | null;
  state: string | null;
  hashrate: number;
  hashrate_1h: number | null;
  power: number;
  efficiency: number | null;
  temp: number | null;
  vr_temp: number | null;
  frequency: number | null;
  core_voltage: number | null;
  core_voltage_actual: number | null;
  fan_percent: number | null;
  fan_rpm: number | null;
  auto_fan: boolean;
  manual_fan: number | null;
  temp_target: number | null;
  overheat: boolean;
  shares_accepted: number | null;
  shares_rejected: number | null;
  best_diff: number | null;
  best_session_diff: number | null;
  found_blocks: number;
  uptime: number | null;
  wifi_rssi: number | null;
  pool: {
    url: string | null;
    port: number | null;
    user: string | null;
    connected: boolean | null;
    using_fallback: boolean;
    fallback_url: string | null;
    fallback_port: number | null;
  };
  locked: boolean;
}

export interface MinersStatus {
  miners: {
    id: string;
    ip: string;
    online: boolean;
    last_seen: number | null;
    error: string | null;
    stats: MinerStats | null;
    active_pool: { url: string | null; port: number | null } | null;
    on_nova_pool: boolean; // mining to your pool right now
    nova_pool_primary: boolean;
    nova_pool_backup: boolean;
    stranded: boolean; // your pool is its main pool, but it's on its backup
    reconnect_at: number | null;
  }[];
  totals: { hashrate: number; power: number; online: number };
  history: { t: number; hashrate: number; power: number; online: number }[]; // one sample a minute, last 24 h
  scanning: boolean;
  scan_progress: { done: number; total: number };
  last_scan: number | null;
  auto_reconnect: boolean;
  limits: Record<"frequency" | "coreVoltage" | "manualFanSpeed" | "temptarget", { min: number; max: number }>;
}

export interface MinerSettings {
  frequency?: number;
  coreVoltage?: number;
  autofanspeed?: boolean;
  manualFanSpeed?: number;
  temptarget?: number;
}

export interface Drive {
  path: string;
  model: string;
  size: number;
  transport: string | null;
  removable: boolean;
  system: boolean;
  empty: boolean;
  bitcoin: boolean;
  partitions: {
    path: string;
    size: number;
    fstype: string | null;
    label: string | null;
    mountpoints: string[];
    free: number | null;
    total: number | null;
  }[];
}

export interface StorageStatus {
  supported: boolean;
  data_dir: string;
  drives: Drive[];
  error: string | null;
  job: { running: boolean; device: string | null; started_at: number; log: string };
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

export interface AISettings {
  ollama_url: string | null;
  default_model: string | null;
  num_ctx: number;
  auto_approve: boolean;
  thinking: "auto" | "on" | "off";
  instructions: string;
}

export interface AIStatus {
  engine: { url: string; local: boolean; installed: boolean | null; reachable: boolean; version: string | null; can_install: boolean };
  install_job: { running: boolean; started_at: number; log: string };
  hardware: { ram: number; free_ram: number; cpus: number; arch: string };
  models: { name: string; size: number; modified_at: string; parameter_size: string | null; quantization: string | null; loaded: boolean }[];
  catalog: { name: string; label: string; size: number; tools: boolean; note: string; installed: boolean; fits: boolean | null }[];
  pulls: Record<string, { status: string; total: number; completed: number; error: string | null }>;
  settings: AISettings;
  workspace: string;
  sandboxed: boolean;
}

export interface AIMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  thinking?: string;
  tool_calls?: { function: { name: string; arguments: Record<string, unknown> } }[];
  tool_name?: string;
  args?: Record<string, unknown>;
  note?: boolean;
  error?: boolean;
  stats?: { tokens: number; seconds: number };
  at: number;
}

export interface AIChatSummary {
  id: string;
  title: string;
  model: string;
  mode: "agent" | "chat";
  updated_at: number;
  running: boolean;
}

export interface AIChat extends AIChatSummary {
  created_at: number;
  messages: AIMessage[];
  status: string | null;
  live: { content: string; thinking: string } | null;
  pending: { name: string; args: Record<string, unknown> } | null;
}

export interface TextEndpoint {
  slug: string;
  name: string;
  description: string;
  model: string | null;
  instructions: string;
  template: string;
  json: boolean;
  temperature: number;
  created_at: number;
  calls: number;
  last_used: number | null;
  variables: string[];
}

export type EndpointDraft = Partial<Omit<TextEndpoint, "variables">>;

export interface TextApiStatus {
  keys: { id: string; name: string; hint: string; created_at: number; last_used: number | null; calls: number }[];
  endpoints: TextEndpoint[];
  starters: EndpointDraft[];
}

export interface TextResult {
  endpoint: string;
  model: string;
  output: string;
  data?: unknown;
  tokens: number;
  seconds: number;
}

export interface WorkspaceListing {
  path: string;
  entries: { name: string; dir: boolean; size: number; mtime: number }[];
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
  appLogin: (id: string) => fetch(`/api/apps/${id}/login`).then((r) => json<AppLogin>(r)),
  appLoginReset: (id: string) => post(`/api/apps/${id}/login/reset`).then((r) => json<AppLogin>(r)),
  appLogs: (id: string) => fetch(`/api/apps/${id}/logs`).then((r) => json<{ logs: string }>(r)),
  bitcoin: () => fetch("/api/bitcoin").then((r) => json<BitcoinStatus>(r)),
  bitcoinSettings: (s: Partial<BitcoinSettings>) => post("/api/bitcoin/settings", s).then((r) => json<BitcoinStatus>(r)),
  bitcoinRestart: () => post("/api/bitcoin/restart").then(json),
  bitcoinMiningCheck: () => fetch("/api/bitcoin/mining-check").then((r) => json<MiningCheck[]>(r)),
  pool: () => fetch("/api/pool").then((r) => json<PoolStatus>(r)),
  explorer: () => fetch("/api/bitcoin/explorer").then((r) => json<ExplorerData>(r)),
  bitcoinLogs: () => fetch("/api/bitcoin/logs").then((r) => r.text()),
  miners: () => fetch("/api/miners").then((r) => json<MinersStatus>(r)),
  minersScan: () => post("/api/miners/scan").then(json),
  minersAutoReconnect: (enabled: boolean) => post("/api/miners/auto-reconnect", { enabled }).then(json),
  minerAdd: (ip: string) => post("/api/miners", { ip }).then(json),
  minerRemove: (id: string) => fetch(`/api/miners/${encodeURIComponent(id)}`, { method: "DELETE" }).then(json),
  minerSettings: (id: string, s: MinerSettings) =>
    post(`/api/miners/${encodeURIComponent(id)}/settings`, s).then((r) => json<{ restarted: boolean }>(r)),
  minerRestart: (id: string) => post(`/api/miners/${encodeURIComponent(id)}/restart`).then(json),
  storage: () => fetch("/api/storage").then((r) => json<StorageStatus>(r)),
  useForBitcoin: (device: string, confirm: string, deleteOld: boolean) =>
    post("/api/storage/use-for-bitcoin", { device, confirm, deleteOld }).then(json),
  update: () => fetch("/api/update").then((r) => json<UpdateStatus>(r)),
  updateCheck: () => post("/api/update/check").then((r) => json<UpdateStatus>(r)),
  updateStart: () => post("/api/update").then(json),
  ai: () => fetch("/api/ai").then((r) => json<AIStatus>(r)),
  aiSettings: (s: Partial<AISettings>) => post("/api/ai/settings", s).then((r) => json<AISettings>(r)),
  aiInstall: () => post("/api/ai/install").then(json),
  aiPull: (name: string) => post("/api/ai/models/pull", { name }).then(json),
  aiCancelPull: (name: string) => post("/api/ai/models/cancel", { name }).then(json),
  aiRemoveModel: (name: string) => post("/api/ai/models/remove", { name }).then(json),
  aiChats: () => fetch("/api/ai/chats").then((r) => json<AIChatSummary[]>(r)),
  aiNewChat: (model?: string, mode?: string) => post("/api/ai/chats", { model, mode }).then((r) => json<AIChat>(r)),
  aiChat: (id: string) => fetch(`/api/ai/chats/${id}`).then((r) => json<AIChat>(r)),
  aiDeleteChat: (id: string) => fetch(`/api/ai/chats/${id}`, { method: "DELETE" }).then(json),
  aiSend: (id: string, content: string, model: string, mode: string) =>
    post(`/api/ai/chats/${id}/messages`, { content, model, mode }).then((r) => json<AIChat>(r)),
  aiStop: (id: string) => post(`/api/ai/chats/${id}/stop`).then(json),
  aiApprove: (id: string, approve: boolean) => post(`/api/ai/chats/${id}/approve`, { approve }).then(json),
  textApi: () => fetch("/api/ai/api").then((r) => json<TextApiStatus>(r)),
  textApiKey: (name: string) => post("/api/ai/api/keys", { name }).then((r) => json<{ id: string; key: string }>(r)),
  textApiRevoke: (id: string) => fetch(`/api/ai/api/keys/${id}`, { method: "DELETE" }).then(json),
  textApiSave: (e: EndpointDraft, original?: string) =>
    post("/api/ai/api/endpoints", { ...e, original }).then((r) => json<TextEndpoint>(r)),
  textApiDelete: (slug: string) => fetch(`/api/ai/api/endpoints/${slug}`, { method: "DELETE" }).then(json),
  textApiTest: (slug: string, input: Record<string, string>) =>
    post(`/api/ai/api/endpoints/${slug}/test`, input).then((r) => json<TextResult>(r)),
  aiWorkspace: (p: string) => fetch(`/api/ai/workspace?path=${encodeURIComponent(p)}`).then((r) => json<WorkspaceListing>(r)),
  aiWorkspaceFile: (p: string) =>
    fetch(`/api/ai/workspace/file?path=${encodeURIComponent(p)}`).then((r) => json<{ content: string }>(r)),
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
