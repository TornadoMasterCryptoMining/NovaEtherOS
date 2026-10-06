// Built-in Bitcoin node: NovaEtherOS plans storage, writes bitcoin.conf and
// drives the `nova-bitcoind` systemd service that runs Bitcoin Core natively.
// Ported from NovaMiningShop's nova/node.py supervisor.

import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { config } from "../config.js";
import { Explorer } from "./explorer.js";
import { RPC, RPC_IN_WARMUP, RPCError, RPCUnavailable } from "./rpc.js";
import { JsonStore } from "./store.js";
import {
  DEFAULT_SETTINGS,
  GB,
  MIB,
  guardDecision,
  performanceProfile,
  planStorage,
  scanHardware,
  type HardwareScan,
  type PerformanceProfile,
  type StoragePlan,
  type StorageSettings,
  type StorageState,
} from "./storage.js";

const run = promisify(execFile);

const PRIVATE_NETWORKS = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10"]; // LAN + Tailscale
const POLL_MS = 10_000;
const GUARD_MS = 60_000;
const WAIT_FOR_STORAGE_MS = 300_000;
const MAX_EVENTS = 50;

type NodeStatus =
  | "not_installed"
  | "starting"
  | "syncing"
  | "running"
  | "waiting_for_storage"
  | "error"
  | "stopped";

interface NodeInfo {
  state: NodeStatus;
  message: string;
  [key: string]: unknown;
}

interface NodeState extends StorageState {
  events?: { time: number; level: "info" | "error"; message: string }[];
}

interface Applied {
  mode: StoragePlan["mode"];
  prune_mib: number;
  txindex: boolean;
}

function lanAddress() {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal && !a.address.startsWith("172.")) return a.address;
    }
  }
  return os.hostname();
}

export class BitcoinNode {
  private cfg = config.bitcoin;
  private settings = new JsonStore<StorageSettings>(path.join(this.cfg.stateDir, "settings.json"), DEFAULT_SETTINGS);
  private state = new JsonStore<NodeState>(path.join(this.cfg.stateDir, "state.json"), {});
  private secrets = new JsonStore(path.join(this.cfg.stateDir, "secrets.json"), { rpc_user: "nova", rpc_pass: "" }, 0o600);
  readonly rpc: RPC;
  readonly explorer: Explorer;

  private installed = false;
  private node: NodeInfo = { state: "starting", message: "Scanning hardware..." };
  private scan: HardwareScan | null = null;
  private plan: StoragePlan | null = null;
  private profile: PerformanceProfile | null = null;
  private applied: Applied | null = null;
  private pendingReindexCleanup = false;
  private applying: Promise<void> = Promise.resolve();
  private storageTimer: NodeJS.Timeout | null = null;

  constructor() {
    if (!this.secrets.get("rpc_pass")) {
      this.secrets.update({ rpc_pass: crypto.randomBytes(32).toString("hex") });
    }
    this.rpc = new RPC(`http://127.0.0.1:${this.cfg.rpcPort}`, this.secrets.get("rpc_user"), this.secrets.get("rpc_pass"));
    this.explorer = new Explorer(this.rpc);
  }

  get isInstalled() {
    return this.installed;
  }

  // Synced and serving RPC: ready to hand out mining work.
  get isSynced() {
    return this.node.state === "running";
  }

  get lanHost() {
    return lanAddress();
  }

  // Lets other built-in services (the solo pool) add to the activity feed.
  logEvent(message: string, level: "info" | "error" = "info") {
    this.event(message, level);
  }

  // --- lifecycle -----------------------------------------------------------

  async start() {
    this.installed = process.platform === "linux" && fs.existsSync(this.cfg.bitcoind);

    if (!this.installed) {
      fs.mkdirSync(this.cfg.dataDir, { recursive: true });
      // Dev machines: still show the storage plan so the dashboard can be built.
      this.scan = await scanHardware(this.cfg.dataDir);
      this.plan = planStorage(this.scan, this.settings.snapshot(), this.state.snapshot());
      this.setNode("not_installed", "Bitcoin Core is not installed on this machine. Run the NovaEtherOS installer on Debian.");
      return;
    }

    await this.apply("NovaEtherOS started.");
    this.explorer.start();
    setInterval(() => void this.poll(), POLL_MS);
    setInterval(() => void this.guard(), GUARD_MS);
  }

