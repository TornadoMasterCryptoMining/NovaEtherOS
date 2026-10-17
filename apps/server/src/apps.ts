import { execFile } from "node:child_process";
import crypto from "node:crypto";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";

const run = promisify(execFile);

export interface AppManifest {
  id: string;
  name: string;
  tagline: string;
  category: string;
  port: number;
  path?: string; // where the web UI lives, if not at / (e.g. Pi-hole: /admin/)
  // Passwords NovaEtherOS generates for the app, passed to docker compose as env vars
  secrets?: { env: string; label: string }[];
  // How to log in, shown on the Apps page
  login?: { user?: string; hint?: string };
}

const stateFile = () => path.join(config.dataDir, "installed.json");

export async function listStoreApps(): Promise<AppManifest[]> {
  const entries = await fs.readdir(config.appStoreDir, { withFileTypes: true });
  const apps = await Promise.all(
    entries
      .filter((e) => e.isDirectory())
      .map(async (e) => {
        const raw = await fs.readFile(path.join(config.appStoreDir, e.name, "app.json"), "utf8");
        return { ...JSON.parse(raw), id: e.name } as AppManifest;
      }),
  );
  return apps.sort((a, b) => a.name.localeCompare(b.name));
}

export async function listInstalled(): Promise<string[]> {
  try {
    return JSON.parse(await fs.readFile(stateFile(), "utf8"));
  } catch {
    return [];
  }
}

async function saveInstalled(ids: string[]) {
  await fs.mkdir(config.dataDir, { recursive: true });
  await fs.writeFile(stateFile(), JSON.stringify(ids, null, 2));
}

// Passwords NovaEtherOS creates for an app (e.g. Pi-hole's), passed to its
// compose file as environment variables. Kept outside the app's own data
// folder, since some apps mount that whole folder.
const secretsFile = (id: string) => path.join(config.dataDir, "app-secrets", `${id}.json`);

async function readSecrets(id: string): Promise<Record<string, string>> {
  try {
    return JSON.parse(await fs.readFile(secretsFile(id), "utf8"));
  } catch {
    return {};
  }
}

// Easy to read and type: no 0/O or 1/l/I.
function newPassword(length = 16) {
  const chars = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.randomBytes(length);
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}

async function ensureSecrets(app: AppManifest, regenerate = false) {
  const stored = await readSecrets(app.id);
  let changed = false;
  for (const s of app.secrets ?? []) {
    if (regenerate || !stored[s.env]) {
      stored[s.env] = newPassword();
      changed = true;
    }
  }
  if (changed) {
    await fs.mkdir(path.dirname(secretsFile(app.id)), { recursive: true });
    await fs.writeFile(secretsFile(app.id), JSON.stringify(stored, null, 2), { mode: 0o600 });
  }
  return stored;
}

async function compose(id: string, ...args: string[]) {
  const file = path.join(config.appStoreDir, id, "docker-compose.yml");
  return run("docker", ["compose", "-p", `nova-${id}`, "-f", file, ...args], {
    env: { ...process.env, ...(await readSecrets(id)), APP_DATA_DIR: path.join(config.dataDir, "apps", id) },
    maxBuffer: 10 * 1024 * 1024,
  });
}

async function getApp(id: string) {
  const app = (await listStoreApps()).find((a) => a.id === id);
  if (!app) throw new Error(`Unknown app: ${id}`);
  return app;
}

export async function installApp(id: string) {
  await ensureSecrets(await getApp(id));
  await compose(id, "up", "-d");
  const installed = new Set(await listInstalled()).add(id);
  await saveInstalled([...installed]);
}

export async function uninstallApp(id: string) {
  await getApp(id);
  await compose(id, "down");
  await saveInstalled((await listInstalled()).filter((a) => a !== id));
}

// How to log in to an installed app: its user name, a hint, and any password
// NovaEtherOS made for it. `needs_reset` means the app was installed before
// NovaEtherOS managed its password, so one has to be set first.
export async function appLogin(id: string) {
  const app = await getApp(id);
  const stored = await readSecrets(id);
  const secrets = (app.secrets ?? []).map((s) => ({ label: s.label, value: stored[s.env] ?? null }));
  return {
    user: app.login?.user ?? null,
    hint: app.login?.hint ?? null,
    secrets,
    can_reset: secrets.length > 0,
    needs_reset: secrets.some((s) => !s.value),
  };
}

// Make new passwords and restart the app with them.
export async function resetAppLogin(id: string) {
  const app = await getApp(id);
  if (!app.secrets?.length) throw new Error(`${app.name} manages its own login.`);
  await ensureSecrets(app, true);
  await compose(id, "up", "-d", "--force-recreate");
  return appLogin(id);
}

export async function appLogs(id: string) {
  await getApp(id);
  const { stdout, stderr } = await compose(id, "logs", "--tail", "300", "--no-color", "--no-log-prefix");
  return (stdout + stderr).trim() || "(no output yet)";
}
