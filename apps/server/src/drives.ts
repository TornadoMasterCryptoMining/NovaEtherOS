// Storage: lists the machine's drives for the dashboard and moves the Bitcoin
// node onto an external drive. The actual work is done by `nova setup-drive`,
// run as its own systemd unit because it restarts NovaEtherOS part-way through.

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { config } from "./config.js";
import { JsonStore } from "./bitcoin/store.js";
import { anyRunning, startJob, unitLog, unitRunning } from "./system-jobs.js";

const run = promisify(execFile);

const NOVA_CLI = "/usr/local/bin/nova";
const JOB_PREFIX = "nova-storage";
const SYSTEM_MOUNTS = new Set(["/", "/boot", "/boot/efi", "/usr", "/var", "[SWAP]"]);

interface LsblkDevice {
  name: string;
  path: string;
  size: number;
  model: string | null;
  tran: string | null;
  type: string;
  fstype: string | null;
  label: string | null;
  mountpoints: (string | null)[];
  rm: boolean | string;
  children?: LsblkDevice[];
}

export interface Drive {
  path: string;
  model: string;
  size: number;
  transport: string | null; // "usb", "sata", "nvme"...
  removable: boolean;
  system: boolean; // holds the running system: never offered for erasing
  empty: boolean; // e.g. a card reader with no card
  bitcoin: boolean; // the Bitcoin node's data lives here
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

function descendants(dev: LsblkDevice): LsblkDevice[] {
  return (dev.children ?? []).flatMap((c) => [c, ...descendants(c)]);
}

function mountsOf(dev: LsblkDevice): string[] {
  return [dev, ...descendants(dev)].flatMap((d) => (d.mountpoints ?? []).filter((m): m is string => Boolean(m)));
}

function space(mount: string) {
  try {
    const st = fs.statfsSync(mount);
    return { free: st.bavail * st.bsize, total: st.blocks * st.bsize };
  } catch {
    return { free: null, total: null };
  }
}

// Turn `lsblk -J -b` output into the dashboard's drive list.
export function parseDrives(
  lsblkJson: string,
  dataDir: string,
  spaceOf: (mount: string) => { free: number | null; total: number | null } = space,
): Drive[] {
  const devices: LsblkDevice[] = JSON.parse(lsblkJson).blockdevices ?? [];
  const disks = devices.filter((d) => d.type === "disk");

  // The drive holding the Bitcoin data is the one with the longest mount
  // point that contains the data folder.
  let bitcoinDisk: string | null = null;
  let best = -1;
  for (const disk of disks) {
    for (const m of mountsOf(disk)) {
      const inside = dataDir === m || dataDir.startsWith(m.endsWith("/") ? m : `${m}/`);
      if (inside && m.length > best) {
        best = m.length;
        bitcoinDisk = disk.path;
      }
    }
  }

  return disks.map((disk) => {
    const parts = (disk.children ?? []).filter((c) => c.type === "part");
    const mounts = mountsOf(disk);
    return {
      path: disk.path,
      model: (disk.model ?? "").trim() || disk.name,
      size: Number(disk.size) || 0,
      transport: disk.tran,
      // Older lsblk versions report "0"/"1" strings instead of booleans.
      removable: disk.rm === true || String(disk.rm) === "1",
      system: mounts.some((m) => SYSTEM_MOUNTS.has(m)),
      empty: !Number(disk.size),
      bitcoin: disk.path === bitcoinDisk,
      partitions: parts.map((p) => {
        const mountpoints = mountsOf(p);
        const usage = mountpoints[0] ? spaceOf(mountpoints[0]) : { free: null, total: null };
        return { path: p.path, size: Number(p.size) || 0, fstype: p.fstype, label: p.label, mountpoints, ...usage };
      }),
    };
  });
}

export class Storage {
  private job = new JsonStore(path.join(config.dataDir, "storage-job.json"), {
    started_at: 0,
    device: null as string | null,
    unit: null as string | null,
  });

  get supported() {
    return process.platform === "linux";
  }

  async drives(): Promise<Drive[]> {
    if (!this.supported) return [];
    const { stdout } = await run("lsblk", [
      "-J", "-b", "-o", "NAME,PATH,SIZE,MODEL,TRAN,TYPE,FSTYPE,LABEL,MOUNTPOINTS,RM",
    ]);
    return parseDrives(stdout, config.bitcoin.dataDir);
  }

  private async jobRunning() {
    return (await unitRunning(this.job.get("unit"))) || (await anyRunning(JOB_PREFIX));
  }

  private jobLog() {
    return unitLog(this.job.get("unit") ?? JOB_PREFIX, this.job.get("started_at"), 200);
  }

  async status() {
    let drives: Drive[] = [];
    let error: string | null = null;
    try {
      drives = await this.drives();
    } catch (err) {
      error = (err as Error).message;
    }
    return {
      supported: this.supported,
      data_dir: config.bitcoin.dataDir,
      drives,
      error,
      job: {
        running: await this.jobRunning(),
        device: this.job.get("device"),
        started_at: this.job.get("started_at"),
        log: await this.jobLog(),
      },
    };
  }

  // Erase `device`, mount it at boot and move the Bitcoin node onto it.
  async useForBitcoin(device: string, confirm: string, deleteOld: boolean) {
    if (!this.supported || !fs.existsSync(NOVA_CLI)) {
      throw new Error("Drive setup is only available on the NovaEtherOS machine.");
    }
    if (confirm !== "ERASE") throw new Error('Type ERASE to confirm.');
    if (await this.jobRunning()) throw new Error("A drive operation is already running.");

    const drive = (await this.drives()).find((d) => d.path === device);
    if (!drive) throw new Error(`Drive ${device} not found. Is it still connected?`);
    if (drive.system) throw new Error(`${device} holds the running system and can't be erased.`);
    if (drive.empty) throw new Error(`${device} has no disk in it (probably the card reader).`);
    if (drive.bitcoin) throw new Error("The Bitcoin node already uses this drive.");

    const startedAt = Date.now();
    const unit = await startJob(JOB_PREFIX, [
      NOVA_CLI, "setup-drive", device, "--yes", deleteOld ? "--delete-old" : "--keep-old",
    ]);
    this.job.update({ started_at: startedAt, device, unit });
  }
}