  // Scan, plan, write bitcoin.conf and (re)start Bitcoin Core if anything changed.
  apply(reason: string, forceRestart = false): Promise<void> {
    this.applying = this.applying.then(() => this.doApply(reason, forceRestart)).catch((err) => {
      this.event(`Could not start Bitcoin Core: ${(err as Error).message}`, "error");
      this.setNode("error", (err as Error).message);
    });
    return this.applying;
  }

  private async doApply(reason: string, forceRestart: boolean) {
    if (this.storageTimer) clearTimeout(this.storageTimer);

    // The data folder is created by the installer (or `nova setup-drive`). If
    // it's missing, the external drive is probably unplugged: wait for it
    // rather than start a fresh node on the internal disk.
    if (!fs.existsSync(this.cfg.dataDir)) {
      if (await this.serviceActive()) await this.systemctl("stop");
      this.applied = null;
      this.setNode(
        "waiting_for_storage",
        `Bitcoin data folder ${this.cfg.dataDir} not found. Is the external drive connected? Checking again every minute.`,
      );
      this.storageTimer = setTimeout(() => void this.apply("Bitcoin data drive is back."), 60_000);
      return;
    }

    const settings = this.settings.snapshot();
    const scan = await scanHardware(this.cfg.dataDir);
    const plan = planStorage(scan, settings, this.state.snapshot());
    this.scan = scan;
    this.plan = plan;

    if (plan.status !== "ok") {
      if (await this.serviceActive()) await this.systemctl("stop");
      this.applied = null;
      this.setNode("waiting_for_storage", plan.reasons[0]);
      this.storageTimer = setTimeout(() => void this.apply("Re-checking free space."), WAIT_FOR_STORAGE_MS);
      return;
    }

    const ibd = !this.state.get("ibd_complete");
    this.profile = performanceProfile(scan.ram, ibd, settings.dbcache_mb);
    const txindex = settings.txindex && plan.mode === "full";
    if (plan.reindex) {
      this.settings.update({ confirm_resync: false });
      this.pendingReindexCleanup = true;
      this.event("Converting to a full node: re-downloading the complete blockchain.");
    }

    const changed = this.writeConf(plan, this.profile, txindex, plan.reindex);
    const active = await this.serviceActive();
    this.applied = { mode: plan.mode, prune_mib: plan.prune_mib, txindex };

    if (!active || changed || forceRestart) {
      this.event(reason);
      this.event(this.describeStart(plan, this.profile));
      this.setNode("starting", "Starting Bitcoin Core...");
      await this.systemctl(active ? "restart" : "start");
    }
  }

  private describeStart(plan: StoragePlan, profile: PerformanceProfile) {
    const storage =
      plan.mode === "full" ? "full node" : `pruned node keeping ~${((plan.prune_mib * MIB) / GB).toFixed(1)} GB of blocks`;
    return (
      `Starting Bitcoin Core as a ${storage}; '${profile.tier}' performance profile ` +
      `(dbcache ${profile.dbcache} MiB, ${profile.maxconnections} peers).`
    );
  }

  // --- bitcoin.conf --------------------------------------------------------

  // Returns true when the file content changed.
  private writeConf(plan: StoragePlan, profile: PerformanceProfile, txindex: boolean, reindex: boolean) {
    const c = this.cfg;
    const custom = path.join(c.dataDir, "nova-custom.conf");
    const lines = [
      "# Generated by NovaEtherOS. Manual edits here are overwritten.",
      "# Add your own options to nova-custom.conf in the same folder instead.",
      "chain=main",
      ...(fs.existsSync(custom) ? [`includeconf=${custom}`] : []),
      "[main]",
      "server=1",
      "listen=1",
      "nodebuglogfile=1",
      "printtoconsole=1",
      ...(reindex ? ["reindex=1"] : []),
      `prune=${plan.prune_mib}`,
      `txindex=${txindex ? 1 : 0}`,
      `dbcache=${profile.dbcache}`,
      `maxmempool=${profile.maxmempool}`,
      `maxconnections=${profile.maxconnections}`,
      `maxuploadtarget=${profile.maxuploadtarget}`,
      // Mining pools poll getblocktemplate a lot; give RPC some headroom.
      "rpcthreads=8",
      "rpcworkqueue=128",
      `rpcuser=${this.secrets.get("rpc_user")}`,
      `rpcpassword=${this.secrets.get("rpc_pass")}`,
      `rpcport=${c.rpcPort}`,
      `rpcbind=0.0.0.0:${c.rpcPort}`,
      "rpcallowip=127.0.0.1",
      ...PRIVATE_NETWORKS.map((net) => `rpcallowip=${net}`),
      `port=${c.p2pPort}`,
      `bind=0.0.0.0:${c.p2pPort}`,
      ...Object.entries(c.zmqPorts).map(([topic, port]) => `zmqpub${topic}=tcp://0.0.0.0:${port}`),
    ];
    const content = lines.join("\n") + "\n";

    let previous = "";
    try {
      previous = fs.readFileSync(c.confPath, "utf8");
    } catch {
      // first run
    }
    if (previous === content) return false;

    const tmp = `${c.confPath}.tmp`;
    fs.writeFileSync(tmp, content, { mode: 0o600 });
    const owner = this.bitcoinUser();
    if (owner) fs.chownSync(tmp, owner.uid, owner.gid);
    fs.renameSync(tmp, c.confPath);
    return true;
  }

