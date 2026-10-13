// Miners: finds Bitaxe-family miners (AxeOS / ESP-Miner API, including the
// NovaForge / NovaMiningOS firmware) on the local network, shows their stats
// and lets you tune and restart them. Pool settings are left to the user.

import os from "node:os";
import path from "node:path";
import { JsonStore } from "../bitcoin/store.js";

const POLL_MS = 10_000;
const SCAN_EVERY_MS = 30 * 60_000;
const SCAN_TIMEOUT_MS = 1_500;
const SCAN_CONCURRENCY = 64;
// Miners stuck on their backup pool while ours is up get restarted to reconnect:
// after this long, and at most this often per miner.
const RECONNECT_AFTER_MS = 90_000;
const RECONNECT_COOLDOWN_MS = 20 * 60_000;
const REQUEST_TIMEOUT_MS = 5_000;
// Don't sweep huge networks: anything bigger than a /22 is limited to our /24.
const MAX_SCAN_PREFIX = 22;

// Settings NovaEtherOS may change, with the same limits as the firmware's own UI.
export const LIMITS = {
  frequency: { min: 350, max: 750 }, // MHz
  coreVoltage: { min: 1000, max: 1300 }, // mV
  manualFanSpeed: { min: 0, max: 100 }, // %
  temptarget: { min: 35, max: 70 }, // °C
} as const;

export interface MinerSettings {
  frequency?: number;
  coreVoltage?: number;
  autofanspeed?: boolean;
  manualFanSpeed?: number;
  temptarget?: number;
}

interface KnownMiner {
  id: string; // MAC address (stable even if the IP changes)
  ip: string;
  added_at: number;
}

interface MinersState {
  miners: KnownMiner[];
  ignored: string[]; // MACs the user removed; discovery won't re-add them
  last_scan: number;
  auto_reconnect: boolean; // restart miners stuck on their backup pool once ours is back
}

type Info = Record<string, any>;

function normalizeMac(mac: unknown) {
  return String(mac ?? "").toLowerCase().replace(/[^0-9a-f]/g, "").replace(/(..)(?!$)/g, "$1:");
}

// Does this JSON look like an AxeOS-style miner?
export function isMinerInfo(info: unknown): info is Info {
  if (!info || typeof info !== "object") return false;
  const i = info as Info;
  return typeof i.hashRate === "number" && (typeof i.ASICModel === "string" || typeof i.asicCount === "number");
}

// Keep only what the dashboard needs (the miner's info also holds Wi-Fi,
// webhook and other private settings).
export function summarize(info: Info) {
  const hashrateGh = Number(info.hashRate) || 0;
  const power = Number(info.power) || 0;
  const ths = hashrateGh / 1000;
  return {
    hostname: info.hostname ?? null,
    nickname: info.nickname ?? null,
    model: [info.deviceModel, info.boardVersion].filter(Boolean).join(" ") || null,
    asic: info.ASICModel ?? null,
    firmware: info.firmware ?? null,
    version: info.version ?? null,
    state: info.state ?? null,
    hashrate: hashrateGh * 1e9, // H/s
    hashrate_1h: info.hashRate_1h != null ? Number(info.hashRate_1h) * 1e9 : null,
    power,
    efficiency: ths > 0 && power > 0 ? power / ths : null, // J/TH
    temp: info.temp ?? null,
    vr_temp: info.vrTemp ?? null,
    frequency: info.frequencySetting ?? info.frequency ?? null,
    core_voltage: info.coreVoltageRunning ?? info.coreVoltage ?? null,
    core_voltage_actual: info.coreVoltageActual ?? null,
    fan_percent: info.fanspeed ?? null,
    fan_rpm: info.fanrpm ?? null,
    auto_fan: Boolean(info.autofanspeed),
    manual_fan: info.manualFanSpeed ?? info.fanspeed ?? null,
    temp_target: info.temptarget ?? null,
    overheat: Boolean(info.overheat_mode),
    shares_accepted: info.sharesAccepted ?? null,
    shares_rejected: info.sharesRejected ?? null,
    best_diff: info.bestDiff ?? null,
    best_session_diff: info.bestSessionDiff ?? null,
    found_blocks: info.foundBlocks ?? 0,
    uptime: info.uptimeSeconds ?? null,
    wifi_rssi: info.wifiRSSI ?? null,
    pool: {
      url: info.stratumURL ?? null,
      port: info.stratumPort ?? null,
      user: info.stratumUser ?? null,
      connected: info.poolConnected ?? null,
      using_fallback: Boolean(info.isUsingFallbackStratum),
      fallback_url: info.fallbackStratumURL ?? null,
      fallback_port: info.fallbackStratumPort ?? null,
    },
    locked: Boolean(info.commitActive),
  };
}

