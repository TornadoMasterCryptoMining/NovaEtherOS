import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export const config = {
  port: Number(process.env.PORT ?? 3000),
  appStoreDir: path.resolve(repoRoot, process.env.APP_STORE_DIR ?? "app-store"),
  dataDir: path.resolve(repoRoot, process.env.DATA_DIR ?? "data"),
  webDist: path.resolve(repoRoot, "apps/web/dist"),
};
