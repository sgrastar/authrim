#!/bin/bash

###############################################################################
# Enrai Build Script
#
# Purpose: Build and deploy environment based on configuration file
# Usage:
#   ./scripts/build.sh --config enrai-config-1.0.0.json
#   ./scripts/build.sh --mode delete
#   ./scripts/build.sh --verbose  # Enable verbose mode
###############################################################################

set -e

# Check for verbose mode
VERBOSE=false
for arg in "$@"; do
  if [[ "$arg" == "--verbose" || "$arg" == "-v" ]]; then
    VERBOSE=true
    set -x  # Enable bash debug mode
  fi
done

# Color definitions
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Logging functions
log_info() {
  echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
  echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warn() {
  echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
  echo -e "${RED}[ERROR]${NC} $1"
}

# Error handler
error_handler() {
  local exit_code=$1
  local line_number=$2
  log_error "An error occurred (line: $line_number, code: $exit_code)"
  log_info "If rollback is needed, run: ./scripts/build.sh --mode delete"
  exit $exit_code
}

trap 'error_handler $? $LINENO' ERR

# Retry function
retry() {
  local max_attempts=3
  local attempt=1
  local delay=5

  while [ $attempt -le $max_attempts ]; do
    if "$@"; then
      return 0
    else
      log_warn "Failed. Retrying... ($attempt/$max_attempts)"
      sleep $delay
      delay=$((delay * 2))  # Exponential backoff
      attempt=$((attempt + 1))
    fi
  done

  log_error "Maximum retry attempts reached"
  return 1
}

###############################################################################
# [1] Parse Arguments
###############################################################################

parse_arguments() {
  CONFIG_FILE=""
  MODE=""
  SKIP_DEPLOY=false

  while [[ $# -gt 0 ]]; do
    case $1 in
      --config)
        CONFIG_FILE="$2"
        shift 2
        ;;
      --mode)
        MODE="$2"
        shift 2
        ;;
      --skip-deploy)
        SKIP_DEPLOY=true
        shift
        ;;
      --verbose|-v)
        # Verbose flag is already handled at the top of the script
        shift
        ;;
      *)
        log_error "Unknown option: $1"
        echo "Usage: $0 --config <file> [--mode <new|update|delete>] [--skip-deploy] [--verbose]"
        exit 1
        ;;
    esac
  done
}

###############################################################################
# [2] Load Configuration
###############################################################################

load_config() {
  if [[ -z "$CONFIG_FILE" ]]; then
    log_info "Select configuration file:"

    # Find enrai-config-*.json files
    config_files=(enrai-config-*.json)

    if [[ ! -f "${config_files[0]}" ]]; then
      log_error "No configuration files found"
      log_info "First run: ./scripts/setup-config.sh to create a configuration file"
      exit 1
    fi

    select config_file in "${config_files[@]}"; do
      if [[ -f "$config_file" ]]; then
        CONFIG_FILE="$config_file"
        break
      else
        log_error "File not found"
      fi
    done
  fi

  if [[ ! -f "$CONFIG_FILE" ]]; then
    log_error "Configuration file not found: $CONFIG_FILE"
    exit 1
  fi

  log_success "Configuration file loaded: $CONFIG_FILE"

  # Read configuration with jq
  ENVIRONMENT=$(jq -r '.environment' "$CONFIG_FILE")
  PATTERN=$(jq -r '.pattern' "$CONFIG_FILE")
  OPERATION_MODE=$(jq -r '.operation_mode' "$CONFIG_FILE")

  ENABLE_API=$(jq -r '.components.api.enabled' "$CONFIG_FILE")
  API_CUSTOM_DOMAIN=$(jq -r '.components.api.custom_domain' "$CONFIG_FILE")
  API_DOMAIN=$(jq -r '.components.api.domain' "$CONFIG_FILE")
  API_WORKER_NAME=$(jq -r '.components.api.worker_name // "enrai"' "$CONFIG_FILE")

  ENABLE_LOGIN_PAGE=$(jq -r '.components.login_page.enabled' "$CONFIG_FILE")
  LOGIN_HOSTING=$(jq -r '.components.login_page.hosting' "$CONFIG_FILE")
  LOGIN_CUSTOM_DOMAIN=$(jq -r '.components.login_page.custom_domain' "$CONFIG_FILE")
  LOGIN_DOMAIN=$(jq -r '.components.login_page.domain' "$CONFIG_FILE")
  LOGIN_PAGES_PROJECT=$(jq -r '.components.login_page.pages_project_name // "enrai-login"' "$CONFIG_FILE")

  ENABLE_ADMIN_PAGE=$(jq -r '.components.admin_page.enabled' "$CONFIG_FILE")
  ADMIN_HOSTING=$(jq -r '.components.admin_page.hosting' "$CONFIG_FILE")
  ADMIN_CUSTOM_DOMAIN=$(jq -r '.components.admin_page.custom_domain' "$CONFIG_FILE")
  ADMIN_DOMAIN=$(jq -r '.components.admin_page.domain' "$CONFIG_FILE")
  ADMIN_PAGES_PROJECT=$(jq -r '.components.admin_page.pages_project_name // "enrai-admin"' "$CONFIG_FILE")

  ACCOUNT_NAME=$(jq -r '.cloudflare.account_name' "$CONFIG_FILE")
  USE_ROUTER=$(jq -r '.cloudflare.use_router' "$CONFIG_FILE")

  GENERATE_KEYS=$(jq -r '.secrets.generate_keys' "$CONFIG_FILE")

  CORS_ENABLED=$(jq -r '.cors.enabled' "$CONFIG_FILE")

  echo ""
}

