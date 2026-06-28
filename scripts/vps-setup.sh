#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${APP_DIR:-$HOME/fireboy-watergirl-the-forest-temple_202401}"
BRANCH="${BRANCH:-}"
REPO_URL="${REPO_URL:-${2:-}}"
SITE_ADDRESS="${SITE_ADDRESS:-${1:-}}"

log() {
  printf '\n==> %s\n' "$*"
}

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'USAGE'
Provision or update the Fireboy & Watergirl game host on an Ubuntu VPS.

Usage:
  SITE_ADDRESS=your-name.duckdns.org REPO_URL=https://github.com/you/repo.git bash scripts/vps-setup.sh

Or, when running from inside an already-cloned repo:
  SITE_ADDRESS=your-name.duckdns.org bash scripts/vps-setup.sh

Optional env vars:
  APP_DIR=/path/to/app       Clone/update location. Default: ~/fireboy-watergirl-the-forest-temple_202401
  BRANCH=main                Branch to clone or check out.
USAGE
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

[[ "$(uname -s)" == "Linux" ]] || die "This script is intended for the Ubuntu VPS, not Windows/macOS."
[[ -n "$SITE_ADDRESS" ]] || die "Set SITE_ADDRESS, e.g. SITE_ADDRESS=your-name.duckdns.org"
[[ "$SITE_ADDRESS" != http://* && "$SITE_ADDRESS" != https://* && "$SITE_ADDRESS" != */* ]] \
  || die "SITE_ADDRESS should be only the hostname, e.g. your-name.duckdns.org"
[[ "$SITE_ADDRESS" =~ ^[A-Za-z0-9.-]+$ ]] || die "SITE_ADDRESS contains invalid hostname characters."

SUDO=()
if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  command -v sudo >/dev/null 2>&1 || die "sudo is required when not running as root."
  SUDO=(sudo)
fi

install_base_packages() {
  local missing=()
  command -v curl >/dev/null 2>&1 || missing+=(curl)
  command -v git >/dev/null 2>&1 || missing+=(git)
  [[ -f /etc/ssl/certs/ca-certificates.crt ]] || missing+=(ca-certificates)

  if [[ "${#missing[@]}" -eq 0 ]]; then
    return
  fi

  command -v apt-get >/dev/null 2>&1 || die "Install ${missing[*]} manually, then rerun this script."
  log "Installing base packages: ${missing[*]}"
  "${SUDO[@]}" apt-get update
  "${SUDO[@]}" env DEBIAN_FRONTEND=noninteractive apt-get install -y "${missing[@]}"
}

install_docker() {
  if command -v docker >/dev/null 2>&1; then
    return
  fi

  log "Installing Docker"
  local installer
  installer="$(mktemp)"
  curl -fsSL https://get.docker.com -o "$installer"
  "${SUDO[@]}" sh "$installer"
  rm -f "$installer"
}

start_docker() {
  if command -v systemctl >/dev/null 2>&1; then
    "${SUDO[@]}" systemctl enable --now docker >/dev/null 2>&1 || true
  fi

  if docker info >/dev/null 2>&1; then
    DOCKER=(docker)
  elif [[ "${#SUDO[@]}" -gt 0 ]] && "${SUDO[@]}" docker info >/dev/null 2>&1; then
    DOCKER=("${SUDO[@]}" docker)
  else
    die "Docker is installed but the daemon is not reachable."
  fi

  "${DOCKER[@]}" compose version >/dev/null 2>&1 || die "Docker Compose v2 is required but was not found."
}

sync_repo() {
  local in_repo="false"
  if [[ -f docker-compose.yml && -f Caddyfile && -f server/Dockerfile ]]; then
    in_repo="true"
  fi

  if [[ "$in_repo" == "true" && -z "${REPO_URL}" ]]; then
    APP_DIR="$(pwd)"
    log "Using current repo: $APP_DIR"
    return
  fi

  [[ -n "$REPO_URL" ]] || die "Set REPO_URL when running outside an existing clone."

  if [[ -d "$APP_DIR/.git" ]]; then
    log "Updating repo in $APP_DIR"
    git -C "$APP_DIR" fetch --prune
    if [[ -n "$BRANCH" ]]; then
      git -C "$APP_DIR" checkout "$BRANCH"
    fi
    git -C "$APP_DIR" pull --ff-only
  elif [[ -e "$APP_DIR" ]]; then
    die "$APP_DIR already exists but is not a git repo. Set APP_DIR to an empty path."
  else
    log "Cloning repo into $APP_DIR"
    if [[ -n "$BRANCH" ]]; then
      git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
    else
      git clone "$REPO_URL" "$APP_DIR"
    fi
  fi
}

write_env() {
  log "Writing SITE_ADDRESS to $APP_DIR/.env"
  cd "$APP_DIR"

  if [[ -f .env && -n "$(grep -E '^SITE_ADDRESS=' .env || true)" ]]; then
    sed -i.bak -E "s|^SITE_ADDRESS=.*|SITE_ADDRESS=$SITE_ADDRESS|" .env
  else
    if [[ -s .env && "$(tail -c 1 .env)" != "" ]]; then
      printf '\n' >> .env
    fi
    printf 'SITE_ADDRESS=%s\n' "$SITE_ADDRESS" >> .env
  fi
}

launch_stack() {
  log "Validating Docker Compose config"
  "${DOCKER[@]}" compose config >/dev/null

  log "Building and starting the game host"
  "${DOCKER[@]}" compose up -d --build
}

check_health() {
  log "Checking https://$SITE_ADDRESS/health"
  for _ in {1..20}; do
    if curl -fsS "https://$SITE_ADDRESS/health" >/dev/null 2>&1; then
      printf '\nDone. Health check passed: https://%s/health\n' "$SITE_ADDRESS"
      return
    fi
    sleep 3
  done

  printf '\nStarted, but the HTTPS health check did not pass yet.\n'
  printf 'Check DNS propagation and Caddy logs with:\n'
  printf '  %s compose logs --tail=100 caddy\n' "${DOCKER[*]}"
}

install_base_packages
install_docker
start_docker
sync_repo
write_env
launch_stack
check_health
