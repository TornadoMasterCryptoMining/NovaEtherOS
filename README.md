# NovaEtherOS

A self-hosted home cloud dashboard, inspired by UmbrelOS. Runs on a regular Debian install — no image flashing — and turns the machine (e.g. an old MacBook Air) into a personal server with a web dashboard and a one-click app store.

## Features

- **Dashboard** — live CPU, memory, storage and battery widgets
- **App Store** — install/uninstall self-hosted apps (Nextcloud, Jellyfin, Pi-hole, Uptime Kuma) as Docker containers
- **Runs as a systemd service** — starts on boot, reachable from any device on your network

## Install on Debian

1. Install Debian 12+ on the machine (for a MacBook Air, the standard Debian installer works; you may need the `firmware-b43-installer` or `broadcom-sta-dkms` package for Wi-Fi, or use Ethernet during setup).
2. Run:

   ```bash
   curl -fsSL https://raw.githubusercontent.com/OWNER/NovaEtherOS/main/scripts/install.sh | sudo bash
   ```

3. Open `http://<machine-ip>` from any device on your network.

The installer sets up Docker Engine, Node.js 22, clones this repo to `/opt/novaetheros`, builds it and registers the `novaetheros` systemd service. Re-running it updates to the latest version.

Useful commands:

```bash
sudo systemctl status novaetheros
sudo journalctl -u novaetheros -f
```

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

- [ ] User login / auth
- [ ] App logs & restart controls
- [ ] Custom wallpapers and widgets
- [ ] Community app store repos
- [ ] Backups