###############################################################################
# [3] Confirm Operation Mode
###############################################################################

confirm_operation_mode() {
  if [[ -z "$MODE" ]]; then
    echo "========================================="
    echo "Select Operation Mode"
    echo "========================================="
    echo "1) New build (create)"
    echo "2) Update existing configuration"
    echo "3) Delete data and reset (cleanup)"
    echo ""
    read -p "Select [1-3]: " mode_choice

    case $mode_choice in
      1) MODE="new" ;;
      2) MODE="update" ;;
      3) MODE="delete" ;;
      *) log_error "Invalid selection"; exit 1 ;;
    esac
  fi

  # Confirm deletion
  if [[ "$MODE" == "delete" ]]; then
    echo ""
    log_warn "WARNING: All resources and data will be deleted"
    read -p "Are you sure you want to delete? [yes/no]: " confirm_delete
    if [[ "$confirm_delete" != "yes" ]]; then
      log_info "Aborted"
      exit 0
    fi
  fi

  log_success "Operation mode: $MODE"
  echo ""
}

###############################################################################
# [4] Display Settings
###############################################################################

display_settings() {
  echo "========================================="
  echo "Configuration"
  echo "========================================="
  echo "Environment: $ENVIRONMENT"
  echo "Pattern: $PATTERN"
  echo "Operation Mode: $MODE"
  echo ""
  echo "Components:"
  echo "  API: $ENABLE_API"
  [[ "$ENABLE_API" == "true" ]] && echo "    Domain: $API_DOMAIN"
  echo "  Login Page: $ENABLE_LOGIN_PAGE"
  [[ "$ENABLE_LOGIN_PAGE" == "true" ]] && echo "    Domain: $LOGIN_DOMAIN"
  echo "  Admin Page: $ENABLE_ADMIN_PAGE"
  [[ "$ENABLE_ADMIN_PAGE" == "true" ]] && echo "    Domain: $ADMIN_DOMAIN"
  echo ""
  echo "Cloudflare Account: $ACCOUNT_NAME"
  echo "Use Router Worker: $USE_ROUTER"
  echo "Generate Secrets: $GENERATE_KEYS"
  echo "CORS Enabled: $CORS_ENABLED"
  echo "========================================="
  echo ""
}

###############################################################################
# [5] Check Conflicts
###############################################################################

