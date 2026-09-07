#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  private/scripts/upload-test-env-secrets.sh [--env test] [--repo sgrastar/authrim] [--dry-run]
    [--refresh-control-tokens]
    [--d1-token-file PATH --workers-token-file PATH]

Uploads generated Authrim environment files to GitHub Actions secrets.

Default input paths for --env test:
  .authrim/test/config.json
  .authrim/test/lock.json
  .authrim-keys/test/

Default secrets for --env test:
  AUTHRIM_TEST_CONFIG
  AUTHRIM_TEST_LOCK_GZIP_B64
  AUTHRIM_TEST_KEYS_TAR_B64
  AUTHRIM_TEST_CLOUDFLARE_D1_API_TOKEN
  AUTHRIM_TEST_CLOUDFLARE_WORKERS_API_TOKEN
  AUTHRIM_TEST_CONTROL_TOKEN_PAIR_READY

The two Control Worker tokens are kept as separate GitHub Actions secrets. Existing
values are preserved by default. If either secret is missing, both values are read
from the supplied files or requested using masked terminal prompts. Use
--refresh-control-tokens to rotate both values together.
USAGE
}

ENV_NAME="test"
REPO="sgrastar/authrim"
DRY_RUN=false
REFRESH_CONTROL_TOKENS=false
D1_TOKEN_FILE=""
WORKERS_TOKEN_FILE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env)
      ENV_NAME="${2:-}"
      shift 2
      ;;
    --repo)
      REPO="${2:-}"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --refresh-control-tokens)
      REFRESH_CONTROL_TOKENS=true
      shift
      ;;
    --d1-token-file)
      D1_TOKEN_FILE="${2:-}"
      shift 2
      ;;
    --workers-token-file)
      WORKERS_TOKEN_FILE="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ ! "$ENV_NAME" =~ ^[a-z][a-z0-9-]*$ ]]; then
  echo "--env must start with a lowercase letter and contain only lowercase letters, numbers, and hyphens" >&2
  exit 1
fi

