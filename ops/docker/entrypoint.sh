#!/bin/sh
# Gantry container entrypoint.
#
# 1. Run database migrations under a Postgres advisory lock (race-safe across a
#    rolling deploy), unless GANTRY_SKIP_MIGRATIONS=1.
# 2. exec the runtime as PID 1 so SIGTERM reaches it directly and graceful drain
#    (control server: SIGTERM -> /readyz 503 -> drain -> exit) works correctly.
#
# Fail fast: any unset var or failed command aborts before the runtime starts.
set -eu

log() {
  # ISO-8601 UTC, single line, to stderr (keeps stdout for the runtime).
  printf '%s [entrypoint] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" >&2
}

rand_base64_32() {
  node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64'))"
}

rand_hex_32() {
  node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))"
}

resolve_settings_schema() {
  node <<'NODE'
const explicit = process.env.GANTRY_SETTINGS_POSTGRES_SCHEMA?.trim();
if (explicit) {
  process.stdout.write(explicit);
  process.exit(0);
}
const url = process.env.GANTRY_DATABASE_URL?.trim() || process.env.MIGRATION_DATABASE_URL?.trim() || '';
if (url) {
  try {
    const schema = new URL(url).searchParams.get('schema')?.trim();
    if (schema) {
      process.stdout.write(schema);
      process.exit(0);
    }
  } catch {
    // Fall through to env/default; migrate.mjs will report malformed URLs.
  }
}
process.stdout.write(process.env.GANTRY_DB_SCHEMA?.trim() || 'gantry');
NODE
}

bootstrap_settings_if_missing() {
  BOOTSTRAPPED_SETTINGS_FILE=0
  BOOTSTRAPPED_SETTINGS_DEPLOYMENT_MODE=''
  if [ "${GANTRY_BOOTSTRAP_SETTINGS_IF_MISSING:-0}" != "1" ]; then
    return
  fi
  case "$*" in
    *dist/index.js*) ;;
    *) return ;;
  esac

  runtime_home="${GANTRY_HOME:-/var/lib/gantry}"
  settings_file="${runtime_home}/settings.yaml"
  if [ -f "$settings_file" ]; then
    return
  fi

  mkdir -p "$runtime_home"
  schema="$(resolve_settings_schema)"
  deployment_mode="${GANTRY_BOOTSTRAP_DEPLOYMENT_MODE:-${GANTRY_DEPLOYMENT_MODE:-fleet}}"
  sandbox_provider="${GANTRY_BOOTSTRAP_SANDBOX_PROVIDER:-sandbox_runtime}"
  tmp_file="${settings_file}.tmp.$$"
  umask 077
  {
    printf '%s\n' 'runtime:'
    printf '  deployment_mode: %s\n' "$deployment_mode"
    printf '%s\n' '  sandbox:'
    printf '    provider: %s\n' "$sandbox_provider"
    printf '%s\n' ''
    printf '%s\n' 'storage:'
    printf '%s\n' '  postgres:'
    printf '%s\n' '    url_env: GANTRY_DATABASE_URL'
    printf '    schema: %s\n' "$schema"
  } >"$tmp_file"
  mv "$tmp_file" "$settings_file"
  BOOTSTRAPPED_SETTINGS_FILE=1
  BOOTSTRAPPED_SETTINGS_DEPLOYMENT_MODE="$deployment_mode"
  log "created bootstrap settings.yaml at ${settings_file} (schema=${schema}, deployment_mode=${deployment_mode})"
}

