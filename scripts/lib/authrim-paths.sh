#!/usr/bin/env bash
# =============================================================================
# Authrim Path Resolution Library
# =============================================================================
#
# Common path resolution and JSON read/write functions for bash scripts.
# Matches the TypeScript implementation in packages/setup/src/core/paths.ts.
#
# Usage:
#   source scripts/lib/authrim-paths.sh
#
# Functions:
#   Path Resolution:
#     get_env_dir(env)           - Get environment directory path
#     get_config_path(env)       - Get config.json path
#     get_lock_path(env)         - Get lock.json path
#     find_keys_dir(env)         - Find keys directory (3-tier fallback)
#
#   JSON Reading:
#     read_config(env, jq_query) - Read from config.json
#     read_lock(env, jq_query)   - Read from lock.json
#     get_issuer_url(env)        - Get ISSUER_URL with fallback
#     get_d1_id(env, binding)    - Get D1 database ID
#     get_kv_id(env, binding)    - Get KV namespace ID
#
#   JSON Writing:
#     add_d1_to_lock(env, binding, name, id)       - Add D1 to lock.json
#     add_kv_to_lock(env, binding, name, id, [preview_id]) - Add KV to lock.json
#
# =============================================================================

# Prevent multiple sourcing
if [ -n "$_AUTHRIM_PATHS_LOADED" ]; then
  return 0 2>/dev/null || exit 0
fi
_AUTHRIM_PATHS_LOADED=1

# =============================================================================
# Constants
# =============================================================================
AUTHRIM_DIR=".authrim"
AUTHRIM_KEYS_DIR=".authrim-keys"
LEGACY_KEYS_DIR=".keys"

# =============================================================================
# Utility Functions
# =============================================================================

# Validate environment name for security (prevent path traversal)
validate_env_name() {
  local env="$1"

  if [ -z "$env" ]; then
    echo "Error: Environment name is required" >&2
    return 1
  fi

  # Check for path traversal characters
  if [[ "$env" =~ \.\. ]] || [[ "$env" =~ / ]] || [[ "$env" =~ \\ ]]; then
    echo "Error: Invalid environment name '${env}': path traversal characters not allowed" >&2
    return 1
  fi

  # Must be lowercase alphanumeric with hyphens, starting with letter
  if ! [[ "$env" =~ ^[a-z][a-z0-9-]*$ ]]; then
    echo "Error: Invalid environment name '${env}': must be lowercase alphanumeric with hyphens" >&2
    return 1
  fi

  return 0
}

# Check if jq is available
require_jq() {
  if ! command -v jq &> /dev/null; then
    echo "Error: jq is required but not installed" >&2
    echo "Install with: brew install jq (macOS) or apt-get install jq (Linux)" >&2
    return 1
  fi
  return 0
}

# =============================================================================
# Path Resolution Functions
# =============================================================================

# Get the environment directory path
# Usage: get_env_dir "conformance"
# Returns: .authrim/conformance
get_env_dir() {
  local env="$1"
  validate_env_name "$env" || return 1
  echo "${AUTHRIM_DIR}/${env}"
}

# Get the config.json path for an environment
# Usage: get_config_path "conformance"
# Returns: .authrim/conformance/config.json
get_config_path() {
  local env="$1"
  validate_env_name "$env" || return 1
  echo "${AUTHRIM_DIR}/${env}/config.json"
}

# Get the lock.json path for an environment
# Usage: get_lock_path "conformance"
# Returns: .authrim/conformance/lock.json
get_lock_path() {
  local env="$1"
  validate_env_name "$env" || return 1
  echo "${AUTHRIM_DIR}/${env}/lock.json"
}

