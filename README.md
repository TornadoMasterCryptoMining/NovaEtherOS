# NovaEtherOS

A self-hosted home cloud dashboard, inspired by UmbrelOS. Runs on a regular Debian install — no image flashing — and turns the machine (e.g. an old MacBook Air) into a personal server with a web dashboard and a one-click app store.

## Features

- **Built-in Bitcoin node** — Bitcoin Core runs natively (no Docker) with Smart Storage auto-pruning, hardware auto-tuning and a mining check
- **Built-in solo mining pool** — point your Bitaxe / NerdMiner / Antminer at your own node; rewards go straight to your address
- **Blocks & Mempool** — live blocks, mempool and fee estimates from your own node
- **Nova AI** — your own coding agent on local models (Ollama, native, no Docker): it writes files, runs commands and tests in a sandboxed workspace, with your approval
- **One-click updates** — from the dashboard, or `sudo nova update`
- **Dashboard** — sidebar navigation, live status bar, an Overview of node, mining, AI and machine health; light, dark or automatic theme, works on phones
- **App Store** — install/uninstall self-hosted apps (Nextcloud, Jellyfin, Pi-hole, Uptime Kuma) as Docker containers
- **Runs as a systemd service** — starts on boot, reachable from any device on your network

## Install on Debian

1. Install Debian 12+ on the machine (for a MacBook Air, the standard Debian installer works; you may need the `firmware-b43-installer` or `broadcom-sta-dkms` package for Wi-Fi, or use Ethernet during setup).
2. Run:

   ```bash
   wget -O install.sh https://raw.githubusercontent.com/TornadoMasterCryptoMining/NovaEtherOS/main/scripts/install.sh
   sudo bash install.sh
   ```

3. Open `http://<machine-ip>` from any device on your network.

The installer sets up Docker Engine, Node.js 22 and Bitcoin Core, clones this repo to `/opt/novaetheros`, builds it and registers the systemd services.

## Updating

Open **Settings → Software update** in the dashboard and click **Update now**, or run `sudo nova update`. NovaEtherOS checks GitHub for updates every 6 hours and shows a banner on Home when one is available. Updating restarts the dashboard for about a minute; the Bitcoin node keeps running.

The `nova` command:

```bash
sudo nova update     # update NovaEtherOS
nova check           # is an update available?
nova status          # service status
nova logs            # dashboard logs (nova logs bitcoin / nova logs update)
```

## Built-in Bitcoin node

The installer downloads Bitcoin Core 31.1 from bitcoincore.org, verifies its SHA-256 checksum, and installs it as the `nova-bitcoind` systemd service running as a dedicated `bitcoin` user. Blockchain data lives in `/var/lib/novaetheros/bitcoin`.

NovaEtherOS manages the node (ported from the NovaMiningShop Umbrel app):

| Situation | What happens |
|---|---|
| Plenty of space (≈900 GB+ available for Bitcoin) | Full node |
| Less space (e.g. a MacBook Air SSD) | Pruned node keeping as many recent blocks as fit |
| Not enough space to run at all | Waits, shows how much to free up, then starts by itself |
| Drive fills up while running | Storage guard lowers the prune size and restarts Bitcoin Core |

It always keeps a reserve free for the OS (5% of the drive, 10–50 GB) and tunes the database cache, peers and mempool to the machine's RAM, using a bigger cache during the first sync.

The **Bitcoin → Node** page shows sync progress, storage plan, settings (Automatic / Full node / Prune to N GB), RPC connection details and a one-click mining check.

## Solo mining pool

NovaEtherOS has a built-in stratum pool (no Docker), fed directly by your node's block templates. Point any miner at it:

| Setting | Value |
|---|---|
| Pool address | your NovaEtherOS machine's IP |
| Port | `2018` |
| User | `<your bitcoin address>.<worker name>` |
| Password | `x` |

- Every block found pays the full reward (subsidy + fees) straight to the address in the miner's user name. No pool fee.
- Supports version rolling (ASICBoost), vardiff and `suggest_difficulty`, so Bitaxe, NerdMiner and Antminer work out of the box.
- The pool only hands out work once the node is synced; until then miners are disconnected so they fail over to their backup pool.
- **Self-test:** on every new block the pool asks Bitcoin Core to validate a block built exactly like the ones it submits (proposal mode, proof-of-work aside), and shows the result on the Solo Mining page.

The **Solo Mining** page shows miners, hashrate, best share, expected time to a block and any blocks found. Found blocks are also highlighted on **Blocks & Mempool**.

## Miners

The **Miners** page finds Bitaxe-family miners on your network by itself (any firmware with the AxeOS / ESP-Miner API, including NovaForge / NovaMiningOS) and re-scans every 30 minutes, following a miner by its MAC address if its IP changes. You can also add one by IP.

For each miner it shows hashrate (now and 1 h), chip and regulator temperature, power and efficiency (J/TH), fan, shares, best difficulty, uptime, and which pool it's on (with a badge when it's mining to this NovaEtherOS). **Tune** changes clock, core voltage, fan (auto with a temperature target, or fixed) within the same limits as the miner's own settings page; clock/voltage changes restart the miner. Pool settings are left to you, on the miner itself.

