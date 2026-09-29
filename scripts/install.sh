#!/usr/bin/env bash
# NovaEtherOS installer for Debian 12+ (tested target: MacBook Air running Debian).
# Usage:  curl -fsSL https://raw.githubusercontent.com/TornadoMasterCryptoMining/NovaEtherOS/main/scripts/install.sh | sudo bash
set -euo pipefail

NOVA_REPO="${NOVA_REPO:-https://github.com/TornadoMasterCryptoMining/NovaEtherOS.git}"
NOVA_BRANCH="${NOVA_BRANCH:-main}"
NOVA_DIR="${NOVA_DIR:-/opt/novaetheros}"
NOVA_PORT="${NOVA_PORT:-80}"

# Keep apt fully unattended (no needrestart / debconf pop-ups mid-install)
export DEBIAN_FRONTEND=noninteractive
export NEEDRESTART_MODE=a
export NEEDRESTART_SUSPEND=1

log() { printf '\033[1;35m[NovaEtherOS]\033[0m %s\n' "$*"; }

if [[ $EUID -ne 0 ]]; then
  echo "Please run as root (use sudo)." >&2
  exit 1
fi

if ! grep -qi debian /etc/os-release; then
  echo "This installer supports Debian only." >&2
  exit 1
fi

log "Installing base packages..."
apt-get update -y
apt-get install -y ca-certificates curl git gnupg

if ! command -v docker >/dev/null; then
  log "Installing Docker Engine..."
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian ${VERSION_CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
  systemctl enable --now docker
fi

if ! command -v node >/dev/null || [[ "$(node -v | cut -d. -f1 | tr -d v)" -lt 22 ]]; then
  log "Installing Node.js 22..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

if [[ -d "$NOVA_DIR/.git" ]]; then
  log "Updating existing install in $NOVA_DIR..."
  git -C "$NOVA_DIR" fetch --depth 1 origin "$NOVA_BRANCH"
  git -C "$NOVA_DIR" reset --hard "origin/$NOVA_BRANCH"
else
  log "Cloning NovaEtherOS into $NOVA_DIR..."
  git clone --depth 1 --branch "$NOVA_BRANCH" "$NOVA_REPO" "$NOVA_DIR"
fi

log "Building..."
cd "$NOVA_DIR"
npm ci
npm run build

log "Installing systemd service..."
sed "s|__NOVA_DIR__|$NOVA_DIR|g; s|__NOVA_PORT__|$NOVA_PORT|g" \
  "$NOVA_DIR/scripts/novaetheros.service" > /etc/systemd/system/novaetheros.service
systemctl daemon-reload
systemctl enable --now novaetheros
systemctl restart novaetheros

IP="$(hostname -I | awk '{print $1}')"
log "Done! Open http://${IP}$( [[ $NOVA_PORT == 80 ]] || echo ":$NOVA_PORT" ) from any device on your network."
