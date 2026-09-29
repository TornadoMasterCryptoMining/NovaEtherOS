# NovaEtherOS

A self-hosted home cloud dashboard, inspired by UmbrelOS. Runs on a regular Debian install — no image flashing — and turns the machine (e.g. an old MacBook Air) into a personal server with a web dashboard and a one-click app store.

## Features

- **Built-in Bitcoin node** — Bitcoin Core runs natively (no Docker) with Smart Storage auto-pruning, hardware auto-tuning and a mining check
- **Dashboard** — live CPU, memory, storage and battery widgets
- **App Store** — install/uninstall self-hosted apps (Nextcloud, Jellyfin, Pi-hole, Uptime Kuma) as Docker containers
- **Runs as a systemd service** — starts on boot, reachable from any device on your network

## Install on Debian

1. Install Debian 12+ on the machine (for a MacBook Air, the standard Debian installer works; you may need the `firmware-b43-installer` or `broadcom-sta-dkms` package for Wi-Fi, or use Ethernet during setup).
2. Run:

   ```bash
   curl -fsSL https://raw.githubusercontent.com/TornadoMasterCryptoMining/NovaEtherOS/main/scripts/install.sh | sudo bash
   ```

3. Open `http://<machine-ip>` from any device on your network.

The installer sets up Docker Engine, Node.js 22, clones this repo to `/opt/novaetheros`, builds it and registers the `novaetheros` systemd service. Re-running it updates to the latest version.

Useful commands:

```bash
sudo systemctl status novaetheros
sudo journalctl -u novaetheros -f
sudo journalctl -u nova-bitcoind -f
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

The **Bitcoin** page in the dock shows sync progress, storage plan, settings (Automatic / Full node / Prune to N GB), RPC connection details and a one-click mining check.

| Port | Use |
|---|---|
| 8332 | RPC (LAN and Tailscale only) |
| 8333 | P2P (forward on your router for incoming peers; optional) |
| 28332–28336 | ZMQ (rawblock, rawtx, hashblock, sequence, hashtx) |

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
    src/bitcoin/  built-in node: Smart Storage planner, bitcoind supervisor, RPC client
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
- [ ] Built-in solo mining pool (stratum) for Bitaxe / NerdMiner / Antminer
- [ ] Mining wallet (payout address, maturing balance, watch-only cold wallet)
- [ ] App logs & restart controls
- [ ] Custom wallpapers and widgets
- [ ] Community app store repos
- [ ] Backups