load_or_create_rehearsal_secrets() {
  secret_file="${GANTRY_FLEET_REHEARSAL_SECRETS_FILE:-/var/lib/gantry/fleet-rehearsal-secrets.env}"
  lock_dir="${secret_file}.lock"
  mkdir -p "$(dirname "$secret_file")"

  while ! mkdir "$lock_dir" 2>/dev/null; do
    sleep 1
  done
  trap 'rmdir "$lock_dir" 2>/dev/null || true' EXIT INT TERM

  if [ -f "$secret_file" ]; then
    # shellcheck disable=SC1090
    . "$secret_file"
  else
    secret_encryption_key="${SECRET_ENCRYPTION_KEY:-$(rand_base64_32)}"
    ipc_auth_secret="${GANTRY_IPC_AUTH_SECRET:-$(rand_hex_32)}"
    control_api_keys_json="${GANTRY_CONTROL_API_KEYS_JSON:-}"
    if [ -z "$control_api_keys_json" ]; then
      token="$(rand_hex_32)"
      control_api_keys_json="[{\"kid\":\"fleet-rehearsal-admin\",\"token\":\"${token}\",\"appId\":\"default\",\"scopes\":[\"sessions:read\"]}]"
    fi
    umask 077
    {
      printf "SECRET_ENCRYPTION_KEY='%s'\n" "$secret_encryption_key"
      printf "GANTRY_IPC_AUTH_SECRET='%s'\n" "$ipc_auth_secret"
      printf "GANTRY_CONTROL_API_KEYS_JSON='%s'\n" "$control_api_keys_json"
    } >"$secret_file"
    # shellcheck disable=SC1090
    . "$secret_file"
  fi

  rmdir "$lock_dir"
  trap - EXIT INT TERM
}

if [ "${GANTRY_FLEET_REHEARSAL_AUTO_SECRETS:-0}" = "1" ]; then
  load_or_create_rehearsal_secrets
  export SECRET_ENCRYPTION_KEY GANTRY_IPC_AUTH_SECRET GANTRY_CONTROL_API_KEYS_JSON
  log "loaded shared rehearsal-only runtime secrets"
fi

BOOTSTRAPPED_SETTINGS_FILE=0
BOOTSTRAPPED_SETTINGS_DEPLOYMENT_MODE=''
bootstrap_settings_if_missing "$@"

# ---------------------------------------------------------------------------
# Migrations.
#
# Default: every instance runs migrations. The advisory lock inside migrate()
# itself (storage-service) serializes every migrator — explicit passes like
# this one and runtime boot-time migrations alike — and migrate() is
# idempotent (drizzle tracks applied migrations), so N workers booting at once
# is safe: the lock holder migrates, the rest block then find nothing pending.
#
# GANTRY_SKIP_MIGRATIONS=1: skip the explicit migrate step. Use this for an
# N-worker fleet where one dedicated migrator (or the first booting worker)
# already applied the schema. Still safe under concurrent boots: the runtime's
# boot-time migrate() takes the same advisory lock, so skipping here only
# avoids the redundant explicit pass.
# ---------------------------------------------------------------------------
if [ "${GANTRY_SKIP_MIGRATIONS:-0}" = "1" ]; then
  log "GANTRY_SKIP_MIGRATIONS=1 — skipping explicit migration step"
else
  # The migration role may differ from the runtime role: migrate.mjs prefers
  # MIGRATION_DATABASE_URL, falling back to GANTRY_DATABASE_URL.
  if [ -n "${MIGRATION_DATABASE_URL:-}" ]; then
    log "running migrations (MIGRATION_DATABASE_URL)"
  else
    log "running migrations (GANTRY_DATABASE_URL)"
  fi
  # Non-zero exit here aborts the container before the runtime starts.
  node /app/ops/docker/migrate.mjs
  log "migrations complete"
fi

if [ "$BOOTSTRAPPED_SETTINGS_FILE" = "1" ] && [ "$BOOTSTRAPPED_SETTINGS_DEPLOYMENT_MODE" = "fleet" ]; then
  log "seeding initial fleet settings revision from bootstrap settings.yaml"
  node /app/ops/docker/fleet-settings-seed.mjs "${GANTRY_HOME:-/var/lib/gantry}/settings.yaml"
  log "fleet settings seed complete"
fi

# ---------------------------------------------------------------------------
# Hand off to the runtime as PID 1. `exec` replaces this shell so the runtime
# receives SIGTERM directly (graceful drain), with no shell sitting between
# the orchestrator and the process.
# ---------------------------------------------------------------------------
log "starting runtime: $*"
exec "$@"
