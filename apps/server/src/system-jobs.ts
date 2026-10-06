// Background jobs (updates, drive setup) run as their own transient systemd
// units, so they survive NovaEtherOS restarting itself part-way through.
//
// Every run gets a unique unit name: a leftover unit from an earlier run (still
// running, or failed and not yet cleaned up) can then never block a new one.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const RUNNING_STATES = new Set(["active", "activating", "deactivating", "reloading"]);

export async function unitRunning(unit: string | null) {
  if (!unit || process.platform !== "linux") return false;
  try {
    const { stdout } = await run("systemctl", ["is-active", unit]);
    return RUNNING_STATES.has(stdout.trim());
  } catch (err) {
    // is-active exits non-zero for inactive/failed units but still prints the state.
    return RUNNING_STATES.has(String((err as { stdout?: string }).stdout ?? "").trim());
  }
}

// Is any unit named <prefix>.service or <prefix>-*.service still running?
// (Catches runs started before unique names, or by another dashboard tab.)
export async function anyRunning(prefix: string) {
  if (process.platform !== "linux") return false;
  try {
    const { stdout } = await run("systemctl", [
      "list-units", "--no-legend", "--plain", "--state=active,activating,deactivating", `${prefix}.service`, `${prefix}-*.service`,
    ]);
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

export async function startJob(prefix: string, command: string[]) {
  const unit = `${prefix}-${Date.now()}`;
  await run("systemd-run", ["--unit", unit, "--collect", "--no-block", "--property=Type=oneshot", ...command]);
  return unit;
}

export async function unitLog(unit: string | null, sinceMs: number, lines = 300) {
  if (!unit || !sinceMs || process.platform !== "linux") return "";
  try {
    const { stdout } = await run("journalctl", [
      "-u", unit, "--since", `@${Math.floor(sinceMs / 1000)}`, "-o", "cat", "--no-pager", "-n", String(lines),
    ]);
    return stdout;
  } catch {
    return "";
  }
}
