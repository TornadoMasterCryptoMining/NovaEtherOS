// Smart Storage: hardware scan and automatic prune planning.
// Ported from NovaMiningShop's nova/storage.py. Everything except scanHardware
// is a pure function of its inputs so the decisions are easy to test.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const GB = 1000 ** 3;
export const MIB = 1024 ** 2;

// Bitcoin Core refuses automatic prune targets below 550 MiB.
export const MIN_PRUNE_MIB = 550;

// Space kept aside for the chainstate (~12 GB in 2026 and growing), wallets,
// mempool.dat, peers.dat and Bitcoin Core's own disk-space checks. None of
// this is covered by the prune target, which only limits blk/rev files.
const CHAINSTATE_ALLOWANCE_BYTES = 20 * GB;

// A full mainnet node needs ~760 GB in late 2026 and grows 60-80 GB a year.
// Once a full node has synced, the observed size replaces this estimate.
const DEFAULT_FULL_NODE_BYTES = Number(process.env.NOVA_FULL_NODE_GB ?? 900) * GB;
const FULL_NODE_GROWTH_HEADROOM_BYTES = 150 * GB;

// Only use this share of the space left for block files, so the OS and other
// apps can grow a little without immediately forcing a re-plan.
const PRUNE_SAFETY_FACTOR = 0.85;

// The storage guard re-plans when free space drops below this share of the reserve.
const CRITICAL_RESERVE_FRACTION = 0.5;

export interface HardwareScan {
  disk_total: number;
  disk_free: number;
  bitcoin_used: number;
  blocks_bytes: number;
  chainstate_bytes: number;
  datadir_pruned: boolean;
  has_chain: boolean;
  ram: number;
  cpus: number;
  arch: string;
  model: string | null;
  rotational: boolean | null;
}

export interface StorageSettings {
  storage_mode: "auto" | "full" | "prune";
  prune_gb: number;
  reserve_gb: number | null;
  confirm_resync: boolean;
  dbcache_mb: number | null;
  txindex: boolean;
}

export const DEFAULT_SETTINGS: StorageSettings = {
  storage_mode: "auto",
  prune_gb: 50,
  reserve_gb: null,
  confirm_resync: false,
  dbcache_mb: null,
  txindex: false,
};

export interface StorageState {
  observed_full_size?: number;
  ibd_complete?: boolean;
}

export interface StoragePlan {
  status: "ok" | "insufficient";
  mode: "full" | "pruned";
  prune_mib: number;
  reindex: boolean;
  reasons: string[];
  budget_bytes: number;
  reserve_bytes: number;
  required_full_bytes: number;
  minimum_bytes: number;
  full_node_possible: boolean;
}

export interface PerformanceProfile {
  tier: string;
  dbcache: number;
  maxmempool: number;
  maxconnections: number;
  maxuploadtarget: number;
}

async function readFirstLine(file: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(file, "utf8");
    return raw.split("\0")[0].trim() || null;
  } catch {
    return null;
  }
}

async function deviceModel(): Promise<string | null> {
  const dt = (await readFirstLine("/proc/device-tree/model")) ?? (await readFirstLine("/sys/firmware/devicetree/base/model"));
  if (dt) return dt;
  const vendor = (await readFirstLine("/sys/devices/virtual/dmi/id/sys_vendor")) ?? "";
  const product = (await readFirstLine("/sys/devices/virtual/dmi/id/product_name")) ?? "";
  return `${vendor} ${product}`.trim() || null;
}

// Best-effort HDD detection for the filesystem holding `dir`.
async function isRotational(dir: string): Promise<boolean | null> {
  try {
    const dev = (await fs.stat(dir, { bigint: true })).dev;
    const major = Number(((dev >> 8n) & 0xfffn) | ((dev >> 32n) & ~0xfffn));
    const minor = Number((dev & 0xffn) | ((dev >> 12n) & ~0xffn));
    const base = `/sys/dev/block/${major}:${minor}`;
    for (const candidate of [`${base}/queue/rotational`, `${base}/../queue/rotational`]) {
      const value = await readFirstLine(candidate);
      if (value === "0" || value === "1") return value === "1";
    }
  } catch {
    // not Linux, or no block device info
  }
  return null;
}

async function dirSize(dir: string): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    try {
      if (entry.isDirectory()) total += await dirSize(full);
      else if (entry.isFile()) total += (await fs.stat(full)).size;
    } catch {
      // file vanished mid-scan (e.g. pruned); ignore
    }
  }
  return total;
}

