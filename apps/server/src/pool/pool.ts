// Nova Solo Pool: a stratum v1 server built into NovaEtherOS. Miners (Bitaxe,
// NerdMiner, Antminer...) connect with "<bitcoin address>.<worker>" as their
// username, and every block they find pays the full reward to that address.
// Work comes straight from our own Bitcoin Core via getblocktemplate.

import crypto from "node:crypto";
import net from "node:net";
import path from "node:path";
import { addressToScript, type Network } from "./address.js";
import {
  DIFF1_TARGET,
  bitsToTarget,
  difficultyToTarget,
  hashDifficulty,
  hashToBigInt,
  reverse,
} from "./bitcoin-utils.js";
import {
  EXTRANONCE1_SIZE,
  EXTRANONCE2_SIZE,
  createJob,
  headerFor,
  notifyParams,
  serializeBlock,
  type BlockTemplate,
  type Job,
} from "./jobs.js";
import { RPC } from "../bitcoin/rpc.js";
import { JsonStore } from "../bitcoin/store.js";

const TICK_MS = 1_000;
const TEMPLATE_REFRESH_MS = 30_000;
const VARDIFF_TARGET_SECONDS = 10;
const VARDIFF_RETARGET_SECONDS = 60;
const MIN_DIFFICULTY = 0.0001;
const DEFAULT_DIFFICULTY = 512;
const HASHRATE_WINDOW_MS = 10 * 60_000;
const MAX_JOBS_PER_CLIENT = 8;
const MAX_LINE_BYTES = 16 * 1024;
// Version rolling (BIP310 / ASICBoost): bits miners may change.
const VERSION_ROLLING_MASK = 0x1fffe000;
const OP_TRUE_SCRIPT = Buffer.from([0x51]);

export interface PoolOptions {
  rpc: RPC;
  isNodeReady: () => boolean;
  dataDir: string;
  port: number;
  host?: string;
  network?: Network;
  log?: (message: string, level?: "info" | "error") => void;
}

interface WorkerStats {
  name: string; // "<worker>" part of the username
  address: string;
  accepted: number;
  rejected: number;
  best: number;
  lastShare: number;
  shares: { t: number; diff: number }[]; // for the hashrate estimate
}

interface ClientJob {
  job: Job;
  difficulty: number;
}

interface Client {
  id: number;
  socket: net.Socket;
  remote: string;
  extranonce1: Buffer;
  subscribed: boolean;
  worker: WorkerStats | null;
  payoutScript: Buffer | null;
  difficulty: number;
  suggested: number | null;
  versionMask: number;
  jobs: Map<string, ClientJob>;
  seen: Set<string>;
  connectedAt: number;
  vardiffSince: number;
  vardiffShares: number;
}

export interface FoundBlock {
  height: number;
  hash: string;
  worker: string;
  address: string;
  reward: number;
  time: number;
  accepted: boolean;
  result: string | null;
}

interface PoolState {
  found: FoundBlock[];
  best_share: { difficulty: number; worker: string; time: number } | null;
  totals: { accepted: number; rejected: number };
}

class StratumError extends Error {
  constructor(public code: number, message: string) {
    super(message);
  }
}

export class SoloPool {
  private server: net.Server | null = null;
  private clients = new Map<number, Client>();
  private workers = new Map<string, WorkerStats>();
  private nextClientId = 1;
  private nextJobId = 1;
  private extranonceCounter = crypto.randomBytes(4).readUInt32BE(0);
  private template: BlockTemplate | null = null;
  private templateAt = 0;
  private lastError: string | null = null;
  private selftest: { ok: boolean; result: string | null; height: number; time: number } | null = null;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private state: JsonStore<PoolState>;
  private network: Network;
  private log: (message: string, level?: "info" | "error") => void;

  constructor(private opts: PoolOptions) {
    this.network = opts.network ?? "main";
    this.log = opts.log ?? ((m) => console.log(`[pool] ${m}`));
    this.state = new JsonStore<PoolState>(path.join(opts.dataDir, "pool.json"), {
      found: [],
      best_share: null,
      totals: { accepted: 0, rejected: 0 },
    });
  }

  // --- lifecycle -------------------------------------------------------------

  async start() {
    this.server = net.createServer((socket) => this.onConnection(socket));
    this.server.on("error", (err) => {
      this.lastError = `Stratum server error: ${err.message}`;
      this.log(this.lastError, "error");
    });
    await new Promise<void>((resolve) => this.server!.listen(this.opts.port, this.opts.host ?? "0.0.0.0", resolve));
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    void this.tick();
  }