  private bitcoinUser(): { uid: number; gid: number } | null {
    try {
      const st = fs.statSync(this.cfg.dataDir);
      return { uid: st.uid, gid: st.gid };
    } catch {
      return null;
    }
  }

  // --- systemd -------------------------------------------------------------

  private async systemctl(action: "start" | "stop" | "restart") {
    // Bitcoin Core may take minutes to flush on stop; the unit allows 15 min.
    await run("systemctl", [action, this.cfg.service], { timeout: 16 * 60_000 });
  }

  private async serviceActive() {
    try {
      const { stdout } = await run("systemctl", ["is-active", this.cfg.service]);
      return stdout.trim() === "active";
    } catch {
      return false;
    }
  }

  async logs(lines = 200): Promise<string> {
    if (!this.installed) return "";
    try {
      const { stdout } = await run("journalctl", ["-u", this.cfg.service, "-n", String(lines), "--no-pager", "-o", "cat"]);
      return stdout;
    } catch (err) {
      return (err as Error).message;
    }
  }

  // --- monitoring ----------------------------------------------------------

  private setNode(state: NodeStatus, message: string, extra: Record<string, unknown> = {}) {
    this.node = { state, message, ...extra };
  }

  private event(message: string, level: "info" | "error" = "info") {
    console.log(`[bitcoin] ${message}`);
    const events = [...(this.state.get("events") ?? []), { time: Math.floor(Date.now() / 1000), level, message }];
    this.state.update({ events: events.slice(-MAX_EVENTS) });
  }

  private async poll() {
    if (this.node.state === "waiting_for_storage") return;
    let chain, net, mempool, mining;
    try {
      [chain, net, mempool, mining] = await Promise.all([
        this.rpc.call("getblockchaininfo"),
        this.rpc.call("getnetworkinfo"),
        this.rpc.call("getmempoolinfo"),
        this.rpc.call("getmininginfo"),
      ]);
    } catch (err) {
      if (err instanceof RPCError) {
        this.setNode(err.code === RPC_IN_WARMUP ? "starting" : "error", err.message);
      } else if (err instanceof RPCUnavailable) {
        const active = await this.serviceActive();
        this.setNode(
          active ? "starting" : "error",
          active
            ? "Waiting for Bitcoin Core to open its RPC port..."
            : "Bitcoin Core is not running. It restarts automatically; see Logs for details.",
        );
      }
      return;
    }

    if (this.pendingReindexCleanup && this.plan && this.profile && this.applied) {
      // Reindex has started; make sure a later restart doesn't start it over.
      this.writeConf(this.plan, this.profile, this.applied.txindex, false);
      this.pendingReindexCleanup = false;
    }

    const ibd: boolean = chain.initialblockdownload ?? true;
    this.setNode(ibd ? "syncing" : "running", ibd ? "Syncing the blockchain" : "Synced", {
      blocks: chain.blocks,
      headers: chain.headers,
      progress: chain.verificationprogress ?? 0,
      ibd,
      size_on_disk: chain.size_on_disk,
      pruned: chain.pruned ?? false,
      prune_height: chain.pruneheight,
      peers: net.connections ?? 0,
      peers_in: net.connections_in ?? 0,
      peers_out: net.connections_out ?? 0,
      version: net.subversion,
      mempool_bytes: mempool.usage ?? 0,
      mempool_tx: mempool.size ?? 0,
      network_hashps: mining.networkhashps,
      difficulty: mining.difficulty,
    });

    if (!ibd && !this.state.get("ibd_complete")) {
      this.state.update({ ibd_complete: true });
      this.event("Initial blockchain sync complete. Your node is ready for mining.");
    }
    if (!ibd && !chain.pruned) this.state.update({ observed_full_size: chain.size_on_disk });
  }