check_conflicts() {
  if [[ "$MODE" == "delete" ]]; then
    return 0
  fi

  log_info "Checking remote resources..."

  CONFLICTS=false

  # Check Workers
  if [[ "$ENABLE_API" == "true" && -n "$API_WORKER_NAME" ]]; then
    if wrangler deployments list --name="$API_WORKER_NAME" &>/dev/null; then
      log_warn "Worker '$API_WORKER_NAME' already exists"
      if [[ "$MODE" == "new" ]]; then
        CONFLICTS=true
      fi
    fi
  fi

  # Check Router Worker
  if [[ "$USE_ROUTER" == "true" ]]; then
    if wrangler deployments list --name="enrai-router" &>/dev/null; then
      log_warn "Worker 'enrai-router' already exists"
      if [[ "$MODE" == "new" ]]; then
        CONFLICTS=true
      fi
    fi
  fi

  # Check KV Namespaces
  log_info "Checking KV Namespaces..."
  EXISTING_KV=$(wrangler kv namespace list 2>/dev/null || echo "[]")

  if [[ "$VERBOSE" == "true" ]]; then
    echo "[VERBOSE] Existing KV Namespaces:"
    echo "$EXISTING_KV"
  fi

  # Check D1 Databases
  log_info "Checking D1 Databases..."
  EXISTING_D1=$(wrangler d1 list 2>/dev/null || echo "[]")

  if [[ "$VERBOSE" == "true" ]]; then
    echo "[VERBOSE] Existing D1 Databases:"
    echo "$EXISTING_D1"
  fi

  if [[ "$CONFLICTS" == "true" ]]; then
    echo ""
    log_warn "Conflicts detected with existing resources"
    read -p "Continue anyway? [y/N]: " continue_confirm
    if [[ ! "$continue_confirm" =~ ^[Yy]$ ]]; then
      log_info "Aborted"
      exit 0
    fi
  else
    log_success "No conflicts detected"
  fi

  echo ""
}

###############################################################################
# [6] Generate Packages
###############################################################################

