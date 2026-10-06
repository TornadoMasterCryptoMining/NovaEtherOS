import express from "express";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { getSystemStats } from "./system.js";
import { installApp, listInstalled, listStoreApps, uninstallApp } from "./apps.js";
import { BitcoinNode } from "./bitcoin/node.js";
import { Updater } from "./updater.js";
import { SoloPool } from "./pool/pool.js";
import { Storage } from "./drives.js";
import { Miners } from "./miners/miners.js";

const app = express();
app.use(express.json());

const updater = new Updater();
updater.start();

app.get("/api/update", async (_req, res) => {
  res.json(await updater.status());
});

app.post("/api/update/check", async (_req, res) => {
  res.json(await updater.check());
});

app.post("/api/update", async (_req, res) => {
  try {
    await updater.update();
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ ok: false, error: (err as Error).message });
  }
});

const storage = new Storage();

app.get("/api/storage", async (_req, res) => {
  res.json(await storage.status());
});

app.post("/api/storage/use-for-bitcoin", async (req, res) => {
  try {
    const { device, confirm, deleteOld } = req.body ?? {};
    await storage.useForBitcoin(String(device ?? ""), String(confirm ?? ""), Boolean(deleteOld));
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ ok: false, error: (err as Error).message });
  }
});

const bitcoin = new BitcoinNode();
bitcoin.start().catch((err) => console.error("[bitcoin] failed to start:", err));

const pool = new SoloPool({
  rpc: bitcoin.rpc,
  isNodeReady: () => bitcoin.isSynced,
  dataDir: config.pool.dataDir,
  port: config.pool.port,
  log: (message, level) => bitcoin.logEvent(`Solo pool: ${message}`, level),
});
pool.start().catch((err) => console.error("[pool] failed to start:", err));

app.get("/api/pool", (_req, res) => {
  res.json({ host: bitcoin.lanHost, ...pool.snapshot() });
});

const miners = new Miners(config.dataDir);
miners.start();

// Wrap handlers so errors come back as { ok: false, error } with a 400.
const handle =
  (fn: (req: express.Request) => Promise<unknown> | unknown) =>
  async (req: express.Request, res: express.Response) => {
    try {
      res.json((await fn(req)) ?? { ok: true });
    } catch (err) {
      res.status(400).json({ ok: false, error: (err as Error).message });
    }
  };

app.get("/api/miners", (_req, res) => {
  res.json(miners.snapshot(bitcoin.lanHost, config.pool.port));
});
app.post("/api/miners/scan", handle(() => void miners.scan()));
app.post("/api/miners", handle(async (req) => ({ ok: true, id: await miners.add(String(req.body?.ip ?? "").trim()) })));
app.delete("/api/miners/:id", handle((req) => miners.remove(String(req.params.id))));
app.post("/api/miners/:id/settings", handle((req) => miners.applySettings(String(req.params.id), req.body ?? {})));
app.post("/api/miners/:id/restart", handle((req) => miners.restart(String(req.params.id))));

app.get("/api/bitcoin", (_req, res) => {
  res.json(bitcoin.snapshot());
});

app.post("/api/bitcoin/settings", (req, res) => {
  res.json(bitcoin.saveSettings(req.body ?? {}));
});

app.post("/api/bitcoin/restart", (_req, res) => {
  try {
    bitcoin.restart();
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ ok: false, error: (err as Error).message });
  }
});

app.get("/api/bitcoin/mining-check", async (_req, res) => {
  res.json(await bitcoin.miningCheck());
});

app.get("/api/bitcoin/explorer", (_req, res) => {
  res.json({ installed: bitcoin.isInstalled, ...bitcoin.explorer.snapshot() });
});

app.get("/api/bitcoin/logs", async (_req, res) => {
  res.type("text/plain").send(await bitcoin.logs());
});

app.get("/api/system", async (_req, res) => {
  res.json(await getSystemStats());
});

app.get("/api/apps", async (_req, res) => {
  const [store, installed] = await Promise.all([listStoreApps(), listInstalled()]);
  res.json(store.map((a) => ({ ...a, installed: installed.includes(a.id) })));
});

app.post("/api/apps/:id/install", async (req, res) => {
  try {
    await installApp(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

app.post("/api/apps/:id/uninstall", async (req, res) => {
  try {
    await uninstallApp(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// Serve the built dashboard in production
if (fs.existsSync(config.webDist)) {
  app.use(express.static(config.webDist));
  app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(config.webDist, "index.html")));
}

app.listen(config.port, () => {
  console.log(`NovaEtherOS running on http://localhost:${config.port}`);
});
