import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const dataDir = path.resolve(repoRoot, process.env.DATA_DIR ?? "data");
const bitcoinDataDir = path.resolve(process.env.BITCOIN_DATA_DIR ?? path.join(dataDir, "bitcoin"));

export const config = {
  port: Number(process.env.PORT ?? 3000),
  appStoreDir: path.resolve(repoRoot, process.env.APP_STORE_DIR ?? "app-store"),
  dataDir,
  webDist: path.resolve(repoRoot, "apps/web/dist"),

  // Built-in Bitcoin node (Bitcoin Core runs natively as a systemd service)
  bitcoin: {
    bitcoind: process.env.BITCOIND_BIN ?? "/usr/local/bin/bitcoind",
    service: "nova-bitcoind",
    // Blockchain data, owned by the `bitcoin` system user
    dataDir: bitcoinDataDir,
    confPath: path.join(bitcoinDataDir, "nova.conf"),
    // NovaEtherOS's own settings, state and RPC credentials for the node
    stateDir: path.join(dataDir, "bitcoin-nova"),
    rpcPort: 8332,
    p2pPort: 8333,
    zmqPorts: {
      rawblock: 28332,
      rawtx: 28333,
      hashblock: 28334,
      sequence: 28335,
      hashtx: 28336,
    },
  },
};