generate_packages() {
  log_info "Generating package configuration..."

  # Backup existing wrangler.toml if present
  for pkg in packages/*/wrangler.toml; do
    if [[ -f "$pkg" ]]; then
      cp "$pkg" "$pkg.backup"
    fi
  done

  # Generate .dev.vars (local environment)
  if [[ "$ENVIRONMENT" == "local" ]]; then
    generate_dev_vars
  fi

  # Generate wrangler.toml by pattern
  case "$PATTERN" in
    pattern-a|pattern-b|pattern-c)
      generate_worker_configs
      ;;
    pattern-d)
      generate_worker_configs_headless
      ;;
  esac

  log_success "Package configuration generated"
  echo ""
}

generate_dev_vars() {
  log_info "Generating .dev.vars..."

  # CORS origins list
  ADMIN_UI_ORIGINS=""
  if [[ "$CORS_ENABLED" == "true" ]]; then
    CORS_ORIGINS_ARRAY=$(jq -r '.cors.allowed_origins[]' "$CONFIG_FILE" 2>/dev/null || echo "")
    ADMIN_UI_ORIGINS=$(echo "$CORS_ORIGINS_ARRAY" | tr '\n' ',' | sed 's/,$//')
  fi

  cat > .dev.vars <<EOF
# Enrai Development Environment Variables
# Generated by build.sh

ISSUER_URL=$API_DOMAIN
PUBLIC_API_BASE_URL=$API_DOMAIN
ADMIN_UI_ORIGIN=$ADMIN_UI_ORIGINS
EOF

  log_success ".dev.vars generated"
}

generate_worker_configs() {
  log_info "Generating Worker configuration (Pattern: $PATTERN)..."

  # Router Worker wrangler.toml
  if [[ "$USE_ROUTER" == "true" ]]; then
    log_info "Generating Router Worker configuration..."
    # Keep existing wrangler.toml (KV, DO, D1 bindings added later)
  fi

  # Specialized Workers
  # (Keep existing wrangler.toml, update as needed)
}

generate_worker_configs_headless() {
  log_info "Generating Worker configuration (Headless)..."
  # Minimal configuration for headless
}

###############################################################################
# [7] Setup Cloudflare Resources
###############################################################################

setup_cloudflare_resources() {
  log_info "Setting up Cloudflare resources..."

  # KV Namespaces
  setup_kv_namespaces

  # D1 Databases
  setup_d1_databases

  # Update configuration file with resource IDs
  update_config_with_resource_ids

  # Update wrangler.toml files with resource IDs
  update_wrangler_toml

  log_success "Cloudflare resources configured"
  echo ""
}

setup_kv_namespaces() {
  log_info "Setting up KV Namespaces..."

  # Get existing KV namespaces from Cloudflare
  EXISTING_KV_LIST=$(wrangler kv namespace list 2>/dev/null || echo "[]")

  # Required KV list
  KV_BINDINGS=("AUTH_CODES" "CLIENTS" "REFRESH_TOKENS" "SESSIONS" "SETTINGS_KV")

  for binding in "${KV_BINDINGS[@]}"; do
    # Check if already in config file
    existing_id=$(jq -r --arg binding "$binding" \
      '.resources.kv_namespaces[] | select(.binding == $binding) | .id' \
      "$CONFIG_FILE" 2>/dev/null)

    if [[ -n "$existing_id" && "$existing_id" != "null" ]]; then
      log_info "  $binding: Using existing namespace from config (ID: $existing_id)"
    else
      # Check if namespace with same title already exists in Cloudflare
      existing_cf_id=$(echo "$EXISTING_KV_LIST" | jq -r --arg title "$binding" \
        '.[] | select(.title == $title) | .id' 2>/dev/null | head -1)

      if [[ -n "$existing_cf_id" && "$existing_cf_id" != "null" ]]; then
        log_info "  $binding: Found existing namespace in Cloudflare (ID: $existing_cf_id)"
        namespace_id="$existing_cf_id"
      else
        # Create new
        log_info "  $binding: Creating..."

        if [[ "$VERBOSE" == "true" ]]; then
          echo "[VERBOSE] Running: wrangler kv namespace create $binding"
        fi

        result=$(wrangler kv namespace create "$binding" 2>&1)

        if [[ "$VERBOSE" == "true" ]]; then
          echo "[VERBOSE] Command output:"
          echo "$result"
        fi

        # Extract ID from text output (format: "id": "...")
        namespace_id=$(echo "$result" | grep -oE '"id":\s*"[a-f0-9]+"' | grep -oE '[a-f0-9]{32}' | head -1)

        if [[ -z "$namespace_id" ]]; then
          log_error "  $binding: Failed to create namespace or extract ID"
          echo "Full output:"
          echo "$result"
          exit 1
        fi

        log_success "  $binding: Created (ID: $namespace_id)"
      fi

      # Add to configuration file
      jq --arg binding "$binding" --arg id "$namespace_id" \
        '.resources.kv_namespaces += [{"binding": $binding, "id": $id}]' \
        "$CONFIG_FILE" > "$CONFIG_FILE.tmp" && mv "$CONFIG_FILE.tmp" "$CONFIG_FILE"
    fi
  done
}

setup_d1_databases() {
  log_info "Setting up D1 Databases..."

  # Get existing D1 databases from Cloudflare
  EXISTING_D1_LIST=$(wrangler d1 list 2>/dev/null || echo "[]")

  DB_NAME="enrai-users-db"

  # Check if already in config file
  existing_id=$(jq -r --arg name "$DB_NAME" \
    '.resources.d1_databases[] | select(.database_name == $name) | .database_id' \
    "$CONFIG_FILE" 2>/dev/null)

  if [[ -n "$existing_id" && "$existing_id" != "null" ]]; then
    log_info "  $DB_NAME: Using existing database from config (ID: $existing_id)"
  else
    # Check if database with same name already exists in Cloudflare
    existing_cf_id=$(echo "$EXISTING_D1_LIST" | jq -r --arg name "$DB_NAME" \
      '.[] | select(.name == $name) | .uuid' 2>/dev/null | head -1)

    if [[ -n "$existing_cf_id" && "$existing_cf_id" != "null" ]]; then
      log_info "  $DB_NAME: Found existing database in Cloudflare (ID: $existing_cf_id)"
      db_id="$existing_cf_id"
    else
      # Create new
      log_info "  $DB_NAME: Creating..."

      if [[ "$VERBOSE" == "true" ]]; then
        echo "[VERBOSE] Running: wrangler d1 create $DB_NAME"
      fi

      result=$(wrangler d1 create "$DB_NAME" 2>&1)

      if [[ "$VERBOSE" == "true" ]]; then
        echo "[VERBOSE] Command output:"
        echo "$result"
      fi

      # Extract database_id from text output (format: "database_id": "uuid")
      db_id=$(echo "$result" | grep -oE '"database_id":\s*"[a-f0-9-]+"' | grep -oE '[a-f0-9-]{36}' | head -1)

      if [[ -z "$db_id" ]]; then
        log_error "  $DB_NAME: Failed to create database or extract ID"
        echo "Full output:"
        echo "$result"
        exit 1
      fi

      log_success "  $DB_NAME: Created (ID: $db_id)"
    fi

    # Run migrations (if migrations/0001_initial.sql exists)
    if [[ -f "migrations/0001_initial.sql" ]]; then
      log_info "  Running migrations..."
      wrangler d1 execute "$DB_NAME" --file=./migrations/0001_initial.sql || true
    fi

    # Add to configuration file
    jq --arg name "$DB_NAME" --arg id "$db_id" \
      '.resources.d1_databases += [{"binding": "USERS_DB", "database_name": $name, "database_id": $id}]' \
      "$CONFIG_FILE" > "$CONFIG_FILE.tmp" && mv "$CONFIG_FILE.tmp" "$CONFIG_FILE"
  fi
}

update_config_with_resource_ids() {
  # Add updated timestamp to configuration file
  jq --arg updated "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
    '.updated_at = $updated' \
    "$CONFIG_FILE" > "$CONFIG_FILE.tmp" && mv "$CONFIG_FILE.tmp" "$CONFIG_FILE"
}

update_wrangler_toml() {
  log_info "Updating wrangler.toml files with resource IDs..."

  # Get D1 database ID from config
  db_id=$(jq -r '.resources.d1_databases[0].database_id' "$CONFIG_FILE" 2>/dev/null)
  db_name=$(jq -r '.resources.d1_databases[0].database_name' "$CONFIG_FILE" 2>/dev/null)

  if [[ -n "$db_id" && "$db_id" != "null" ]]; then
    # Update all wrangler.toml files that reference D1 database
    for toml_file in packages/*/wrangler.toml; do
      if [[ -f "$toml_file" ]] && grep -q "database_name.*=.*\"enrai-" "$toml_file"; then
        if [[ "$VERBOSE" == "true" ]]; then
          echo "[VERBOSE] Updating $toml_file with D1: $db_name ($db_id)"
        fi

        # Use sed to update D1 database configuration
        sed -i.bak "s/database_name = \"enrai-[^\"]*\"/database_name = \"$db_name\"/" "$toml_file"
        sed -i.bak "s/database_id = \"[^\"]*\"/database_id = \"$db_id\"/" "$toml_file"

        # Remove backup file
        rm -f "${toml_file}.bak"
      fi
    done
    log_success "Updated all wrangler.toml files with D1: $db_name ($db_id)"
  fi

  # Get KV namespace IDs from config
  kv_namespaces=$(jq -c '.resources.kv_namespaces[]' "$CONFIG_FILE" 2>/dev/null)

  if [[ "$VERBOSE" == "true" && -n "$kv_namespaces" ]]; then
    echo "[VERBOSE] KV Namespaces to configure:"
    echo "$kv_namespaces"
  fi

  log_success "wrangler.toml files updated"
}

