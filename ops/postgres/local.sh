#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="${SCRIPT_DIR}/compose.yml"
PROJECT_NAME="${MYCLAW_POSTGRES_PROJECT:-myclaw-postgres}"

expand_home_path() {
  local value="$1"
  case "$value" in
    "~")
      printf '%s\n' "$HOME"
      ;;
    "~/"*)
      printf '%s/%s\n' "$HOME" "${value#~/}"
      ;;
    *)
      printf '%s\n' "$value"
      ;;
  esac
}

resolve_myclaw_home() {
  if [[ -n "${MYCLAW_HOME:-}" ]]; then
    expand_home_path "${MYCLAW_HOME}"
  else
    printf '%s\n' "${HOME}/myclaw"
  fi
}

require_compose() {
  if ! command -v docker >/dev/null 2>&1; then
    echo "docker is required." >&2
    exit 1
  fi
  if ! docker compose version >/dev/null 2>&1; then
    echo "docker compose v2 is required." >&2
    exit 1
  fi
}

MYCLAW_HOME_RESOLVED="$(resolve_myclaw_home)"
mkdir -p "${MYCLAW_HOME_RESOLVED}"
MYCLAW_HOME_RESOLVED="$(cd "${MYCLAW_HOME_RESOLVED}" && pwd)"
MYCLAW_POSTGRES_DATA_DIR="${MYCLAW_HOME_RESOLVED}/postgres"

export MYCLAW_POSTGRES_DATA_DIR
export MYCLAW_POSTGRES_PORT="${MYCLAW_POSTGRES_PORT:-5432}"
export MYCLAW_POSTGRES_DB="${MYCLAW_POSTGRES_DB:-myclaw}"
export MYCLAW_POSTGRES_USER="${MYCLAW_POSTGRES_USER:-postgres}"
export MYCLAW_POSTGRES_PASSWORD="${MYCLAW_POSTGRES_PASSWORD:-postgres}"

compose() {
  require_compose
  docker compose \
    -p "${PROJECT_NAME}" \
    -f "${COMPOSE_FILE}" \
    "$@"
}

print_url() {
  printf 'postgresql://%s:%s@localhost:%s/%s\n' \
    "${MYCLAW_POSTGRES_USER}" \
    "${MYCLAW_POSTGRES_PASSWORD}" \
    "${MYCLAW_POSTGRES_PORT}" \
    "${MYCLAW_POSTGRES_DB}"
}

usage() {
  cat <<'USAGE'
Usage: ops/postgres/local.sh <up|down|status|url|paths>

Commands:
  up      Start local Postgres and wait for readiness (personal-local convenience)
  down    Stop local Postgres
  status  Show compose service status
  url     Print MYCLAW_DATABASE_URL value for this local instance
  paths   Print resolved MYCLAW_HOME and postgres data directory
USAGE
}

COMMAND="${1:-}"
case "${COMMAND}" in
  up)
    mkdir -p "${MYCLAW_POSTGRES_DATA_DIR}"
    compose up -d --wait
    echo "Local Postgres is ready."
    echo "Data directory: ${MYCLAW_POSTGRES_DATA_DIR}"
    echo "MYCLAW_DATABASE_URL=$(print_url)"
    ;;
  down)
    compose down
    ;;
  status)
    compose ps
    echo "Data directory: ${MYCLAW_POSTGRES_DATA_DIR}"
    ;;
  url)
    print_url
    ;;
  paths)
    echo "MYCLAW_HOME_RESOLVED=${MYCLAW_HOME_RESOLVED}"
    echo "MYCLAW_POSTGRES_DATA_DIR=${MYCLAW_POSTGRES_DATA_DIR}"
    ;;
  *)
    usage >&2
    exit 1
    ;;
esac