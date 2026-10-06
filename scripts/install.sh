#!/usr/bin/env bash
# NovaEtherOS installer for Debian 12+ (tested target: MacBook Air running Debian).
# Usage:  curl -fsSL https://raw.githubusercontent.com/TornadoMasterCryptoMining/NovaEtherOS/main/scripts/install.sh | sudo bash
set -euo pipefail

# Settings from a previous install (written at the end of this script), so
# updates keep a custom port or directory. Values given on the command line
# (e.g. sudo NOVA_PORT=8080 bash install.sh) take precedence.
if [[ -f /etc/novaetheros.conf ]]; then
  while IFS='=' read -r key value; do
    [[ $key =~ ^[A-Z_]+$ ]] || continue
    value=${value#\"}
    value=${value%\"}
    [[ -z ${!key:-} ]] && printf -v "$key" '%s' "$value"
  done < /etc/novaetheros.conf
fi

NOVA_REPO="${NOVA_REPO:-https://github.com/TornadoMasterCryptoMining/NovaEtherOS.git}"
NOVA_BRANCH="${NOVA_BRANCH:-main}"
NOVA_DIR="${NOVA_DIR:-/opt/novaetheros}"
NOVA_PORT="${NOVA_PORT:-80}"
BITCOIN_DATA_DIR="${BITCOIN_DATA_DIR:-/var/lib/novaetheros/bitcoin}"

# Bitcoin Core release built into NovaEtherOS.
# Checksums from https://bitcoincore.org/bin/bitcoin-core-31.1/SHA256SUMS
BITCOIN_VERSION="31.1"
BITCOIN_SHA256_AMD64="b80d9c3e04da78fb6f0569685673418cf686fadba9042d926d13fb87ff503f9e"
BITCOIN_SHA256_ARM64="dcf1873f2208ba4f962f3398d47e154c39c0084be8f4553e05c940d0ace3d004"

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

if [[ "$(/usr/local/bin/bitcoind -version 2>/dev/null | head -1)" != *"v${BITCOIN_VERSION}"* ]]; then
  log "Installing Bitcoin Core ${BITCOIN_VERSION}..."
  case "$(dpkg --print-architecture)" in
    amd64) triple=x86_64-linux-gnu; sum="$BITCOIN_SHA256_AMD64" ;;
    arm64) triple=aarch64-linux-gnu; sum="$BITCOIN_SHA256_ARM64" ;;
    *) echo "Unsupported architecture for Bitcoin Core: $(dpkg --print-architecture)" >&2; exit 1 ;;
  esac
  tmp="$(mktemp -d)"
  curl -fsSL -o "$tmp/bitcoin.tar.gz" \
    "https://bitcoincore.org/bin/bitcoin-core-${BITCOIN_VERSION}/bitcoin-${BITCOIN_VERSION}-${triple}.tar.gz"
  echo "${sum}  $tmp/bitcoin.tar.gz" | sha256sum -c -
  tar -xzf "$tmp/bitcoin.tar.gz" -C "$tmp" --strip-components=1
  # Stop a running node before swapping the binary (it flushes to disk first)
  systemctl stop nova-bitcoind 2>/dev/null || true
  install -m 0755 "$tmp/bin/bitcoind" "$tmp/bin/bitcoin-cli" /usr/local/bin/
  rm -rf "$tmp"
fi

if ! id bitcoin >/dev/null 2>&1; then
  useradd --system --home-dir "$BITCOIN_DATA_DIR" --shell /usr/sbin/nologin bitcoin
fi
# On an external drive, only create the folder if the drive is actually mounted,
# so a missing drive can't silently fill up the internal disk.
mount_of() {
  local p=$1
  while [[ ! -e $p ]]; do p=$(dirname "$p"); done
  findmnt -no TARGET -T "$p"
}
if [[ $BITCOIN_DATA_DIR == /mnt/* || $BITCOIN_DATA_DIR == /media/* ]] && [[ "$(mount_of "$BITCOIN_DATA_DIR")" == "/" ]]; then
  log "WARNING: the drive for $BITCOIN_DATA_DIR is not mounted; the Bitcoin node will wait for it."
else
  install -d -m 0750 -o bitcoin -g bitcoin "$BITCOIN_DATA_DIR"
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

cat > /etc/novaetheros.conf <<EOF
NOVA_REPO="$NOVA_REPO"
NOVA_BRANCH="$NOVA_BRANCH"
NOVA_DIR="$NOVA_DIR"
NOVA_PORT="$NOVA_PORT"
BITCOIN_DATA_DIR="$BITCOIN_DATA_DIR"
EOF
install -m 0755 "$NOVA_DIR/scripts/nova" /usr/local/bin/nova

log "Installing systemd services..."
/usr/local/bin/nova render-services
systemctl enable --now novaetheros
systemctl restart novaetheros

# The address of the interface that actually reaches the network (not
# Docker's internal bridge, which `hostname -I` may list first).
IP="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i < NF; i++) if ($i == "src") {print $(i + 1); exit}}')"
IP="${IP:-$(hostname -I | tr ' ' '\n' | grep -v '^172\.1[7-9]\.' | head -1)}"
log "Installed version: $(git -C "$NOVA_DIR" log -1 --format='%h %s')"
log "Update any time from the dashboard, or with: sudo nova update"
log "Done! Open http://${IP}$( [[ $NOVA_PORT == 80 ]] || echo ":$NOVA_PORT" ) from any device on your network."
