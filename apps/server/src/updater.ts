// Self-update: checks GitHub for new commits and runs `nova update` as its own
// systemd unit, so the update survives NovaEtherOS restarting itself.

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { config } from "./config.js";
import { JsonStore } from "./bitcoin/store.js";

const run = promisify(execFile);

const NOVA_CLI = "/usr/local/bin/nova";
const UPDATE_UNIT = "nova-update";
const AUTO_CHECK_MS = 6 * 60 * 60 * 1000;

export interface Commit {
  sha: string;
  date: string;
  message: string;
}

function parseLog(stdout: string): Commit[] {
  return stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha, date, ...rest] = line.split("|");
      return { sha, date, message: rest.join("|") };
    });
}

async function git(...args: string[]) {
  try {
    const { stdout } = await run("git", ["-C", config.repoRoot, ...args], { timeout: 60_000 });
    return stdout.trim();
  } catch (err) {
    // Surface git's own explanation (e.g. "Could not resolve host: github.com").
    const lines = String((err as { stderr?: string }).stderr ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
    const reason = lines.find((l) => /^(fatal|error):/i.test(l)) ?? lines[0];
    throw new Error(reason ? reason.replace(/^(fatal|error):\s*/i, "") : (err as Error).message.split("\n")[0]);
  }
}

// True when `ancestor` is already contained in `commit`'s history.
async function isAncestor(ancestor: string, commit: string) {
  try {
    await run("git", ["-C", config.repoRoot, "merge-base", "--is-ancestor", ancestor, commit], { timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
}

export class Updater {
  private state = new JsonStore(path.join(config.dataDir, "update.json"), {
    started_at: 0,
    last_check: 0,
    latest: null as Commit | null,
    changes: [] as Commit[],
    check_error: null as string | null,
    // Result of the last successful check, and the installed commit it was made against.
    available: false,
    checked_head: null as string | null,
  });

  start() {
    void this.headSha().then((head) => {
      // Re-check on startup if it's due, or if the installed version changed
      // since the last check (e.g. right after an update).
      const due = Date.now() - this.state.get("last_check") > AUTO_CHECK_MS;
      if (due || head !== this.state.get("checked_head")) void this.check().catch(() => undefined);
    });
    setInterval(() => void this.check().catch(() => undefined), AUTO_CHECK_MS);
  }

  private async headSha() {
    try {
      return await git("rev-parse", "HEAD");
    } catch {
      return null;
    }
  }

  private async current(): Promise<Commit | null> {
    try {
      return parseLog(await git("log", "-1", "--format=%h|%cI|%s", "HEAD"))[0] ?? null;
    } catch {
      return null;
    }
  }

  // Why the dashboard can't run the update itself (null = it can).
  private unsupportedReason(): string | null {
    if (process.platform !== "linux") return "Updates can only be installed on the NovaEtherOS machine.";
    if (process.getuid?.() !== 0) return "NovaEtherOS is not running as root; update with: sudo nova update";
    if (!fs.existsSync(NOVA_CLI)) return "The nova command is missing; re-run the installer once to add it.";
    return null;
  }

  // Only one check at a time: git can't run two fetches in the same repo at once.
  private checking: Promise<unknown> | null = null;

  async check() {
    if (!this.checking) {
      this.checking = this.doCheck().finally(() => (this.checking = null));
    }
    await this.checking;
    return this.status();
  }

  private async doCheck() {
    try {
      const branch = (await git("rev-parse", "--abbrev-ref", "HEAD")) || "main";
      // Enough history to list what changed since the installed version.
      await git("fetch", "--depth", "30", "origin", branch);
      const latest = parseLog(await git("log", "-1", "--format=%h|%cI|%s", "FETCH_HEAD"))[0] ?? null;
      const head = await git("rev-parse", "HEAD");
      const remote = await git("rev-parse", "FETCH_HEAD");
      // Only offer an update when GitHub has something the installed version
      // doesn't already contain (never "update" to an older version).
      const available = head !== remote && !(await isAncestor(remote, head));
      let changes: Commit[] = [];
      if (available) {
        try {
          changes = parseLog(await git("log", "--format=%h|%cI|%s", "-n", "20", "HEAD..FETCH_HEAD"));
        } catch {
          // Installed version isn't in the fetched history; show the latest changes instead.
          changes = parseLog(await git("log", "--format=%h|%cI|%s", "-n", "5", "FETCH_HEAD"));
        }
      }
      this.state.update({ last_check: Date.now(), latest, changes, check_error: null, available, checked_head: head });
    } catch (err) {
      this.state.update({ last_check: Date.now(), check_error: (err as Error).message });
    }
  }

  private async running() {
    if (process.platform !== "linux") return false;
    try {
      const { stdout } = await run("systemctl", ["is-active", UPDATE_UNIT]);
      return ["active", "activating"].includes(stdout.trim());
    } catch {
      return false;
    }
  }

  private async log() {
    const since = this.state.get("started_at");
    if (!since || process.platform !== "linux") return "";
    try {
      const { stdout } = await run("journalctl", [
        "-u", UPDATE_UNIT, "--since", `@${Math.floor(since / 1000)}`, "-o", "cat", "--no-pager", "-n", "300",
      ]);
      return stdout;
    } catch {
      return "";
    }
  }

  async status() {
    const current = await this.current();
    // A check made against a different installed version no longer applies.
    const fresh = (await this.headSha()) === this.state.get("checked_head");
    const available = fresh && this.state.get("available");
    return {
      current,
      latest: fresh ? this.state.get("latest") : null,
      available,
      changes: available ? this.state.get("changes") : [],
      last_check: this.state.get("last_check"),
      check_error: this.state.get("check_error"),
      running: await this.running(),
      started_at: this.state.get("started_at"),
      log: await this.log(),
      unsupported: this.unsupportedReason(),
    };
  }

  async update() {
    const reason = this.unsupportedReason();
    if (reason) throw new Error(reason);
    if (await this.running()) throw new Error("An update is already running.");
    this.state.update({ started_at: Date.now() });
    // A separate transient unit: NovaEtherOS restarts during the update, and
    // anything in its own process group would be killed with it.
    await run("systemd-run", ["--unit", UPDATE_UNIT, "--collect", "--no-block", "--property=Type=oneshot", NOVA_CLI, "update"]);
  }
}
