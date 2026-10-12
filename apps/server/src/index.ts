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
import { AIWorkstation } from "./ai/workstation.js";
import { TextAPI } from "./ai/text-api.js";

const app = express();
app.use(express.json({ limit: "2mb" }));

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

const ai = new AIWorkstation({
  dir: config.ai.dir,
  workspace: config.ai.workspace,
  agentUser: config.ai.agentUser,
  protect: [config.dataDir, config.bitcoin.dataDir, "/etc/novaetheros.conf"],
  novaStatus: () => {
    const p = pool.snapshot();
    return {
      bitcoin_node: bitcoin.snapshot().node,
      solo_pool: { hashrate: p.hashrate, workers: p.workers.length, connected: p.workers.filter((w) => w.connected).length },
      miners: miners.snapshot(bitcoin.lanHost, config.pool.port).miners.map((m) => ({
        name: m.stats?.nickname || m.stats?.hostname || m.ip,
        ip: m.ip,
        online: m.online,
        hashrate_ghs: m.stats ? Math.round(m.stats.hashrate / 1e9) : null,
        temp_c: m.stats?.temp ?? null,
        power_w: m.stats?.power ?? null,
        pool: m.stats ? `${m.stats.pool.url}:${m.stats.pool.port}` : null,
      })),
    };
  },
});
ai.start();

app.get("/api/ai", handle(() => ai.status()));
app.post("/api/ai/settings", handle((req) => ai.saveSettings(req.body ?? {})));
app.post("/api/ai/install", handle(() => ai.install()));
app.post("/api/ai/models/pull", handle((req) => ai.pull(String(req.body?.name ?? ""))));
app.post("/api/ai/models/cancel", handle((req) => ai.cancelPull(String(req.body?.name ?? ""))));
app.post("/api/ai/models/remove", handle((req) => ai.removeModel(String(req.body?.name ?? ""))));
app.get("/api/ai/chats", handle(() => ai.list()));
app.post("/api/ai/chats", handle((req) => ai.create(req.body?.model, req.body?.mode)));
app.get("/api/ai/chats/:id", handle((req) => ai.view(String(req.params.id))));
app.delete("/api/ai/chats/:id", handle((req) => ai.remove(String(req.params.id))));
app.post("/api/ai/chats/:id/messages", handle((req) =>
  ai.send(String(req.params.id), String(req.body?.content ?? ""), req.body?.model, req.body?.mode)));
app.post("/api/ai/chats/:id/stop", handle((req) => ai.stop(String(req.params.id))));
app.post("/api/ai/chats/:id/approve", handle((req) => ai.approve(String(req.params.id), Boolean(req.body?.approve))));
app.get("/api/ai/workspace", handle((req) => ({
  path: ai.workspace.relative(ai.workspace.resolve(String(req.query.path ?? "."))),
  entries: ai.workspace.entries(String(req.query.path ?? ".")),
})));
app.get("/api/ai/workspace/file", handle((req) => ({ content: ai.workspace.readText(String(req.query.path ?? ""), 1_000_000) })));

// Public text API (API-key protected) and its management from the dashboard.
const textApi = new TextAPI(config.ai.dir, ai);
textApi.routes(app);
app.get("/api/ai/api", handle(() => textApi.snapshot()));
app.post("/api/ai/api/keys", handle((req) => textApi.createKey(String(req.body?.name ?? ""))));
app.delete("/api/ai/api/keys/:id", handle((req) => textApi.revokeKey(String(req.params.id))));
app.post("/api/ai/api/endpoints", handle((req) => textApi.saveEndpoint(req.body ?? {}, req.body?.original || undefined)));
app.delete("/api/ai/api/endpoints/:slug", handle((req) => textApi.deleteEndpoint(String(req.params.slug))));
app.post("/api/ai/api/endpoints/:slug/test", handle((req) => textApi.run(String(req.params.slug), req.body ?? {})));

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
