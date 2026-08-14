#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  scripts/upload-test-env-secrets.sh [--env test] [--repo sgrastar/authrim] [--dry-run]

Uploads generated Authrim environment files to GitHub Actions secrets.

Default input paths for --env test:
  .authrim/test/config.json
  .authrim/test/lock.json
  .authrim-keys/test/

Default secrets for --env test:
  AUTHRIM_TEST_CONFIG
  AUTHRIM_TEST_LOCK_GZIP_B64
  AUTHRIM_TEST_KEYS_TAR_B64
USAGE
}

ENV_NAME="test"
REPO="sgrastar/authrim"
DRY_RUN=false

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
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

CONFIG_FILE="$REPO_ROOT/.authrim/$ENV_NAME/config.json"
LOCK_FILE="$REPO_ROOT/.authrim/$ENV_NAME/lock.json"
KEYS_DIR="$REPO_ROOT/.authrim-keys/$ENV_NAME"

SECRET_ENV="$(printf '%s' "$ENV_NAME" | tr '[:lower:]-' '[:upper:]_')"
CONFIG_SECRET="AUTHRIM_${SECRET_ENV}_CONFIG"
LOCK_SECRET="AUTHRIM_${SECRET_ENV}_LOCK_GZIP_B64"
KEYS_SECRET="AUTHRIM_${SECRET_ENV}_KEYS_TAR_B64"

REQUIRED_COMMANDS=(tar gzip base64 wc find node mktemp pnpm rm tr)
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
  echo "Dry run complete; no GitHub secrets were changed."
  exit 0
fi

gh auth status --hostname github.com >/dev/null

echo "Setting $KEYS_SECRET from encoded archive"
gh secret set "$KEYS_SECRET" --repo "$REPO" < "$KEYS_B64"

echo "Setting $LOCK_SECRET from compressed lock archive"
gh secret set "$LOCK_SECRET" --repo "$REPO" < "$LOCK_B64"

echo "Setting $CONFIG_SECRET from $CONFIG_FILE"
gh secret set "$CONFIG_SECRET" --repo "$REPO" < "$CONFIG_FILE"

echo
echo "Done."