if [[ ! "$REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
  echo "--repo must use the owner/repository format" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

CONFIG_FILE="$REPO_ROOT/.authrim/$ENV_NAME/config.json"
LOCK_FILE="$REPO_ROOT/.authrim/$ENV_NAME/lock.json"
KEYS_DIR="$REPO_ROOT/.authrim-keys/$ENV_NAME"

SECRET_ENV="$(printf '%s' "$ENV_NAME" | tr '[:lower:]-' '[:upper:]_')"
CONFIG_SECRET="AUTHRIM_${SECRET_ENV}_CONFIG"
LOCK_SECRET="AUTHRIM_${SECRET_ENV}_LOCK_GZIP_B64"
KEYS_SECRET="AUTHRIM_${SECRET_ENV}_KEYS_TAR_B64"
D1_TOKEN_SECRET="AUTHRIM_${SECRET_ENV}_CLOUDFLARE_D1_API_TOKEN"
WORKERS_TOKEN_SECRET="AUTHRIM_${SECRET_ENV}_CLOUDFLARE_WORKERS_API_TOKEN"
CONTROL_TOKEN_PAIR_READY_SECRET="AUTHRIM_${SECRET_ENV}_CONTROL_TOKEN_PAIR_READY"

if [[ -n "$D1_TOKEN_FILE" || -n "$WORKERS_TOKEN_FILE" ]]; then
  if [[ -z "$D1_TOKEN_FILE" || -z "$WORKERS_TOKEN_FILE" ]]; then
    echo "--d1-token-file and --workers-token-file must be supplied together" >&2
    exit 1
  fi
  REFRESH_CONTROL_TOKENS=true
fi

REQUIRED_COMMANDS=(tar gzip base64 wc find grep node mktemp pnpm rm tr)
if [[ "$DRY_RUN" == false ]]; then
  REQUIRED_COMMANDS+=(gh)
fi
for required in "${REQUIRED_COMMANDS[@]}"; do
  if ! command -v "$required" >/dev/null 2>&1; then
    echo "Required command not found: $required" >&2
    exit 1
  fi
done

if [[ ! -f "$CONFIG_FILE" ]]; then
  echo "Missing config file: $CONFIG_FILE" >&2
  exit 1
fi

if [[ ! -f "$LOCK_FILE" ]]; then
  echo "Missing lock file: $LOCK_FILE" >&2
  exit 1
fi

if [[ ! -d "$KEYS_DIR" ]]; then
  echo "Missing keys directory: $KEYS_DIR" >&2
  exit 1
fi

if [[ -L "$CONFIG_FILE" || -L "$LOCK_FILE" || -L "$KEYS_DIR" ]]; then
  echo "Config, lock, and keys directory must not be symbolic links" >&2
  exit 1
fi

node -e '
  const fs = require("node:fs");
  const [configPath, lockPath, expectedEnv] = process.argv.slice(1);
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  if (config?.environment?.prefix !== expectedEnv) throw new Error("config environment mismatch");
  if (lock?.env !== expectedEnv) throw new Error("lock environment mismatch");
' "$CONFIG_FILE" "$LOCK_FILE" "$ENV_NAME"

TMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

KEYS_TAR="$TMP_DIR/authrim-${ENV_NAME}-keys.tar.gz"
KEYS_B64="$TMP_DIR/authrim-${ENV_NAME}-keys.tar.gz.b64"
LOCK_GZIP="$TMP_DIR/authrim-${ENV_NAME}-lock.json.gz"
LOCK_B64="$TMP_DIR/authrim-${ENV_NAME}-lock.json.gz.b64"
GITHUB_SECRET_VALUE_LIMIT_BYTES=49152

config_bytes="$(wc -c < "$CONFIG_FILE" | tr -d '[:space:]')"
if (( config_bytes > GITHUB_SECRET_VALUE_LIMIT_BYTES )); then
  echo "Input exceeds the GitHub Actions secret limit: ${CONFIG_FILE#$REPO_ROOT/} (${config_bytes} bytes)" >&2
  exit 1
fi

echo "Compressing lock file"
gzip -c "$LOCK_FILE" > "$LOCK_GZIP"
base64 < "$LOCK_GZIP" | tr -d '\n' > "$LOCK_B64"

LOCK_B64_BYTES="$(wc -c < "$LOCK_B64" | tr -d '[:space:]')"
if (( LOCK_B64_BYTES > GITHUB_SECRET_VALUE_LIMIT_BYTES )); then
  echo "Encoded lock archive is too large for a GitHub Actions secret: ${LOCK_B64_BYTES} bytes" >&2
  echo "Limit: ${GITHUB_SECRET_VALUE_LIMIT_BYTES} bytes" >&2
  exit 1
fi

echo "Uploading Authrim environment secrets"
echo "  Repository: $REPO"
echo "  Environment: $ENV_NAME"
echo "  Config secret: $CONFIG_SECRET"
echo "  Lock secret: $LOCK_SECRET"
echo "  Keys secret: $KEYS_SECRET"
echo "  Control D1 token secret: $D1_TOKEN_SECRET"
echo "  Control Workers token secret: $WORKERS_TOKEN_SECRET"
echo "  Control token pair marker: $CONTROL_TOKEN_PAIR_READY_SECRET"
echo "  Dry run: $DRY_RUN"
echo "  Encoded lock archive size: ${LOCK_B64_BYTES} bytes"
echo

UNSAFE_KEYS_ENTRY="$(find "$KEYS_DIR" ! -type f ! -type d -print -quit)"
if [[ -n "$UNSAFE_KEYS_ENTRY" ]]; then
  echo "Refusing unsupported keys entry: ${UNSAFE_KEYS_ENTRY#$REPO_ROOT/}" >&2
  exit 1
fi

# Use setup's canonical key repair path so this uploader cannot drift from the
# keys required by current Worker bindings. Existing values are preserved.
echo "Validating and completing supplemental key files"
AUTHRIM_UPLOAD_KEYS_DIR="$KEYS_DIR" pnpm --dir "$REPO_ROOT" exec tsx -e '
  import { ensureSupplementalKeyFiles } from "./packages/setup/src/core/keys.ts";

  const keysDir = process.env.AUTHRIM_UPLOAD_KEYS_DIR;
  if (!keysDir) throw new Error("AUTHRIM_UPLOAD_KEYS_DIR is required");

  ensureSupplementalKeyFiles(keysDir)
    .then(({ createdFiles }) => {
      process.stdout.write(`Supplemental key validation complete (${createdFiles.length} created).\n`);
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
'

echo "Packing keys from $KEYS_DIR"
tar -C "$KEYS_DIR" \
  --exclude './logs' \
  --exclude './logs/*' \
  -czf "$KEYS_TAR" .

echo "Encoding key archive"
base64 < "$KEYS_TAR" | tr -d '\n' > "$KEYS_B64"

KEYS_B64_BYTES="$(wc -c < "$KEYS_B64" | tr -d '[:space:]')"
if (( KEYS_B64_BYTES > GITHUB_SECRET_VALUE_LIMIT_BYTES )); then
  echo "Encoded key archive is too large for a GitHub Actions secret: ${KEYS_B64_BYTES} bytes" >&2
  echo "Limit: ${GITHUB_SECRET_VALUE_LIMIT_BYTES} bytes" >&2
  echo "The archive excludes logs automatically. Check for large non-key files in: $KEYS_DIR" >&2
  exit 1
fi

echo "Encoded key archive size: ${KEYS_B64_BYTES} bytes"

if [[ "$DRY_RUN" == true ]]; then
  if [[ "$REFRESH_CONTROL_TOKENS" == true ]]; then
    echo "Dry run does not read or upload Control Worker token values."
  fi
  echo "Dry run complete; no GitHub secrets were changed."
  exit 0
fi

gh auth status --hostname github.com >/dev/null

existing_secret_names="$(gh secret list --repo "$REPO" --json name --jq '.[].name')"
has_d1_token=false
has_workers_token=false
has_control_token_pair_marker=false
if printf '%s\n' "$existing_secret_names" | grep -Fxq "$D1_TOKEN_SECRET"; then
  has_d1_token=true
fi
if printf '%s\n' "$existing_secret_names" | grep -Fxq "$WORKERS_TOKEN_SECRET"; then
  has_workers_token=true
fi
if printf '%s\n' "$existing_secret_names" | grep -Fxq "$CONTROL_TOKEN_PAIR_READY_SECRET"; then
  has_control_token_pair_marker=true
fi

if [[ "$has_d1_token" != "$has_workers_token" || "$has_control_token_pair_marker" == false ]]; then
  echo "The complete Control Worker token pair is not checkpointed; rotating both values."
  REFRESH_CONTROL_TOKENS=true
fi

if [[ "$has_d1_token" == false ]]; then
  REFRESH_CONTROL_TOKENS=true
fi

read_token_file() {
  local token_file="$1"
  local label="$2"
  if [[ ! -f "$token_file" || -L "$token_file" ]]; then
    echo "$label token file must be a regular non-symbolic-link file: $token_file" >&2
    exit 1
  fi
  local value
  value="$(tr -d '\r\n' < "$token_file")"
  if [[ -z "$value" || "$value" =~ [[:space:]] ]]; then
    echo "$label token file must contain one non-empty token without whitespace" >&2
    exit 1
  fi
  printf '%s' "$value"
}

if [[ "$REFRESH_CONTROL_TOKENS" == true ]]; then
  if [[ -n "$D1_TOKEN_FILE" ]]; then
    d1_token="$(read_token_file "$D1_TOKEN_FILE" "D1")"
    workers_token="$(read_token_file "$WORKERS_TOKEN_FILE" "Workers")"
  else
    if [[ ! -t 0 || ! -t 1 ]]; then
      echo "Control Worker token secrets are missing or rotation was requested." >&2
      echo "Use --d1-token-file and --workers-token-file for non-interactive execution." >&2
      exit 1
    fi
    read -r -s -p "Cloudflare D1 Edit token for the Control Worker: " d1_token
    echo
    read -r -s -p "Cloudflare Workers Scripts Edit token for the Control Worker: " workers_token
    echo
  fi

  if [[ -z "$d1_token" || -z "$workers_token" ]]; then
    echo "Both Control Worker token values are required" >&2
    exit 1
  fi
  if [[ "$d1_token" =~ [[:space:]] || "$workers_token" =~ [[:space:]] ]]; then
    echo "Control Worker token values must not contain whitespace" >&2
    exit 1
  fi
  if [[ "$d1_token" == "$workers_token" ]]; then
    echo "Use distinct D1 and Workers tokens to preserve least-privilege separation" >&2
    exit 1
  fi

  D1_TOKEN_TMP="$TMP_DIR/control-d1-token"
  WORKERS_TOKEN_TMP="$TMP_DIR/control-workers-token"
  umask 077
  printf '%s' "$d1_token" > "$D1_TOKEN_TMP"
  printf '%s' "$workers_token" > "$WORKERS_TOKEN_TMP"
  unset d1_token workers_token

  # Remove the completion marker first. If either write fails, the next run must
  # request and upload the complete pair again instead of trusting mixed values.
  if [[ "$has_control_token_pair_marker" == true ]]; then
    gh secret delete "$CONTROL_TOKEN_PAIR_READY_SECRET" --repo "$REPO"
  fi
  echo "Setting $D1_TOKEN_SECRET"
  gh secret set "$D1_TOKEN_SECRET" --repo "$REPO" < "$D1_TOKEN_TMP"
  echo "Setting $WORKERS_TOKEN_SECRET"
  gh secret set "$WORKERS_TOKEN_SECRET" --repo "$REPO" < "$WORKERS_TOKEN_TMP"
  CONTROL_TOKEN_PAIR_READY_TMP="$TMP_DIR/control-token-pair-ready"
  printf '%s' 'ready-v1' > "$CONTROL_TOKEN_PAIR_READY_TMP"
  gh secret set "$CONTROL_TOKEN_PAIR_READY_SECRET" --repo "$REPO" \
    < "$CONTROL_TOKEN_PAIR_READY_TMP"
else
  echo "Preserving existing Control Worker token secrets"
fi

echo "Setting $KEYS_SECRET from encoded archive"
gh secret set "$KEYS_SECRET" --repo "$REPO" < "$KEYS_B64"

echo "Setting $LOCK_SECRET from compressed lock archive"
gh secret set "$LOCK_SECRET" --repo "$REPO" < "$LOCK_B64"

echo "Setting $CONFIG_SECRET from $CONFIG_FILE"
gh secret set "$CONFIG_SECRET" --repo "$REPO" < "$CONFIG_FILE"

echo
echo "Done."