# Find keys directory with 3-tier fallback
# Usage: find_keys_dir "conformance" [base_dir]
# Returns: Path to keys directory or empty string if not found
# Search order:
#   1. External: .authrim-keys/{env}/
#   2. Internal: .authrim/{env}/keys/
#   3. Legacy: .keys/{env}/
find_keys_dir() {
  local env="$1"
  local base_dir="${2:-.}"

  validate_env_name "$env" || return 1

  # 1. External: .authrim-keys/{env}/
  if [ -d "${base_dir}/${AUTHRIM_KEYS_DIR}/${env}" ]; then
    echo "${base_dir}/${AUTHRIM_KEYS_DIR}/${env}"
    return 0
  fi

  # 2. Internal: .authrim/{env}/keys/
  if [ -d "${base_dir}/${AUTHRIM_DIR}/${env}/keys" ]; then
    echo "${base_dir}/${AUTHRIM_DIR}/${env}/keys"
    return 0
  fi

  # 3. Legacy: .keys/{env}/
  if [ -d "${base_dir}/${LEGACY_KEYS_DIR}/${env}" ]; then
    echo "${base_dir}/${LEGACY_KEYS_DIR}/${env}"
    return 0
  fi

  return 1
}

# =============================================================================
# JSON Reading Functions
# =============================================================================

# Read a value from config.json using jq
# Usage: read_config "conformance" '.urls.api.custom'
# Returns: The value or empty string if not found
read_config() {
  local env="$1"
  local jq_query="$2"

  validate_env_name "$env" || return 1
  require_jq || return 1

  local config_path
  config_path=$(get_config_path "$env")

  if [ ! -f "$config_path" ]; then
    return 1
  fi

  jq -r "${jq_query} // empty" "$config_path" 2>/dev/null
}

# Read a value from lock.json using jq
# Usage: read_lock "conformance" '.d1.DB.id'
# Returns: The value or empty string if not found
read_lock() {
  local env="$1"
  local jq_query="$2"

  validate_env_name "$env" || return 1
  require_jq || return 1

  local lock_path
  lock_path=$(get_lock_path "$env")

  if [ ! -f "$lock_path" ]; then
    return 1
  fi

  jq -r "${jq_query} // empty" "$lock_path" 2>/dev/null
}

# Get ISSUER_URL with fallback to wrangler.toml
# Usage: get_issuer_url "conformance"
# Search order:
#   1. config.json: .urls.api.custom
#   2. wrangler.toml: [env.xxx.vars] ISSUER_URL
get_issuer_url() {
  local env="$1"
  local url

  validate_env_name "$env" || return 1

  # 1. Try config.json first
  url=$(read_config "$env" '.urls.api.custom' 2>/dev/null)
  if [ -n "$url" ] && [ "$url" != "null" ]; then
    echo "$url"
    return 0
  fi

  # 2. Fallback to wrangler.toml
  local wrangler_file="packages/ar-discovery/wrangler.toml"
  if [ -f "$wrangler_file" ]; then
    url=$(grep -A 100 "\\[env\\.${env}\\.vars\\]" "$wrangler_file" 2>/dev/null | \
          grep 'ISSUER_URL = ' | head -1 | \
          sed 's/.*ISSUER_URL = "\([^"]*\)".*/\1/')
    if [ -n "$url" ]; then
      echo "$url"
      return 0
    fi
  fi

  return 1
}

# Get D1 database ID from lock.json
# Usage: get_d1_id "conformance" "DB"
get_d1_id() {
  local env="$1"
  local binding="$2"

  read_lock "$env" ".d1.${binding}.id"
}

# Get D1 database name from lock.json
# Usage: get_d1_name "conformance" "DB"
get_d1_name() {
  local env="$1"
  local binding="$2"

  read_lock "$env" ".d1.${binding}.name"
}

# Get KV namespace ID from lock.json
# Usage: get_kv_id "conformance" "CLIENTS_CACHE"
get_kv_id() {
  local env="$1"
  local binding="$2"

  read_lock "$env" ".kv.${binding}.id"
}

# Get KV namespace name from lock.json
# Usage: get_kv_name "conformance" "CLIENTS_CACHE"
get_kv_name() {
  local env="$1"
  local binding="$2"

  read_lock "$env" ".kv.${binding}.name"
}

# Get KV preview ID from lock.json
# Usage: get_kv_preview_id "conformance" "CLIENTS_CACHE"
get_kv_preview_id() {
  local env="$1"
  local binding="$2"

  read_lock "$env" ".kv.${binding}.previewId"
}

# =============================================================================
# JSON Writing Functions
# =============================================================================