###############################################################################
# [8] Setup Secrets
###############################################################################

setup_secrets() {
  if [[ "$GENERATE_KEYS" != "true" ]]; then
    log_info "Secret generation skipped"
    return 0
  fi

  log_info "Setting up secrets..."

  REUSE_LOCAL_KEYS=false
  REUSE_REMOTE_KEYS=false

  # Check for existing local keys
  if [[ -f ".keys/private.pem" && -f ".keys/public.pem" ]]; then
    log_info "Existing keys found locally"
    read -p "Use existing keys? [Y/n]: " use_existing
    if [[ ! "$use_existing" =~ ^[Nn]$ ]]; then
      REUSE_LOCAL_KEYS=true
    fi
  fi

  # Check for existing remote keys
  if wrangler secret list --name="enrai-shared" 2>/dev/null | grep -q "RSA_PRIVATE_KEY"; then
    log_info "Existing keys found on remote"
    read -p "Use existing remote keys? [Y/n]: " use_remote
    if [[ ! "$use_remote" =~ ^[Nn]$ ]]; then
      REUSE_REMOTE_KEYS=true
    fi
  fi

  # Generate new keys
  if [[ "$REUSE_LOCAL_KEYS" != "true" && "$REUSE_REMOTE_KEYS" != "true" ]]; then
    log_info "Generating new keys..."
    mkdir -p .keys

    # Generate RSA keys
    openssl genrsa -out .keys/private.pem 2048
    openssl rsa -in .keys/private.pem -pubout -out .keys/public.pem

    log_success "Keys generated: .keys/private.pem, .keys/public.pem"
  fi

  # Upload to remote
  if [[ "$REUSE_REMOTE_KEYS" != "true" && -f ".keys/private.pem" ]]; then
    log_info "Uploading secrets to Cloudflare..."
    cat .keys/private.pem | wrangler secret put RSA_PRIVATE_KEY --name="enrai-shared" 2>/dev/null || true
    cat .keys/public.pem | wrangler secret put RSA_PUBLIC_KEY --name="enrai-shared" 2>/dev/null || true
    log_success "Secrets uploaded"
  fi

  echo ""
}

