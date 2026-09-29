import { execFile } from "node:child_process";
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
  icon: string;
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

function compose(id: string, ...args: string[]) {
  const file = path.join(config.appStoreDir, id, "docker-compose.yml");
  return run("docker", ["compose", "-p", `nova-${id}`, "-f", file, ...args], {
    env: { ...process.env, APP_DATA_DIR: path.join(config.dataDir, "apps", id) },
  });
}

async function assertKnown(id: string) {
  const apps = await listStoreApps();
  if (!apps.some((a) => a.id === id)) throw new Error(`Unknown app: ${id}`);
}

export async function installApp(id: string) {
  await assertKnown(id);
  await compose(id, "up", "-d");
  const installed = new Set(await listInstalled()).add(id);
  await saveInstalled([...installed]);
}

export async function uninstallApp(id: string) {
  await assertKnown(id);
  await compose(id, "down");
  await saveInstalled((await listInstalled()).filter((a) => a !== id));
}