# Initialize lock.json if it doesn't exist
# Usage: init_lock_file "conformance"
init_lock_file() {
  local env="$1"

  validate_env_name "$env" || return 1
  require_jq || return 1

  local lock_path
  lock_path=$(get_lock_path "$env")
  local env_dir
  env_dir=$(get_env_dir "$env")

  # Create directory if needed
  mkdir -p "$env_dir"

  if [ ! -f "$lock_path" ]; then
    local now
    now=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)

    jq -n \
      --arg version "1.0.0" \
      --arg created "$now" \
      --arg env "$env" \
      '{
        version: $version,
        createdAt: $created,
        updatedAt: $created,
        env: $env,
        d1: {},
        kv: {},
        r2: {}
      }' > "$lock_path"
  fi
}

# Add D1 database to lock.json
# Usage: add_d1_to_lock "conformance" "DB" "conformance-authrim-db" "uuid-here"
add_d1_to_lock() {
  local env="$1"
  local binding="$2"
  local name="$3"
  local id="$4"

  validate_env_name "$env" || return 1
  require_jq || return 1

  local lock_path
  lock_path=$(get_lock_path "$env")

  # Initialize if needed
  init_lock_file "$env"

  local now
  now=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
  local tmp
  tmp=$(mktemp)

  if jq \
    --arg binding "$binding" \
    --arg name "$name" \
    --arg id "$id" \
    --arg updated "$now" \
    '.d1[$binding] = { name: $name, id: $id } | .updatedAt = $updated' \
    "$lock_path" > "$tmp" 2>/dev/null && [ -s "$tmp" ]; then
    mv "$tmp" "$lock_path"
  else
    rm -f "$tmp"
    echo "Error: Failed to update lock.json for D1 binding: $binding" >&2
    return 1
  fi
}

# Add KV namespace to lock.json
# Usage: add_kv_to_lock "conformance" "CLIENTS_CACHE" "conformance-CLIENTS_CACHE" "id" ["preview_id"]
add_kv_to_lock() {
  local env="$1"
  local binding="$2"
  local name="$3"
  local id="$4"
  local preview_id="${5:-}"

  validate_env_name "$env" || return 1
  require_jq || return 1

  local lock_path
  lock_path=$(get_lock_path "$env")

  # Initialize if needed
  init_lock_file "$env"

  local now
  now=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
  local tmp
  tmp=$(mktemp)

  local jq_result=0
  if [ -n "$preview_id" ]; then
    jq \
      --arg binding "$binding" \
      --arg name "$name" \
      --arg id "$id" \
      --arg previewId "$preview_id" \
      --arg updated "$now" \
      '.kv[$binding] = { name: $name, id: $id, previewId: $previewId } | .updatedAt = $updated' \
      "$lock_path" > "$tmp" 2>/dev/null || jq_result=$?
  else
    jq \
      --arg binding "$binding" \
      --arg name "$name" \
      --arg id "$id" \
      --arg updated "$now" \
      '.kv[$binding] = { name: $name, id: $id } | .updatedAt = $updated' \
      "$lock_path" > "$tmp" 2>/dev/null || jq_result=$?
  fi

  if [ $jq_result -eq 0 ] && [ -s "$tmp" ]; then
    mv "$tmp" "$lock_path"
  else
    rm -f "$tmp"
    echo "Error: Failed to update lock.json for KV binding: $binding" >&2
    return 1
  fi
}

# Add R2 bucket to lock.json
# Usage: add_r2_to_lock "conformance" "PUBLIC_ASSETS" "conformance-public-assets"
add_r2_to_lock() {
  local env="$1"
  local binding="$2"
  local name="$3"

  validate_env_name "$env" || return 1
  require_jq || return 1

  local lock_path
  lock_path=$(get_lock_path "$env")

  # Initialize if needed
  init_lock_file "$env"

  local now
  now=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
  local tmp
  tmp=$(mktemp)

  if jq \
    --arg binding "$binding" \
    --arg name "$name" \
    --arg updated "$now" \
    '.r2[$binding] = { name: $name } | .updatedAt = $updated' \
    "$lock_path" > "$tmp" 2>/dev/null && [ -s "$tmp" ]; then
    mv "$tmp" "$lock_path"
  else
    rm -f "$tmp"
    echo "Error: Failed to update lock.json for R2 binding: $binding" >&2
    return 1
  fi
}