## Nova AI

An AI agent workstation built into the dashboard (**Nova AI** in the sidebar), running on your own hardware with [Ollama](https://ollama.com).

1. **Nova AI → Models → Install AI engine** (or `sudo nova ai-install`). Installs Ollama natively as a systemd service, listening only on `127.0.0.1`, plus git, Python and build tools for the agent. If the external drive is set up, models are stored on it.
2. Download a coding model. The list marks which ones fit in this machine's RAM next to the Bitcoin node; on an 8 GB machine, `qwen2.5-coder:3b` is the sweet spot.
3. Chat in **Agent** mode: Nova lists, reads, searches, writes and edits files in its workspace, runs commands (installs, builds, tests) and fixes its own errors. **Chat** mode is plain conversation.

**Safety.** Every command waits for your approval unless you turn that off. Commands run as the unprivileged `nova-agent` user in a locked-down systemd unit: they can only write to `/var/lib/nova-agent`, can't read NovaEtherOS's data or the Bitcoin data, and can't connect to anything on this machine (dashboard, RPC, pool). They do have internet access.

**Bigger models.** A MacBook Air can only run small models. To use large ones (e.g. `qwen3-coder:30b`), install Ollama on a PC with a graphics card, start it with `OLLAMA_HOST=0.0.0.0`, and enter its address under **Models → Use a more powerful computer**. The agent's tools still run on NovaEtherOS.

### Text API

**Nova AI → API** turns the local models into an API for your own scripts, bots and apps. Create an API key, then:

- **Text endpoints**: one URL per text job. Quick-add Summarize, Translate, Rewrite, Sentiment or Extract keywords, or make your own: give it instructions and a template; anything in `{{double braces}}` comes from the request. Turn on JSON for answers your code can read field by field.

  ```bash
  curl -X POST http://<machine-ip>/api/v1/text/summarize \
    -H "Authorization: Bearer nova_..." -H "Content-Type: application/json" \
    -d '{"text": "Long text here"}'
  # -> {"output": "...", "model": "...", "tokens": 120, "seconds": 4.2}
  ```

  `GET /api/v1/text` lists your endpoints and the fields each one needs.
- **OpenAI-compatible**: `http://<machine-ip>/v1` (`/v1/chat/completions`, `/v1/models`, `/v1/embeddings`), so OpenAI SDKs and tools work with `base_url` pointed at NovaEtherOS and your Nova key.

Keys are stored only as hashes, and each one can be revoked on its own. The API is reachable from your home network; don't port-forward it to the internet.

## Ports

| Port | Use |
|---|---|
| 80 | Dashboard |
| 2018 | Solo mining pool (stratum) |
| 8332 | RPC (LAN and Tailscale only) |
| 8333 | P2P (forward on your router for incoming peers; optional) |
| 28332–28336 | ZMQ (rawblock, rawtx, hashblock, sequence, hashtx) |
| 11434 | Ollama AI engine (this machine only) |

### External drive

To keep the blockchain on an external SSD (a 1 TB drive fits a full node):

```bash
nova drives                          # find the SSD, e.g. /dev/sdb
sudo nova setup-drive /dev/sdb       # ERASES it, mounts it at boot, moves the node onto it
```

`setup-drive` refuses to touch the system disk and asks you to type `ERASE` first. The drive is mounted by UUID at `/mnt/nova-bitcoin` with `nofail`, so the machine still boots without it; while it's unplugged the node waits instead of filling the internal disk. To use a drive you've already formatted and mounted yourself: `sudo nova move-bitcoin /path/on/drive/bitcoin`.

Updating NovaEtherOS does not restart Bitcoin Core. Custom `bitcoin.conf` options go in `/var/lib/novaetheros/bitcoin/nova-custom.conf`.

## Development

```bash
npm install
npm run dev
```

- Dashboard: http://localhost:5173 (proxies `/api` to the server)
- API: http://localhost:3000

App installs need Docker available on the dev machine.

## Project layout

```
apps/
  server/     Express + TypeScript API (system stats, app management via docker compose)
    src/bitcoin/  built-in node: Smart Storage planner, bitcoind supervisor, RPC client, block explorer
    src/pool/     built-in solo mining pool: stratum server, job/coinbase builder, address decoding
  web/        React + Vite dashboard
app-store/    One folder per app: app.json (metadata) + docker-compose.yml
scripts/      Debian installer and systemd unit
data/         Runtime state and app volumes (git-ignored)
```

## Adding an app

Create `app-store/<id>/app.json`:

```json
{ "name": "My App", "tagline": "What it does", "category": "Tools", "port": 8123, "icon": "🧩" }
```

and `app-store/<id>/docker-compose.yml`, using `${APP_DATA_DIR}` for any persistent volumes.

## Roadmap

- [ ] User login / auth (needed before exposing the dashboard beyond your home network)
- [ ] Mining wallet (payout address, maturing balance, watch-only cold wallet)
- [ ] App logs & restart controls
- [ ] Custom wallpapers and widgets
- [ ] Community app store repos
- [ ] Backups