  private async guard() {
    if (!this.applied) return;
    if (!fs.existsSync(this.cfg.dataDir)) {
      await this.apply("Bitcoin data drive disconnected.");
      return;
    }
    try {
      const scan = await scanHardware(this.cfg.dataDir);
      const settings = this.settings.snapshot();
      this.scan = scan;
      this.plan = planStorage(scan, settings, this.state.snapshot());
      const reason = guardDecision(scan, settings, this.state.snapshot(), this.applied.prune_mib);
      if (reason) await this.apply(reason, true);
    } catch (err) {
      console.error("[bitcoin] storage guard error:", err);
    }
  }

  // --- dashboard API -------------------------------------------------------

  restartNeeded() {
    if (!this.plan || !this.applied) return false;
    const txindex = this.settings.get("txindex") && this.plan.mode === "full";
    return (
      this.plan.mode !== this.applied.mode ||
      this.plan.prune_mib !== this.applied.prune_mib ||
      this.plan.reindex ||
      txindex !== this.applied.txindex
    );
  }

  saveSettings(body: Partial<StorageSettings>) {
    const clean: Partial<StorageSettings> = {};
    if (body.storage_mode && ["auto", "full", "prune"].includes(body.storage_mode)) clean.storage_mode = body.storage_mode;
    if (body.prune_gb != null && Number(body.prune_gb) > 0) clean.prune_gb = Number(body.prune_gb);
    if ("reserve_gb" in body) clean.reserve_gb = body.reserve_gb == null || body.reserve_gb === ("" as any) ? null : Math.max(0, Number(body.reserve_gb));
    if ("dbcache_mb" in body) clean.dbcache_mb = body.dbcache_mb ? Math.max(4, Math.floor(Number(body.dbcache_mb))) : null;
    if ("txindex" in body) clean.txindex = Boolean(body.txindex);
    if ("confirm_resync" in body) clean.confirm_resync = Boolean(body.confirm_resync);
    this.settings.update(clean);
    if (this.scan) this.plan = planStorage(this.scan, this.settings.snapshot(), this.state.snapshot());
    // Re-check immediately if the node is waiting for space or in an error state.
    if (this.installed && ["waiting_for_storage", "error"].includes(this.node.state)) void this.apply("Settings changed.");
    return this.snapshot();
  }

  restart() {
    if (!this.installed) throw new Error("Bitcoin Core is not installed on this machine.");
    void this.apply("Restart requested from the dashboard.", true);
  }

  snapshot() {
    const c = this.cfg;
    return {
      installed: this.installed,
      node: this.node,
      storage: {
        data_dir: c.dataDir,
        scan: this.scan,
        plan: this.plan,
        applied: this.applied,
        restart_needed: this.restartNeeded(),
      },
      profile: this.profile,
      settings: this.settings.snapshot(),
      connection: {
        host: lanAddress(),
        rpc_port: c.rpcPort,
        p2p_port: c.p2pPort,
        rpc_user: this.secrets.get("rpc_user"),
        rpc_pass: this.secrets.get("rpc_pass"),
        zmq: c.zmqPorts,
      },
      events: [...(this.state.get("events") ?? [])].reverse().slice(0, 20),
    };
  }

  async miningCheck() {
    const checks: { name: string; ok: boolean; detail: string }[] = [];
    const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
    const n = this.node;

    add("Bitcoin Core running", ["running", "syncing"].includes(n.state), n.message);
    const synced = n.ibd === false;
    add(
      "Blockchain synced",
      synced,
      synced ? `Synced to block ${Number(n.blocks).toLocaleString()}` : "Miners can connect once the initial sync finishes.",
    );
    add("Connected to peers", Number(n.peers ?? 0) > 0, `${n.peers ?? 0} peers`);
    try {
      const t = await this.rpc.call("getblocktemplate", [{ rules: ["segwit"] }], 20_000);
      add(
        "Block template",
        true,
        `Height ${t.height.toLocaleString()}, ${t.transactions?.length ?? 0} transactions, ` +
          `reward ${(t.coinbasevalue / 1e8).toFixed(8)} BTC`,
      );
    } catch (err) {
      add("Block template", false, (err as Error).message);
    }
    return checks;
  }
}