# Remove D1 database from lock.json
# Usage: remove_d1_from_lock "conformance" "DB"
remove_d1_from_lock() {
  local env="$1"
  local binding="$2"

  validate_env_name "$env" || return 1
  require_jq || return 1

  local lock_path
  lock_path=$(get_lock_path "$env")

  if [ ! -f "$lock_path" ]; then
    return 0
  fi

  local now
  now=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
  local tmp
  tmp=$(mktemp)

  if jq \
    --arg binding "$binding" \
    --arg updated "$now" \
    'del(.d1[$binding]) | .updatedAt = $updated' \
    "$lock_path" > "$tmp" 2>/dev/null && [ -s "$tmp" ]; then
    mv "$tmp" "$lock_path"
  else
    rm -f "$tmp"
    echo "Error: Failed to remove D1 binding from lock.json: $binding" >&2
    return 1
  fi
}

# Remove KV namespace from lock.json
# Usage: remove_kv_from_lock "conformance" "CLIENTS_CACHE"
remove_kv_from_lock() {
  local env="$1"
  local binding="$2"

  validate_env_name "$env" || return 1
  require_jq || return 1

  local lock_path
  lock_path=$(get_lock_path "$env")

  if [ ! -f "$lock_path" ]; then
    return 0
  fi

  local now
  now=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
  local tmp
  tmp=$(mktemp)

  if jq \
    --arg binding "$binding" \
    --arg updated "$now" \
    'del(.kv[$binding]) | .updatedAt = $updated' \
    "$lock_path" > "$tmp" 2>/dev/null && [ -s "$tmp" ]; then
    mv "$tmp" "$lock_path"
  else
    rm -f "$tmp"
    echo "Error: Failed to remove KV binding from lock.json: $binding" >&2
    return 1
  fi
}

# =============================================================================
# Lock File Query Functions
# =============================================================================

# List all D1 bindings in lock.json
# Usage: list_d1_bindings "conformance"
# Returns: Space-separated list of binding names
list_d1_bindings() {
  local env="$1"

  validate_env_name "$env" || return 1
  require_jq || return 1

  local lock_path
  lock_path=$(get_lock_path "$env")

  if [ ! -f "$lock_path" ]; then
    return 0
  fi

  jq -r '.d1 // {} | keys[]' "$lock_path" 2>/dev/null
}

# List all KV bindings in lock.json
# Usage: list_kv_bindings "conformance"
# Returns: Space-separated list of binding names
list_kv_bindings() {
  local env="$1"

  validate_env_name "$env" || return 1
  require_jq || return 1

  local lock_path
  lock_path=$(get_lock_path "$env")

  if [ ! -f "$lock_path" ]; then
    return 0
  fi

  jq -r '.kv // {} | keys[]' "$lock_path" 2>/dev/null
}

# Check if lock.json exists for an environment
# Usage: lock_file_exists "conformance"
lock_file_exists() {
  local env="$1"

  validate_env_name "$env" || return 1

  local lock_path
  lock_path=$(get_lock_path "$env")

  [ -f "$lock_path" ]
}

# Check if config.json exists for an environment
# Usage: config_file_exists "conformance"
config_file_exists() {
  local env="$1"

  validate_env_name "$env" || return 1

  local config_path
  config_path=$(get_config_path "$env")

  [ -f "$config_path" ]
}

# =============================================================================
# Environment Detection Functions
# =============================================================================

# List available environments
# Usage: list_environments
# Returns: List of environment names, one per line
list_environments() {
  local authrim_dir="${AUTHRIM_DIR}"

  if [ ! -d "$authrim_dir" ]; then
    return 0
  fi

  for dir in "$authrim_dir"/*/; do
    if [ -d "$dir" ]; then
      local env_name
      env_name=$(basename "$dir")
      # Check if it's a valid environment (has config.json or keys/)
      if [ -f "${dir}config.json" ] || [ -d "${dir}keys" ]; then
        echo "$env_name"
      fi
    fi
  done
}

# Check if an environment exists
# Usage: environment_exists "conformance"
environment_exists() {
  local env="$1"

  validate_env_name "$env" || return 1

  local env_dir
  env_dir=$(get_env_dir "$env")

  [ -d "$env_dir" ] && ([ -f "${env_dir}/config.json" ] || [ -d "${env_dir}/keys" ])
}