// Which pool a miner is really mining on, and how that relates to our pool.
// ESP-Miner/AxeOS firmware falls back to its backup pool when the main one
// drops (e.g. while NovaEtherOS restarts) and doesn't switch back by itself.
export function poolStatus(pool: ReturnType<typeof summarize>["pool"], host: string, port: number) {
  const hostOf = (url: string | null) => String(url ?? "").replace(/^stratum\+tcp:\/\//, "").split(/[:/]/)[0];
  const ours = (url: string | null, p: number | null) => hostOf(url) === host && Number(p) === port;
  const primary = ours(pool.url, pool.port);
  const backup = ours(pool.fallback_url, pool.fallback_port);
  return {
    active_url: pool.using_fallback ? pool.fallback_url : pool.url,
    active_port: pool.using_fallback ? pool.fallback_port : pool.port,
    on_nova_pool: pool.using_fallback ? backup : primary, // mining to our pool right now
    nova_pool_primary: primary,
    nova_pool_backup: backup,
    stranded: primary && pool.using_fallback, // ours is its main pool, but it's on the backup
  };
}

// Validate a settings change and turn it into the PATCH body the firmware expects.
export function settingsBody(s: MinerSettings) {
  const body: Record<string, number> = {};
  const check = (key: keyof typeof LIMITS, value: unknown) => {
    const n = Number(value);
    const { min, max } = LIMITS[key];
    if (!Number.isFinite(n) || n < min || n > max) {
      throw new Error(`${key} must be between ${min} and ${max}`);
    }
    return Math.round(n);
  };
  if (s.frequency != null) body.frequency = check("frequency", s.frequency);
  if (s.coreVoltage != null) body.coreVoltage = check("coreVoltage", s.coreVoltage);
  if (s.temptarget != null) body.temptarget = check("temptarget", s.temptarget);
  if (s.autofanspeed != null) body.autofanspeed = s.autofanspeed ? 1 : 0;
  if (s.manualFanSpeed != null) {
    // NovaForge uses manualFanSpeed; stock AxeOS uses fanspeed. Send both.
    body.manualFanSpeed = check("manualFanSpeed", s.manualFanSpeed);
    body.fanspeed = body.manualFanSpeed;
  }
  if (!Object.keys(body).length) throw new Error("Nothing to change");
  return body;
}

// Hosts to scan on our LAN, from the interface that holds our LAN address.
export function scanTargets(interfaces = os.networkInterfaces()): string[] {
  for (const addrs of Object.values(interfaces)) {
    for (const a of addrs ?? []) {
      if (a.family !== "IPv4" || a.internal || !a.cidr) continue;
      // Skip Docker / container bridges.
      if (/^172\.(1[6-9]|2\d|3[01])\./.test(a.address)) continue;
      const networkPrefix = Number(a.cidr.split("/")[1]);
      const prefix = networkPrefix < MAX_SCAN_PREFIX ? 24 : networkPrefix;
      const toInt = (ip: string) => ip.split(".").reduce((n, o) => n * 256 + Number(o), 0);
      const toIp = (n: number) => [24, 16, 8, 0].map((s) => Math.floor(n / 2 ** s) % 256).join(".");
      const size = 2 ** (32 - prefix);
      const base = Math.floor(toInt(a.address) / size) * size;
      const hosts: string[] = [];
      for (let i = 1; i < size - 1; i++) {
        const ip = toIp(base + i);
        if (ip !== a.address) hosts.push(ip);
      }
      return hosts;
    }
  }
  return [];
}

// NovaForge rejects changes (HTTP 403) unless this header is present, as its
// own web page sends it (cross-site request protection). Stock AxeOS ignores it.
const WRITE_HEADERS = { "Content-Type": "application/json", "X-Requested-With": "NovaForge" };

async function errorFrom(res: Response) {
  try {
    const body = await res.json();
    if (body?.error) return `The miner refused the change: ${body.error}`;
  } catch {
    // no JSON body
  }
  return `The miner refused the change (HTTP ${res.status})`;
}

async function getInfo(ip: string, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Info | null> {
  try {
    const res = await fetch(`http://${ip}/api/system/info`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const json = await res.json();
    return isMinerInfo(json) ? json : null;
  } catch {
    return null;
  }
}

export class Miners {
  private state: JsonStore<MinersState>;
  private live = new Map<string, { info: Info | null; online: boolean; last_seen: number; error: string | null }>();
  private scanning: Promise<void> | null = null;
  private scanProgress = { done: 0, total: 0 };

  private pool: (() => { host: string; port: number; ready: boolean }) | null = null;
  private log: (message: string, level?: "info" | "error") => void = () => undefined;
  private poolReadySince = 0;
  private strandedSince = new Map<string, number>();
  private lastReconnect = new Map<string, number>();

  constructor(dataDir: string) {
    this.state = new JsonStore<MinersState>(path.join(dataDir, "miners.json"), {
      miners: [], ignored: [], last_scan: 0, auto_reconnect: true,
    });
  }

  // Let the miners page know about our own solo pool, so stranded miners can be brought back.
  connectPool(info: () => { host: string; port: number; ready: boolean }, log: (message: string, level?: "info" | "error") => void) {
    this.pool = info;
    this.log = log;
  }

  setAutoReconnect(enabled: boolean) {
    this.state.update({ auto_reconnect: enabled });
  }

  // Restart miners whose main pool is ours but which sit on their backup pool,
  // once our pool has been up for a while. Pool settings themselves are never touched.
  private async reconnectStranded(now = Date.now()) {
    const p = this.pool?.();
    if (!p?.ready) {
      this.poolReadySince = 0;
      return;
    }
    if (!this.poolReadySince) this.poolReadySince = now;
    for (const m of this.state.get("miners")) {
      const live = this.live.get(m.id);
      const s = live?.online && live.info ? summarize(live.info) : null;
      if (!s || !poolStatus(s.pool, p.host, p.port).stranded) {
        this.strandedSince.delete(m.id);
        continue;
      }
      if (!this.strandedSince.has(m.id)) this.strandedSince.set(m.id, now);
      if (!this.state.get("auto_reconnect")) continue;
      const waited = now - Math.max(this.strandedSince.get(m.id)!, this.poolReadySince) >= RECONNECT_AFTER_MS;
      const cooled = now - (this.lastReconnect.get(m.id) ?? 0) >= RECONNECT_COOLDOWN_MS;
      if (!waited || !cooled) continue;
      this.lastReconnect.set(m.id, now);
      const name = s.nickname || s.hostname || m.ip;
      try {
        await this.restart(m.id);
        this.log(`${name} was stuck on its backup pool while your pool was up; restarted it so it reconnects.`);
      } catch (err) {
        this.log(`Couldn't restart ${name} to bring it back to your pool: ${(err as Error).message}`, "error");
      }
    }
  }

  start() {
    void this.pollAll();
    setInterval(() => void this.pollAll(), POLL_MS);
    if (Date.now() - this.state.get("last_scan") > SCAN_EVERY_MS) void this.scan();
    setInterval(() => void this.scan(), SCAN_EVERY_MS);
  }

  private upsert(id: string, ip: string) {
    const miners = this.state.get("miners");
    const existing = miners.find((m) => m.id === id);
    if (existing && existing.ip === ip) return;
    this.state.update({
      miners: existing
        ? miners.map((m) => (m.id === id ? { ...m, ip } : m))
        : [...miners, { id, ip, added_at: Date.now() }],
    });
  }

  private async pollAll() {
    await Promise.all(
      this.state.get("miners").map(async (m) => {
        const info = await getInfo(m.ip);
        const prev = this.live.get(m.id);
        if (info && normalizeMac(info.macAddr) === m.id) {
          this.live.set(m.id, { info, online: true, last_seen: Date.now(), error: null });
        } else {
          // Offline, or a different device now has this IP (DHCP change).
          this.live.set(m.id, {
            info: prev?.info ?? null,
            online: false,
            last_seen: prev?.last_seen ?? 0,
            error: info ? "Another device now uses this address; rescanning…" : null,
          });
          if (info && !this.scanning) void this.scan();
        }
      }),
    );
    await this.reconnectStranded();
  }

  // Sweep the LAN for miners. Known miners whose IP changed are followed by MAC.
  scan(): Promise<void> {
    if (!this.scanning) {
      this.scanning = this.doScan().finally(() => (this.scanning = null));
    }
    return this.scanning;
  }

  private async doScan() {
    const targets = scanTargets();
    this.scanProgress = { done: 0, total: targets.length };
    const queue = [...targets];
    const worker = async () => {
      for (let ip = queue.shift(); ip; ip = queue.shift()) {
        const info = await getInfo(ip, SCAN_TIMEOUT_MS);
        this.scanProgress.done++;
        if (!info) continue;
        const id = normalizeMac(info.macAddr);
        if (!id || this.state.get("ignored").includes(id)) continue;
        this.upsert(id, ip);
        this.live.set(id, { info, online: true, last_seen: Date.now(), error: null });
      }
    };
    await Promise.all(Array.from({ length: SCAN_CONCURRENCY }, worker));
    this.state.update({ last_scan: Date.now() });
  }

  async add(ip: string) {
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) throw new Error("Enter an IP address like 192.168.0.109");
    const info = await getInfo(ip);
    if (!info) throw new Error(`No Bitaxe-style miner answered at ${ip}`);
    const id = normalizeMac(info.macAddr);
    this.state.update({ ignored: this.state.get("ignored").filter((m) => m !== id) });
    this.upsert(id, ip);
    this.live.set(id, { info, online: true, last_seen: Date.now(), error: null });
    return id;
  }

  remove(id: string) {
    this.state.update({
      miners: this.state.get("miners").filter((m) => m.id !== id),
      ignored: [...new Set([...this.state.get("ignored"), id])],
    });
    this.live.delete(id);
  }

  private find(id: string) {
    const m = this.state.get("miners").find((x) => x.id === id);
    if (!m) throw new Error("Miner not found");
    return m;
  }

  async applySettings(id: string, settings: MinerSettings) {
    const m = this.find(id);
    const body = settingsBody(settings);
    if (this.live.get(id)?.info?.commitActive) {
      throw new Error("This miner's settings are locked on the miner (commitment mode). Unlock it on the miner first.");
    }
    const res = await fetch(`http://${m.ip}/api/system`, {
      method: "PATCH",
      headers: WRITE_HEADERS,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(await errorFrom(res));
    let restartRequired = false;
    try {
      restartRequired = Boolean((await res.json())?.restartRequired);
    } catch {
      // Stock AxeOS replies with an empty body.
    }
    // Frequency/voltage changes need a restart on stock AxeOS; NovaForge says so itself.
    if (restartRequired || body.frequency != null || body.coreVoltage != null) await this.restart(id);
    return { restarted: restartRequired || body.frequency != null || body.coreVoltage != null };
  }

  async restart(id: string) {
    const m = this.find(id);
    let res: Response;
    try {
      res = await fetch(`http://${m.ip}/api/system/restart`, {
        method: "POST",
        headers: WRITE_HEADERS,
        body: "{}",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      return; // The miner often drops the connection as it reboots.
    }
    if (!res.ok) throw new Error((await errorFrom(res)).replace("the change", "the restart"));
  }

  snapshot(poolHost: string, poolPort: number) {
    const miners = this.state.get("miners").map((m) => {
      const live = this.live.get(m.id);
      const s = live?.info ? summarize(live.info) : null;
      const ps = s ? poolStatus(s.pool, poolHost, poolPort) : null;
      return {
        id: m.id,
        ip: m.ip,
        online: Boolean(live?.online),
        last_seen: live?.last_seen || null,
        error: live?.error ?? null,
        stats: s,
        active_pool: ps ? { url: ps.active_url, port: ps.active_port } : null,
        on_nova_pool: Boolean(ps?.on_nova_pool && live?.online),
        nova_pool_primary: Boolean(ps?.nova_pool_primary),
        nova_pool_backup: Boolean(ps?.nova_pool_backup),
        stranded: Boolean(ps?.stranded && live?.online),
        reconnect_at: ps?.stranded && live?.online && this.state.get("auto_reconnect")
          ? Math.max(
              (this.strandedSince.get(m.id) ?? Date.now()) + RECONNECT_AFTER_MS,
              (this.lastReconnect.get(m.id) ?? 0) + RECONNECT_COOLDOWN_MS,
            )
          : null,
      };
    });
    const online = miners.filter((m) => m.online && m.stats);
    return {
      miners,
      totals: {
        hashrate: online.reduce((sum, m) => sum + (m.stats?.hashrate ?? 0), 0),
        power: online.reduce((sum, m) => sum + (m.stats?.power ?? 0), 0),
        online: online.length,
      },
      scanning: Boolean(this.scanning),
      scan_progress: this.scanProgress,
      last_scan: this.state.get("last_scan") || null,
      auto_reconnect: this.state.get("auto_reconnect"),
      limits: LIMITS,
    };
  }
}