async function datadirIsPruned(blocksDir: string): Promise<boolean> {
  try {
    const names = await fs.readdir(blocksDir);
    const blockFiles = names.filter((n) => n.startsWith("blk") && n.endsWith(".dat"));
    return blockFiles.length > 0 && !blockFiles.includes("blk00000.dat");
  } catch {
    return false;
  }
}

// Read what this machine has to offer (mainnet datadir layout).
export async function scanHardware(datadir: string): Promise<HardwareScan> {
  const st = await fs.statfs(datadir);
  let total = st.blocks * st.bsize;
  let free = st.bavail * st.bsize;

  // Let low-storage behaviour be tested on a big machine.
  if (process.env.NOVA_SIMULATE_DISK_TOTAL_GB) total = Number(process.env.NOVA_SIMULATE_DISK_TOTAL_GB) * GB;
  if (process.env.NOVA_SIMULATE_DISK_FREE_GB) free = Number(process.env.NOVA_SIMULATE_DISK_FREE_GB) * GB;

  const blocksDir = path.join(datadir, "blocks");
  const [blocks, chainstate, indexes, pruned, model, rotational] = await Promise.all([
    dirSize(blocksDir),
    dirSize(path.join(datadir, "chainstate")),
    dirSize(path.join(datadir, "indexes")),
    datadirIsPruned(blocksDir),
    deviceModel(),
    isRotational(datadir),
  ]);

  return {
    disk_total: total,
    disk_free: free,
    bitcoin_used: blocks + chainstate + indexes,
    blocks_bytes: blocks,
    chainstate_bytes: chainstate,
    datadir_pruned: pruned,
    has_chain: blocks > 0,
    ram: os.totalmem(),
    cpus: os.availableParallelism(),
    arch: os.arch(),
    model,
    rotational,
  };
}

// Space left free for NovaEtherOS and other apps: 5% of the disk, 10-50 GB.
export function defaultReserve(diskTotal: number) {
  return Math.floor(Math.min(Math.max(10 * GB, diskTotal * 0.05), 50 * GB));
}

// Tune Bitcoin Core to the machine's memory. A bigger dbcache makes the first
// sync dramatically faster, so it is raised while syncing and lowered after.
export function performanceProfile(ramBytes: number, ibd: boolean, dbcacheOverride?: number | null): PerformanceProfile {
  const ramMib = Math.floor(ramBytes / MIB);
  // [max RAM MiB, name, dbcache during IBD, dbcache after, maxmempool, maxconnections, maxuploadtarget]
  const tiers: [number | null, string, number, number, number, number, number][] = [
    [1536, "minimal", 150, 100, 50, 12, 2000],
    [3072, "light", 450, 250, 100, 24, 5000],
    [6144, "standard", 1200, 450, 300, 40, 0],
    [12288, "performance", 2500, 1000, 300, 80, 0],
    [null, "high", 4500, 2000, 300, 125, 0],
  ];
  const tier = tiers.find(([max]) => max === null || ramMib < max)!;
  const [, name, dbIbd, dbSynced, mempool, conns, upload] = tier;
  return {
    tier: name,
    dbcache: dbcacheOverride ? Math.floor(dbcacheOverride) : ibd ? dbIbd : dbSynced,
    maxmempool: mempool,
    maxconnections: conns,
    maxuploadtarget: upload,
  };
}

function fullNodeRequirement(state: StorageState) {
  const observed = state.observed_full_size;
  return observed ? Math.max(DEFAULT_FULL_NODE_BYTES, observed + FULL_NODE_GROWTH_HEADROOM_BYTES) : DEFAULT_FULL_NODE_BYTES;
}

const gb = (bytes: number, digits = 0) => (bytes / GB).toFixed(digits);