###############################################################################
# [9] Setup CORS
###############################################################################

setup_cors() {
  if [[ "$CORS_ENABLED" != "true" ]]; then
    log_info "CORS configuration skipped"
    return 0
  fi

  log_info "Applying CORS configuration..."

  # Save to KV
  CORS_SETTINGS=$(jq -c '.cors' "$CONFIG_FILE")

  # Get SETTINGS_KV ID from binding
  SETTINGS_KV_ID=$(jq -r '.resources.kv_namespaces[] | select(.binding == "SETTINGS_KV") | .id' "$CONFIG_FILE")

  if [[ -z "$SETTINGS_KV_ID" || "$SETTINGS_KV_ID" == "null" ]]; then
    log_warn "SETTINGS_KV not found. Skipping CORS configuration"
    return 0
  fi

  # Save to KV
  echo "$CORS_SETTINGS" | wrangler kv key put "cors_settings" \
    --namespace-id="$SETTINGS_KV_ID" \
    --path=/dev/stdin 2>/dev/null || true

  log_success "CORS configuration saved"
  echo ""
}

###############################################################################
# [10-11] Deploy Confirmation and Execution
###############################################################################

deploy() {
  if [[ "$SKIP_DEPLOY" == "true" ]]; then
    log_info "Deployment skipped (--skip-deploy)"
    return
  fi

  read -p "Run deployment? [Y/n]: " run_deploy
  if [[ "$run_deploy" =~ ^[Nn]$ ]]; then
    log_info "Deployment skipped"
    log_info "You can run later: pnpm run deploy:with-router"
    return
  fi

  log_info "Starting deployment..."

  # Build Shared package
  log_info "Building Shared package..."
  pnpm --filter=shared build

  # Deploy Workers (sequential, with retry)
  deploy_workers

  # Deploy UI
  deploy_ui

  log_success "Deployment complete"
  show_deployment_urls
}

deploy_workers() {
  log_info "Deploying Workers..."

  # Use existing deploy-with-retry.sh if available
  if [[ -f "scripts/deploy-with-retry.sh" ]]; then
    log_info "Using deploy-with-retry.sh"
    ./scripts/deploy-with-retry.sh
  else
    # Sequential deployment
    WORKERS=("shared" "op-discovery" "op-auth" "op-token" "op-userinfo" "op-management")

    if [[ "$USE_ROUTER" == "true" ]]; then
      WORKERS+=("router")
    fi

    for worker in "${WORKERS[@]}"; do
      log_info "Deploying: $worker"
      retry pnpm --filter="$worker" deploy
      sleep 10  # Avoid rate limits
    done
  fi
}