  get port() {
    const addr = this.server?.address();
    return typeof addr === "object" && addr ? addr.port : this.opts.port;
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    for (const c of this.clients.values()) c.socket.destroy();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  // --- templates -------------------------------------------------------------

  private async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      if (!this.opts.isNodeReady()) {
        if (this.template) this.log("Bitcoin node is not synced; pausing the pool.");
        this.template = null;
        // Disconnect miners so they fail over to their backup pool.
        for (const c of this.clients.values()) c.socket.end();
        return;
      }
      await this.maybeRefreshTemplate();
      this.checkIdleVardiff();
    } catch (err) {
      this.lastError = (err as Error).message;
    } finally {
      this.ticking = false;
    }
  }

  private async maybeRefreshTemplate(force = false) {
    const best: string = await this.opts.rpc.call("getbestblockhash");
    const newBlock = !this.template || this.template.previousblockhash !== best;
    if (!force && !newBlock && Date.now() - this.templateAt < TEMPLATE_REFRESH_MS) return;

    const template: BlockTemplate = await this.opts.rpc.call("getblocktemplate", [{ rules: ["segwit"] }], 30_000);
    const blockChanged = !this.template || this.template.previousblockhash !== template.previousblockhash;
    this.template = template;
    this.templateAt = Date.now();
    this.lastError = null;

    for (const c of this.clients.values()) if (c.payoutScript) this.sendJob(c, blockChanged);
    if (blockChanged) void this.selfTest(template);
  }

  // Ask Bitcoin Core to validate a block built exactly like the ones we'd
  // submit (proof-of-work aside). Catches construction bugs long before a real
  // block is at stake.
  private async selfTest(template: BlockTemplate) {
    try {
      const job = createJob("selftest", template, OP_TRUE_SCRIPT);
      const { header, coinbase } = headerFor(
        job,
        Buffer.alloc(EXTRANONCE1_SIZE),
        Buffer.alloc(EXTRANONCE2_SIZE),
        template.curtime,
        0,
        template.version,
      );
      const block = serializeBlock(job, header, coinbase).toString("hex");
      const result: string | null = await this.opts.rpc.call(
        "getblocktemplate",
        [{ mode: "proposal", data: block, rules: ["segwit"] }],
        60_000,
      );
      // The tip may move while we test; that says nothing about our blocks.
      if (result === "inconclusive-not-best-prevblk") return;
      const ok = result === null;
      if (!ok || !this.selftest?.ok) {
        this.log(ok ? "Pool self-test passed: Bitcoin Core accepts our block format." : `Pool self-test FAILED: ${result}`, ok ? "info" : "error");
      }
      this.selftest = { ok, result, height: template.height, time: Date.now() };
    } catch (err) {
      this.selftest = { ok: false, result: (err as Error).message, height: template.height, time: Date.now() };
    }
  }

  // --- connections -----------------------------------------------------------

  private onConnection(socket: net.Socket) {
    const extranonce1 = Buffer.alloc(EXTRANONCE1_SIZE);
    extranonce1.writeUInt32BE(this.extranonceCounter++ >>> 0);
    const client: Client = {
      id: this.nextClientId++,
      socket,
      remote: `${socket.remoteAddress ?? "?"}`.replace(/^::ffff:/, ""),
      extranonce1,
      subscribed: false,
      worker: null,
      payoutScript: null,
      difficulty: DEFAULT_DIFFICULTY,
      suggested: null,
      versionMask: 0,
      jobs: new Map(),
      seen: new Set(),
      connectedAt: Date.now(),
      vardiffSince: Date.now(),
      vardiffShares: 0,
    };
    this.clients.set(client.id, client);
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 60_000);
    socket.setTimeout(10 * 60_000, () => socket.destroy());

    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (buffer.length > MAX_LINE_BYTES) return socket.destroy();
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) void this.onMessage(client, line);
      }
    });
    socket.on("close", () => this.clients.delete(client.id));
    socket.on("error", () => socket.destroy());
  }

  private send(client: Client, message: unknown) {
    if (!client.socket.destroyed) client.socket.write(JSON.stringify(message) + "\n");
  }

  private async onMessage(client: Client, line: string) {
    let msg: { id?: unknown; method?: string; params?: unknown[] };
    try {
      msg = JSON.parse(line);
    } catch {
      return client.socket.destroy();
    }
    const id = msg.id ?? null;
    try {
      const result = await this.handle(client, msg.method ?? "", Array.isArray(msg.params) ? msg.params : []);
      this.send(client, { id, result, error: null });
    } catch (err) {
      const e = err instanceof StratumError ? err : new StratumError(20, (err as Error).message);
      this.send(client, { id, result: null, error: [e.code, e.message, null] });
    }
  }

  private async handle(client: Client, method: string, params: unknown[]): Promise<unknown> {
    switch (method) {
      case "mining.configure":
        return this.configure(client, params);
      case "mining.subscribe":
        client.subscribed = true;
        return [
          [
            ["mining.set_difficulty", String(client.id)],
            ["mining.notify", String(client.id)],
          ],
          client.extranonce1.toString("hex"),
          EXTRANONCE2_SIZE,
        ];
      case "mining.extranonce.subscribe":
        return true;
      case "mining.suggest_difficulty": {
        const d = Number(params[0]);
        if (Number.isFinite(d) && d > 0) {
          client.suggested = Math.max(MIN_DIFFICULTY, d);
          if (client.worker) this.setDifficulty(client, client.suggested, true);
          else client.difficulty = client.suggested;
        }
        return true;
      }
      case "mining.authorize":
        return this.authorize(client, params);
      case "mining.submit":
        return this.submit(client, params);
      default:
        throw new StratumError(20, `Unsupported method: ${method}`);
    }
  }

  private configure(client: Client, params: unknown[]) {
    const extensions = Array.isArray(params[0]) ? (params[0] as string[]) : [];
    const options = (params[1] ?? {}) as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const ext of extensions) {
      if (ext === "version-rolling") {
        const requested = parseInt(String(options["version-rolling.mask"] ?? "ffffffff"), 16) >>> 0;
        client.versionMask = (requested & VERSION_ROLLING_MASK) >>> 0;
        result["version-rolling"] = true;
        result["version-rolling.mask"] = client.versionMask.toString(16).padStart(8, "0");
      } else {
        result[ext] = false;
      }
    }
    return result;
  }

  private authorize(client: Client, params: unknown[]) {
    const username = String(params[0] ?? "").trim();
    const [address, ...rest] = username.split(".");
    const workerName = rest.join(".") || "default";
    const script = addressToScript(address, this.network);
    if (!script) {
      throw new StratumError(24, "Username must be <your bitcoin address>.<worker name>");
    }
    if (!this.template) {
      // Close so the miner switches to its backup pool.
      setTimeout(() => client.socket.end(), 500);
      throw new StratumError(25, "Nova Solo Pool is waiting for the Bitcoin node to finish syncing");
    }

    const key = `${address}.${workerName}`;
    let worker = this.workers.get(key);
    if (!worker) {
      worker = { name: workerName, address, accepted: 0, rejected: 0, best: 0, lastShare: 0, shares: [] };
      this.workers.set(key, worker);
    }
    client.worker = worker;
    client.payoutScript = script;
    this.log(`Miner connected: ${workerName} (${client.remote}) paying to ${address}`);

    // Reply first, then send difficulty and work.
    setImmediate(() => {
      this.setDifficulty(client, client.suggested ?? client.difficulty, false);
      this.sendJob(client, true);
    });
    return true;
  }

  private setDifficulty(client: Client, difficulty: number, resendJob: boolean) {
    client.difficulty = Math.max(MIN_DIFFICULTY, difficulty);
    client.vardiffSince = Date.now();
    client.vardiffShares = 0;
    this.send(client, { id: null, method: "mining.set_difficulty", params: [client.difficulty] });
    // A new difficulty applies from the next job.
    if (resendJob) this.sendJob(client, false);
  }

  private sendJob(client: Client, clean: boolean) {
    if (!this.template || !client.payoutScript) return;
    const job = createJob((this.nextJobId++).toString(16), this.template, client.payoutScript);
    if (clean) {
      client.jobs.clear();
      client.seen.clear();
    }
    client.jobs.set(job.id, { job, difficulty: client.difficulty });
    while (client.jobs.size > MAX_JOBS_PER_CLIENT) client.jobs.delete(client.jobs.keys().next().value!);
    this.send(client, { id: null, method: "mining.notify", params: [...notifyParams(job), clean] });
  }

  // --- shares ----------------------------------------------------------------

  private reject(client: Client, code: number, message: string): never {
    if (client.worker) client.worker.rejected++;
    this.state.update({ totals: { ...this.state.get("totals"), rejected: this.state.get("totals").rejected + 1 } });
    throw new StratumError(code, message);
  }

  private async submit(client: Client, params: unknown[]) {
    if (!client.worker || !client.payoutScript) throw new StratumError(24, "Unauthorized worker");
    const [, jobId, en2Hex, ntimeHex, nonceHex, versionBitsHex] = params.map((p) => (p == null ? p : String(p)));

    const entry = client.jobs.get(String(jobId));
    if (!entry) this.reject(client, 21, "Job not found (stale)");
    const { job, difficulty } = entry;

    if (!/^[0-9a-f]+$/i.test(String(en2Hex)) || String(en2Hex).length !== EXTRANONCE2_SIZE * 2) {
      this.reject(client, 20, "Invalid extranonce2");
    }
    const ntime = parseInt(String(ntimeHex), 16);
    const nonce = parseInt(String(nonceHex), 16);
    if (!Number.isFinite(ntime) || !Number.isFinite(nonce) || String(nonceHex).length !== 8) {
      this.reject(client, 20, "Invalid ntime or nonce");
    }
    if (ntime < job.mintime || ntime > Math.floor(Date.now() / 1000) + 7200) this.reject(client, 20, "ntime out of range");

    let version = job.version;
    if (versionBitsHex) {
      const bits = parseInt(versionBitsHex, 16) >>> 0;
      if ((bits & ~client.versionMask) >>> 0) this.reject(client, 20, "Invalid version bits");
      version = ((job.version & ~client.versionMask) | (bits & client.versionMask)) >>> 0;
    }

    const key = `${jobId}:${en2Hex}:${ntimeHex}:${nonceHex}:${version}`.toLowerCase();
    if (client.seen.has(key)) this.reject(client, 22, "Duplicate share");
    client.seen.add(key);

    const extranonce2 = Buffer.from(String(en2Hex), "hex");
    const { header, coinbase, hash } = headerFor(job, client.extranonce1, extranonce2, ntime, nonce, version);
    const value = hashToBigInt(hash);
    const shareDiff = hashDifficulty(hash);

    // A block is a block, whatever the share difficulty was.
    if (value <= job.networkTarget) {
      await this.submitBlock(client, job, header, coinbase, hash);
    } else if (value > difficultyToTarget(difficulty)) {
      this.reject(client, 23, `Low difficulty share (${shareDiff.toFixed(2)})`);
    }

    this.recordShare(client, difficulty, shareDiff);
    return true;
  }

  private recordShare(client: Client, difficulty: number, shareDiff: number) {
    const w = client.worker!;
    const now = Date.now();
    w.accepted++;
    w.lastShare = now;
    w.best = Math.max(w.best, shareDiff);
    w.shares.push({ t: now, diff: difficulty });
    while (w.shares.length && now - w.shares[0].t > HASHRATE_WINDOW_MS) w.shares.shift();

    const totals = this.state.get("totals");
    const best = this.state.get("best_share");
    this.state.update({
      totals: { ...totals, accepted: totals.accepted + 1 },
      ...(!best || shareDiff > best.difficulty
        ? { best_share: { difficulty: shareDiff, worker: `${w.name}`, time: now } }
        : {}),
    });

    client.vardiffShares++;
    this.maybeRetarget(client);
  }

  private async submitBlock(client: Client, job: Job, header: Buffer, coinbase: Buffer, hash: Buffer) {
    const blockHash = reverse(hash).toString("hex");
    const blockHex = serializeBlock(job, header, coinbase).toString("hex");
    this.log(`BLOCK FOUND by ${client.worker!.name} at height ${job.height}! Submitting ${blockHash}...`);
    let result: string | null;
    try {
      result = await this.opts.rpc.call("submitblock", [blockHex], 60_000);
    } catch (err) {
      result = (err as Error).message;
    }
    const accepted = result === null || result === "duplicate";
    const found: FoundBlock = {
      height: job.height,
      hash: blockHash,
      worker: client.worker!.name,
      address: client.worker!.address,
      reward: job.template.coinbasevalue,
      time: Date.now(),
      accepted,
      result,
    };
    this.state.update({ found: [found, ...this.state.get("found")].slice(0, 100) });
    this.log(
      accepted
        ? `Block ${job.height} accepted by Bitcoin Core. Reward ${(found.reward / 1e8).toFixed(8)} BTC to ${found.address}.`
        : `Block ${job.height} was REJECTED by Bitcoin Core: ${result}`,
      accepted ? "info" : "error",
    );
    // Move everyone onto the next block right away.
    void this.maybeRefreshTemplate(true).catch(() => undefined);
  }

  // --- vardiff ---------------------------------------------------------------

  private maybeRetarget(client: Client) {
    const elapsed = (Date.now() - client.vardiffSince) / 1000;
    if (elapsed < VARDIFF_RETARGET_SECONDS && client.vardiffShares < 30) return;
    const rate = client.vardiffShares / Math.max(elapsed, 1);
    const ideal = client.difficulty * rate * VARDIFF_TARGET_SECONDS;
    const ratio = Math.min(4, Math.max(0.25, ideal / client.difficulty));
    if (Math.abs(ratio - 1) < 0.3) {
      client.vardiffSince = Date.now();
      client.vardiffShares = 0;
      return;
    }
    this.setDifficulty(client, roundDifficulty(client.difficulty * ratio), true);
  }

  // Miners that go quiet probably have too high a difficulty.
  private checkIdleVardiff() {
    const now = Date.now();
    for (const c of this.clients.values()) {
      if (!c.worker) continue;
      const idle = (now - Math.max(c.vardiffSince, c.worker.lastShare)) / 1000;
      if (idle > VARDIFF_RETARGET_SECONDS * 2 && c.difficulty > MIN_DIFFICULTY) {
        this.setDifficulty(c, roundDifficulty(c.difficulty / 2), true);
      }
    }
  }

  // --- dashboard -------------------------------------------------------------

  private hashrate(w: WorkerStats) {
    const now = Date.now();
    const shares = w.shares.filter((s) => now - s.t <= HASHRATE_WINDOW_MS);
    if (!shares.length) return 0;
    const window = Math.max(60, (now - shares[0].t) / 1000);
    return (shares.reduce((sum, s) => sum + s.diff, 0) * 2 ** 32) / window;
  }

  snapshot() {
    const connected = new Map<WorkerStats, Client>();
    for (const c of this.clients.values()) if (c.worker) connected.set(c.worker, c);

    const workers = [...this.workers.values()]
      .filter((w) => connected.has(w) || Date.now() - w.lastShare < 24 * 3600_000)
      .map((w) => {
        const c = connected.get(w);
        return {
          name: w.name,
          address: w.address,
          connected: Boolean(c),
          remote: c?.remote ?? null,
          difficulty: c?.difficulty ?? null,
          hashrate: this.hashrate(w),
          accepted: w.accepted,
          rejected: w.rejected,
          best: w.best,
          last_share: w.lastShare || null,
        };
      });
    const hashrate = workers.reduce((sum, w) => sum + w.hashrate, 0);
    const t = this.template;
    const networkDifficulty = t ? Number((DIFF1_TARGET * 1000n) / bitsToTarget(parseInt(t.bits, 16))) / 1000 : null;

    return {
      ready: Boolean(t),
      status: t
        ? "Mining"
        : this.opts.isNodeReady()
          ? "Getting work from Bitcoin Core…"
          : "Waiting for the Bitcoin node to finish syncing",
      port: this.port,
      error: this.lastError,
      hashrate,
      workers,
      template: t
        ? { height: t.height, reward: t.coinbasevalue, tx_count: t.transactions.length }
        : null,
      network_difficulty: networkDifficulty,
      // Expected time for this pool alone to find a block.
      expected_seconds: networkDifficulty && hashrate > 0 ? (networkDifficulty * 2 ** 32) / hashrate : null,
      selftest: this.selftest,
      found: this.state.get("found"),
      best_share: this.state.get("best_share"),
      totals: this.state.get("totals"),
    };
  }

  // Addresses our miners are paying to (to highlight our blocks elsewhere).
  payoutAddresses() {
    return new Set([...this.workers.values()].map((w) => w.address));
  }
}

// Keep difficulties readable (2 significant figures).
function roundDifficulty(d: number) {
  if (d < MIN_DIFFICULTY) return MIN_DIFFICULTY;
  const magnitude = 10 ** Math.floor(Math.log10(d) - 1);
  return Math.max(MIN_DIFFICULTY, Math.round(d / magnitude) * magnitude);
}