// Decide how Bitcoin Core should use the disk.
export function planStorage(scan: HardwareScan, settings: StorageSettings, state: StorageState = {}): StoragePlan {
  const reasons: string[] = [];
  const reserve = settings.reserve_gb != null ? Math.floor(settings.reserve_gb * GB) : defaultReserve(scan.disk_total);

  // Space Bitcoin may use = what it already has + what is free - the reserve.
  const budget = scan.disk_free + scan.bitcoin_used - reserve;
  const requiredFull = fullNodeRequirement(state);
  const blockBudget = budget - CHAINSTATE_ALLOWANCE_BYTES;
  const autoPruneMib = Math.floor((blockBudget * PRUNE_SAFETY_FACTOR) / MIB);
  const prunedDatadir = scan.datadir_pruned;
  const fullPossible = budget >= requiredFull;

  const result: StoragePlan = {
    status: "ok",
    mode: "pruned",
    prune_mib: 0,
    reindex: false,
    reasons,
    budget_bytes: budget,
    reserve_bytes: reserve,
    required_full_bytes: requiredFull,
    minimum_bytes: CHAINSTATE_ALLOWANCE_BYTES + MIN_PRUNE_MIB * MIB + reserve,
    full_node_possible: fullPossible,
  };

  if (autoPruneMib < MIN_PRUNE_MIB) {
    result.status = "insufficient";
    const needed = CHAINSTATE_ALLOWANCE_BYTES + MIN_PRUNE_MIB * MIB - budget;
    reasons.push(
      `Not enough free space to run a node. Free up at least ${gb(needed, 1)} GB ` +
        `(or lower the reserve) and the node will start automatically.`,
    );
    return result;
  }

  if (settings.storage_mode === "prune") {
    let target = Math.max(MIN_PRUNE_MIB, Math.floor((settings.prune_gb * GB) / MIB));
    if (target > autoPruneMib) {
      reasons.push(
        `Requested prune size ${gb(target * MIB)} GB is more than this disk can hold; ` +
          `using ${gb(autoPruneMib * MIB)} GB instead.`,
      );
      target = autoPruneMib;
    } else {
      reasons.push(`Manual prune size: keeping about ${gb(target * MIB, 1)} GB of recent blocks.`);
    }
    result.prune_mib = target;
    return result;
  }

  if (settings.storage_mode === "full") {
    if (prunedDatadir && !settings.confirm_resync) {
      reasons.push(
        "Full node requested, but this node has already pruned old blocks. Converting needs a complete " +
          "re-download of the blockchain; confirm the re-sync in Settings to continue. Staying pruned for now.",
      );
      result.prune_mib = Math.max(MIN_PRUNE_MIB, autoPruneMib);
      return result;
    }
    reasons.push(
      fullPossible
        ? "Full node: keeping the complete blockchain."
        : `Full node forced by settings, but only ${gb(budget)} GB is available and about ${gb(requiredFull)} GB ` +
            "is needed. The storage guard will switch to pruning if the disk fills up.",
    );
    result.mode = "full";
    result.reindex = prunedDatadir;
    return result;
  }

  // Automatic mode.
  if (fullPossible && !prunedDatadir) {
    result.mode = "full";
    reasons.push(`Plenty of space (${gb(budget)} GB available, ~${gb(requiredFull)} GB needed): running a full node.`);
    return result;
  }

  result.prune_mib = autoPruneMib;
  reasons.push(
    fullPossible && prunedDatadir
      ? "This disk now has room for a full node, but old blocks were already pruned. " +
          "Switch Storage mode to Full node in Settings if you want to re-download the complete chain."
      : `This disk has ${gb(budget)} GB available for Bitcoin, less than the ~${gb(requiredFull)} GB a full node ` +
          `needs, so pruning is on and about ${gb(autoPruneMib * MIB)} GB of recent blocks are kept. ` +
          "Mining still works normally.",
  );
  return result;
}

// Called periodically while the node runs. Returns a reason when free space has
// become critical and Bitcoin Core should restart with a smaller footprint.
export function guardDecision(
  scan: HardwareScan,
  settings: StorageSettings,
  state: StorageState,
  currentPruneMib: number,
): string | null {
  const plan = planStorage(scan, settings, state);
  const reserve = plan.reserve_bytes;
  if (scan.disk_free >= reserve * CRITICAL_RESERVE_FRACTION) return null;
  // The user explicitly forced a full node; the guard only warns.
  if (settings.storage_mode === "full") return null;
  if (plan.status !== "ok" || plan.mode === "full") return null;
  if (currentPruneMib === 0 || plan.prune_mib < currentPruneMib * 0.9) {
    return (
      `Free space dropped to ${gb(scan.disk_free, 1)} GB (reserve ${gb(reserve)} GB). ` +
      `Restarting Bitcoin Core with a prune target of ${gb(plan.prune_mib * MIB, 1)} GB.`
    );
  }
  return null;
}
