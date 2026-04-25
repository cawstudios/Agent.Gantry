#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: gws_setup_check.sh [--write-env] [--verify] [--services <csv>] [--full]

Checks Google Workspace CLI setup for MyClaw agents.

Options:
  --write-env       Add GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND=file to ~/myclaw/.env and ~/.zshrc if missing.
  --verify          Run auth and lightweight service readiness checks.
  --services <csv>  Services to suggest for login. Default: gmail,drive,sheets,calendar,docs,slides,forms.
  --full            Suggest broad OAuth login with gws auth login --full.
  -h, --help        Show this help.
USAGE
}

write_env=false
verify=false
services="gmail,drive,sheets,calendar,docs,slides,forms"
use_full=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --write-env)
      write_env=true
      shift
      ;;
    --verify)
      verify=true
      shift
      ;;
    --services)
      services="${2:-}"
      if [[ -z "$services" ]]; then
        echo "error: --services requires a comma-separated value" >&2
        exit 64
      fi
      shift 2
      ;;
    --full)
      use_full=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "error: unknown option: $1" >&2
      usage >&2
      exit 64
      ;;
  esac
done

runtime_home="${AGENT_ROOT:-$HOME/myclaw}"
runtime_env="$runtime_home/.env"
shell_rc="$HOME/.zshrc"
backend="${GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND:-}"
ssl_cert_file="${SSL_CERT_FILE:-}"

section() {
  printf '\n== %s ==\n' "$1"
}

ensure_line() {
  local file="$1"
  local line="$2"
  local mkdir_parent="$3"
  if [[ "$mkdir_parent" == "yes" ]]; then
    mkdir -p "$(dirname "$file")"
  fi
  touch "$file"
  if ! grep -Fqx "$line" "$file"; then
    printf '\n%s\n' "$line" >> "$file"
    echo "added: $line -> $file"
  else
    echo "already present: $line -> $file"
  fi
}

section "gws binary"
if command -v gws >/dev/null 2>&1; then
  gws_path="$(command -v gws)"
  echo "found: $gws_path"
else
  echo "missing: gws is not in PATH"
  echo "install gws first, then rerun this helper"
  exit 2
fi

section "backend"
echo "current shell GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND=${backend:-<unset>}"
echo "required for MyClaw agents: file"

if [[ -z "$ssl_cert_file" ]]; then
  for candidate in /etc/ssl/cert.pem /opt/homebrew/etc/openssl@3/cert.pem /opt/homebrew/etc/ca-certificates/cert.pem; do
    if [[ -f "$candidate" ]]; then
      export SSL_CERT_FILE="$candidate"
      ssl_cert_file="$candidate"
      break
    fi
  done
fi

section "certificates"
echo "SSL_CERT_FILE=${ssl_cert_file:-<unset>}"
if [[ -z "$ssl_cert_file" ]]; then
  echo "warning: no CA bundle found; gws may fail with native root certificate errors"
fi

if [[ "$write_env" == true ]]; then
  section "writing env"
  ensure_line "$runtime_env" "GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND=file" yes
  ensure_line "$shell_rc" "export GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND=file" no
  if [[ -n "$ssl_cert_file" ]]; then
    ensure_line "$runtime_env" "SSL_CERT_FILE=$ssl_cert_file" yes
    ensure_line "$shell_rc" "export SSL_CERT_FILE=$ssl_cert_file" no
  fi
fi

section "auth status"
if GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND=file gws auth status; then
  true
else
  echo "auth status failed"
fi

section "recommended login"
if [[ "$use_full" == true ]]; then
  echo "GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND=file gws auth login --full"
else
  echo "GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND=file gws auth login --services $services"
fi

if [[ "$verify" == true ]]; then
  section "gmail readiness"
  GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND=file gws gmail users getProfile --params '{"userId":"me"}'

  section "drive readiness"
  GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND=file gws drive files list --params '{"pageSize":1}' >/dev/null
  echo "drive files list: ok"

  section "sheets schema readiness"
  GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND=file gws schema sheets.spreadsheets.get >/dev/null
  echo "sheets schema: ok"
fi

section "next step"
echo "After changing env or auth, restart MyClaw so agents inherit the setup."
