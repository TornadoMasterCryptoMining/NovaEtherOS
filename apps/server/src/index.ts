import express from "express";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { getSystemStats } from "./system.js";
import { installApp, listInstalled, listStoreApps, uninstallApp } from "./apps.js";

const app = express();
app.use(express.json());

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