create_ui_env_file() {
  local api_url=$1

  log_info "Creating .env file for UI build..."
  log_info "  Setting PUBLIC_API_BASE_URL=$api_url"

  # Create .env file in UI package
  cat > packages/ui/.env <<EOF
# Auto-generated by build.sh
# API Configuration
PUBLIC_API_BASE_URL=$api_url
EOF

  log_success "  Created packages/ui/.env"
}

deploy_ui() {
  if [[ "$ENABLE_LOGIN_PAGE" == "true" ]] || [[ "$ENABLE_ADMIN_PAGE" == "true" ]]; then
    if [[ "$LOGIN_HOSTING" == "cloudflare-pages" ]] || [[ "$ADMIN_HOSTING" == "cloudflare-pages" ]]; then
      log_info "Deploying UI to Cloudflare Pages..."

      # Create .env file with API URL for build
      create_ui_env_file "$API_DOMAIN"

      # Build UI
      log_info "Building UI..."
      pnpm --filter=ui build

      # Deploy to Cloudflare Pages with correct project name
      if [[ "$ENABLE_LOGIN_PAGE" == "true" && "$LOGIN_HOSTING" == "cloudflare-pages" ]]; then
        log_info "Deploying Login Page: $LOGIN_PAGES_PROJECT"
        yes | wrangler pages deploy packages/ui/.svelte-kit/cloudflare \
          --project-name="$LOGIN_PAGES_PROJECT" \
          --branch=main || log_warn "Login page deployment failed"
      fi

      if [[ "$ENABLE_ADMIN_PAGE" == "true" && "$ADMIN_HOSTING" == "cloudflare-pages" ]]; then
        log_info "Deploying Admin Page: $ADMIN_PAGES_PROJECT"
        yes | wrangler pages deploy packages/ui/.svelte-kit/cloudflare \
          --project-name="$ADMIN_PAGES_PROJECT" \
          --branch=main || log_warn "Admin page deployment failed"
      fi
    fi
  fi
}

show_deployment_urls() {
  echo ""
  echo "========================================="
  echo "Deployment Complete!"
  echo "========================================="

  [[ "$ENABLE_API" == "true" ]] && echo "API: $API_DOMAIN"
  [[ "$ENABLE_LOGIN_PAGE" == "true" ]] && echo "Login Page: $LOGIN_DOMAIN"
  [[ "$ENABLE_ADMIN_PAGE" == "true" ]] && echo "Admin Page: $ADMIN_DOMAIN"

  echo "========================================="
  echo ""
}

###############################################################################
# [12] Delete Mode
###############################################################################

delete_all_resources() {
  log_warn "Deleting all resources..."

  # Use existing delete-all.sh if available
  if [[ -f "scripts/delete-all.sh" ]]; then
    log_info "Using delete-all.sh"
    ./scripts/delete-all.sh
  else
    log_info "Please delete resources manually"
    log_info "Workers: wrangler delete <worker-name>"
    log_info "KV: wrangler kv namespace delete --namespace-id=<id>"
    log_info "D1: wrangler d1 delete <database-name>"
  fi

  log_success "Deletion complete"
}

###############################################################################
# Main Process
###############################################################################

main() {
  echo ""
  echo "========================================="
  echo "Enrai Build Script"
  echo "========================================="
  echo ""

  parse_arguments "$@"
  load_config
  confirm_operation_mode

  if [[ "$MODE" == "delete" ]]; then
    delete_all_resources
    exit 0
  fi

  display_settings
  check_conflicts
  generate_packages
  setup_cloudflare_resources
  setup_secrets
  setup_cors
  deploy

  echo ""
  log_success "All processes completed!"
  echo ""
  log_info "Configuration file: $CONFIG_FILE"
  log_info "Documentation: docs/ARCHITECTURE_PATTERNS.md"
}

# Run script
main "$@"
