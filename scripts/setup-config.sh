#!/bin/bash

###############################################################################
# Enrai Configuration File Creation Script
#
# Purpose: Interactively collect configuration and generate config file
# Output: enrai-config-{version}.json
#
# Usage:
#   ./scripts/setup-config.sh
###############################################################################

set -e

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
  exit $exit_code
}

trap 'error_handler $? $LINENO' ERR

###############################################################################
# [1] Check Prerequisites
###############################################################################

check_prerequisites() {
  log_info "Checking prerequisites..."

  # Check if Wrangler is installed
  if ! command -v wrangler &> /dev/null; then
    log_error "Wrangler is not installed"
    echo "Install: npm install -g wrangler"
    exit 1
  fi
  log_success "Wrangler: Installed"

  # Check if logged in to Cloudflare
  if ! wrangler whoami &> /dev/null; then
    log_error "Not logged in to Cloudflare"
    echo "Login: wrangler login"
    exit 1
  fi
  log_success "Cloudflare: Logged in"

  # Check if jq is installed
  if ! command -v jq &> /dev/null; then
    log_error "jq is not installed"
    echo "Install: brew install jq (macOS) or apt-get install jq (Linux)"
    exit 1
  fi
  log_success "jq: Installed"

  echo ""
}

###############################################################################
# [2] Select Environment
###############################################################################

select_environment() {
  echo "========================================="
  echo "Select Environment"
  echo "========================================="
  echo "1) Local development (local)"
  echo "2) Remote environment (remote)"
  echo ""
  read -p "Select [1-2]: " env_choice

  case $env_choice in
    1) ENVIRONMENT="local" ;;
    2) ENVIRONMENT="remote" ;;
    *) log_error "Invalid selection"; exit 1 ;;
  esac

  log_success "Environment: $ENVIRONMENT"
  echo ""
}

###############################################################################
# [3] Select Operation Mode
###############################################################################

select_operation_mode() {
  echo "========================================="
  echo "Select Operation Mode"
  echo "========================================="
  echo "1) New configuration"
  echo "2) Update existing configuration"
  echo "3) Version upgrade (keep existing settings)"
  echo ""
  read -p "Select [1-3]: " mode_choice

  case $mode_choice in
    1) OPERATION_MODE="new" ;;
    2) OPERATION_MODE="update" ;;
    3) OPERATION_MODE="version_upgrade" ;;
    *) log_error "Invalid selection"; exit 1 ;;
  esac

  # Load existing config for update/upgrade
  if [[ "$OPERATION_MODE" != "new" ]]; then
    echo ""
    log_info "Select existing configuration file:"

    # Find enrai-config-*.json files
    config_files=(enrai-config-*.json)

    if [[ ! -f "${config_files[0]}" ]]; then
      log_error "No existing configuration files found"
      exit 1
    fi

    select config_file in "${config_files[@]}"; do
      if [[ -f "$config_file" ]]; then
        EXISTING_CONFIG="$config_file"
        log_success "Selected: $EXISTING_CONFIG"
        break
      else
        log_error "File not found"
      fi
    done
  fi

  log_success "Operation mode: $OPERATION_MODE"
  echo ""
}

###############################################################################
# [4] Select Pattern
###############################################################################

select_pattern() {
  echo "========================================="
  echo "Select Deployment Pattern"
  echo "========================================="
  echo "1) Pattern A - Unified Domain (Recommended, Simple)"
  echo "2) Pattern B - Separate Admin UI (Enhanced Security)"
  echo "3) Pattern C - Multi-Domain SSO (Enterprise)"
  echo "4) Pattern D - Headless (API Only)"
  echo ""
  echo "Details: docs/ARCHITECTURE_PATTERNS.md"
  echo ""
  read -p "Select [1-4]: " pattern_choice

  case $pattern_choice in
    1) PATTERN="pattern-a" ;;
    2) PATTERN="pattern-b" ;;
    3) PATTERN="pattern-c" ;;
    4) PATTERN="pattern-d" ;;
    *) log_error "Invalid selection"; exit 1 ;;
  esac

  log_success "Pattern: $PATTERN"
  echo ""
}

###############################################################################
# [5] Select Components
###############################################################################

select_components() {
  echo "========================================="
  echo "Component Selection"
  echo "========================================="

  # Pattern D: API only
  if [[ "$PATTERN" == "pattern-d" ]]; then
    ENABLE_API="true"
    ENABLE_LOGIN_PAGE="false"
    ENABLE_ADMIN_PAGE="false"
    log_info "Pattern D: API only enabled"
  else
    read -p "Enable API? [Y/n]: " enable_api
    ENABLE_API=$([[ "$enable_api" =~ ^[Nn]$ ]] && echo "false" || echo "true")

    read -p "Enable Login Page? [Y/n]: " enable_login
    ENABLE_LOGIN_PAGE=$([[ "$enable_login" =~ ^[Nn]$ ]] && echo "false" || echo "true")

    read -p "Enable Admin Page? [Y/n]: " enable_admin
    ENABLE_ADMIN_PAGE=$([[ "$enable_admin" =~ ^[Nn]$ ]] && echo "false" || echo "true")
  fi

  log_success "API: $ENABLE_API, Login Page: $ENABLE_LOGIN_PAGE, Admin Page: $ENABLE_ADMIN_PAGE"
  echo ""
}

###############################################################################
# [6] Configure Domains
###############################################################################

configure_domains() {
  echo "========================================="
  echo "Domain Configuration"
  echo "========================================="

  # Get Cloudflare account name
  log_info "Retrieving Cloudflare account name..."
  ACCOUNT_NAME=$(wrangler whoami 2>/dev/null | grep "Account Name" | awk '{print $3}' || echo "")

  if [[ -z "$ACCOUNT_NAME" ]]; then
    read -p "Enter Cloudflare account name: " ACCOUNT_NAME
  else
    read -p "Cloudflare account name [$ACCOUNT_NAME]: " input_account
    ACCOUNT_NAME="${input_account:-$ACCOUNT_NAME}"
  fi

  if [[ "$ENVIRONMENT" == "remote" ]]; then
    read -p "Use custom domain? [y/N]: " use_custom_domain

    if [[ "$use_custom_domain" =~ ^[Yy]$ ]]; then
      USE_CUSTOM_DOMAIN="true"

      # Configure custom domain for each component
      if [[ "$ENABLE_API" == "true" ]]; then
        read -p "API custom domain (e.g., https://id.example.com): " api_domain
        API_CUSTOM_DOMAIN="true"
        API_DOMAIN="$api_domain"
      fi

      if [[ "$ENABLE_LOGIN_PAGE" == "true" ]]; then
        read -p "Login Page custom domain (e.g., https://login.example.com): " login_domain
        read -p "Use same domain as API for Login Page? [y/N]: " same_domain_login
        if [[ "$same_domain_login" =~ ^[Yy]$ ]]; then
          LOGIN_CUSTOM_DOMAIN="true"
          LOGIN_DOMAIN="$API_DOMAIN"
        else
          LOGIN_CUSTOM_DOMAIN="true"
          LOGIN_DOMAIN="$login_domain"
        fi
      fi

      if [[ "$ENABLE_ADMIN_PAGE" == "true" ]]; then
        read -p "Admin Page custom domain (e.g., https://admin.example.com): " admin_domain
        read -p "Use same domain as API for Admin Page? [y/N]: " same_domain_admin
        if [[ "$same_domain_admin" =~ ^[Yy]$ ]]; then
          ADMIN_CUSTOM_DOMAIN="true"
          ADMIN_DOMAIN="$API_DOMAIN"
        else
          ADMIN_CUSTOM_DOMAIN="true"
          ADMIN_DOMAIN="$admin_domain"
        fi
      fi
    else
      USE_CUSTOM_DOMAIN="false"

      # Use workers.dev / pages.dev
      if [[ "$ENABLE_API" == "true" ]]; then
        read -p "API Worker name [default: enrai]: " worker_name
        WORKER_NAME="${worker_name:-enrai}"
        API_CUSTOM_DOMAIN="false"
        API_DOMAIN="https://${WORKER_NAME}.${ACCOUNT_NAME}.workers.dev"
        API_WORKER_NAME="$WORKER_NAME"
      fi

      if [[ "$ENABLE_LOGIN_PAGE" == "true" ]]; then
        read -p "Login Page project name [default: enrai-${ACCOUNT_NAME}-login]: " login_project
        LOGIN_PROJECT="${login_project:-enrai-${ACCOUNT_NAME}-login}"
        LOGIN_CUSTOM_DOMAIN="false"
        LOGIN_DOMAIN="https://${LOGIN_PROJECT}.pages.dev"
        LOGIN_PAGES_PROJECT="$LOGIN_PROJECT"
      fi

      if [[ "$ENABLE_ADMIN_PAGE" == "true" ]]; then
        read -p "Admin Page project name [default: enrai-${ACCOUNT_NAME}-admin]: " admin_project
        ADMIN_PROJECT="${admin_project:-enrai-${ACCOUNT_NAME}-admin}"
        ADMIN_CUSTOM_DOMAIN="false"
        ADMIN_DOMAIN="https://${ADMIN_PROJECT}.pages.dev"
        ADMIN_PAGES_PROJECT="$ADMIN_PROJECT"
      fi
    fi
  else
    # Local environment
    USE_CUSTOM_DOMAIN="false"

    if [[ "$ENABLE_API" == "true" ]]; then
      API_CUSTOM_DOMAIN="false"
      API_DOMAIN="http://localhost:8787"
      API_WORKER_NAME="enrai"
    fi

    if [[ "$ENABLE_LOGIN_PAGE" == "true" ]]; then
      LOGIN_CUSTOM_DOMAIN="false"
      LOGIN_DOMAIN="http://localhost:5173"
      LOGIN_PAGES_PROJECT="enrai-login"
    fi

    if [[ "$ENABLE_ADMIN_PAGE" == "true" ]]; then
      ADMIN_CUSTOM_DOMAIN="false"
      ADMIN_DOMAIN="http://localhost:5174"
      ADMIN_PAGES_PROJECT="enrai-admin"
    fi
  fi

  log_success "Domain configuration complete"
  echo ""
}

###############################################################################
# [7] Configure Hosting
###############################################################################

configure_hosting() {
  echo "========================================="
  echo "Hosting Configuration"
  echo "========================================="

  if [[ "$ENABLE_LOGIN_PAGE" == "true" && "$ENVIRONMENT" == "remote" ]]; then
    echo "Select hosting method for Login Page:"
    echo "1) Cloudflare Pages"
    echo "2) External hosting"
    read -p "Select [1-2]: " login_hosting_choice

    case $login_hosting_choice in
      1) LOGIN_HOSTING="cloudflare-pages" ;;
      2) LOGIN_HOSTING="external" ;;
      *) log_error "Invalid selection"; exit 1 ;;
    esac
  else
    LOGIN_HOSTING="cloudflare-pages"
  fi

  if [[ "$ENABLE_ADMIN_PAGE" == "true" && "$ENVIRONMENT" == "remote" ]]; then
    echo "Select hosting method for Admin Page:"
    echo "1) Cloudflare Pages"
    echo "2) External hosting"
    read -p "Select [1-2]: " admin_hosting_choice

    case $admin_hosting_choice in
      1) ADMIN_HOSTING="cloudflare-pages" ;;
      2) ADMIN_HOSTING="external" ;;
      *) log_error "Invalid selection"; exit 1 ;;
    esac
  else
    ADMIN_HOSTING="cloudflare-pages"
  fi

  log_success "Hosting configuration complete"
  echo ""
}

###############################################################################
# [8] Configure Secrets
###############################################################################

configure_secrets() {
  echo "========================================="
  echo "Secret Configuration"
  echo "========================================="

  read -p "Generate secrets (RSA keys)? [Y/n]: " generate_keys
  GENERATE_KEYS=$([[ "$generate_keys" =~ ^[Nn]$ ]] && echo "false" || echo "true")

  log_success "Generate secrets: $GENERATE_KEYS"
  echo ""
}

###############################################################################
# [9] Configure CORS
###############################################################################

configure_cors() {
  echo "========================================="
  echo "CORS Configuration"
  echo "========================================="

  # CORS required for non-Pattern-A or when using workers.dev
  if [[ "$PATTERN" != "pattern-a" ]] || [[ "$USE_CUSTOM_DOMAIN" == "false" && "$ENVIRONMENT" == "remote" ]]; then
    CORS_ENABLED="true"

    log_info "Enter allowed origins (comma-separated)"

    # Suggest default origins
    DEFAULT_ORIGINS=""
    if [[ "$ENABLE_LOGIN_PAGE" == "true" && -n "$LOGIN_DOMAIN" ]]; then
      DEFAULT_ORIGINS="$LOGIN_DOMAIN"
    fi
    if [[ "$ENABLE_ADMIN_PAGE" == "true" && -n "$ADMIN_DOMAIN" ]]; then
      if [[ -n "$DEFAULT_ORIGINS" ]]; then
        DEFAULT_ORIGINS="$DEFAULT_ORIGINS,$ADMIN_DOMAIN"
      else
        DEFAULT_ORIGINS="$ADMIN_DOMAIN"
      fi
    fi
    if [[ "$ENVIRONMENT" == "local" ]]; then
      if [[ -n "$DEFAULT_ORIGINS" ]]; then
        DEFAULT_ORIGINS="$DEFAULT_ORIGINS,http://localhost:5173,http://localhost:5174"
      else
        DEFAULT_ORIGINS="http://localhost:5173,http://localhost:5174"
      fi
    fi

    echo "Example: $DEFAULT_ORIGINS"
    read -p "Origins [$DEFAULT_ORIGINS]: " cors_origins
    CORS_ORIGINS="${cors_origins:-$DEFAULT_ORIGINS}"

    read -p "Add pattern matching (regex)? [y/N]: " add_cors_patterns
    if [[ "$add_cors_patterns" =~ ^[Yy]$ ]]; then
      log_info "Enter regex patterns (comma-separated)"
      echo "Example: ^https://.*\\.example\\.com$"
      read -p "Patterns: " cors_patterns
      CORS_PATTERNS="$cors_patterns"
    else
      CORS_PATTERNS=""
    fi
  else
    CORS_ENABLED="false"
    CORS_ORIGINS=""
    CORS_PATTERNS=""
  fi

  log_success "CORS configuration complete"
  echo ""
}

###############################################################################
# [10] Confirm Settings
###############################################################################

confirm_settings() {
  echo "========================================="
  echo "Configuration Summary"
  echo "========================================="
  echo "Environment: $ENVIRONMENT"
  echo "Operation Mode: $OPERATION_MODE"
  echo "Pattern: $PATTERN"
  echo ""
  echo "Components:"
  echo "  API: $ENABLE_API"
  [[ "$ENABLE_API" == "true" ]] && echo "    Domain: $API_DOMAIN"
  echo "  Login Page: $ENABLE_LOGIN_PAGE"
  [[ "$ENABLE_LOGIN_PAGE" == "true" ]] && echo "    Domain: $LOGIN_DOMAIN"
  [[ "$ENABLE_LOGIN_PAGE" == "true" ]] && echo "    Hosting: $LOGIN_HOSTING"
  echo "  Admin Page: $ENABLE_ADMIN_PAGE"
  [[ "$ENABLE_ADMIN_PAGE" == "true" ]] && echo "    Domain: $ADMIN_DOMAIN"
  [[ "$ENABLE_ADMIN_PAGE" == "true" ]] && echo "    Hosting: $ADMIN_HOSTING"
  echo ""
  echo "Cloudflare Account: $ACCOUNT_NAME"
  echo "Generate Secrets: $GENERATE_KEYS"
  echo "CORS Enabled: $CORS_ENABLED"
  [[ "$CORS_ENABLED" == "true" ]] && echo "  Allowed Origins: $CORS_ORIGINS"
  echo "========================================="
  read -p "Proceed with this configuration? [Y/n]: " confirm
  if [[ "$confirm" =~ ^[Nn]$ ]]; then
    log_warn "Aborted"
    exit 0
  fi

  echo ""
}

###############################################################################
# [11] Generate Configuration File
###############################################################################

generate_config_file() {
  log_info "Generating configuration file..."

  # Determine version
  VERSION="1.0.0"
  if [[ "$OPERATION_MODE" != "new" && -n "$EXISTING_CONFIG" ]]; then
    # Increment minor version
    EXISTING_VERSION=$(jq -r '.version' "$EXISTING_CONFIG")
    IFS='.' read -ra VERSION_PARTS <<< "$EXISTING_VERSION"
    MAJOR="${VERSION_PARTS[0]}"
    MINOR="${VERSION_PARTS[1]}"
    PATCH="${VERSION_PARTS[2]}"
    MINOR=$((MINOR + 1))
    VERSION="$MAJOR.$MINOR.$PATCH"
  fi

  CONFIG_FILE="enrai-config-${VERSION}.json"

  # Generate CORS arrays JSON
  CORS_ORIGINS_JSON="[]"
  if [[ -n "$CORS_ORIGINS" ]]; then
    IFS=',' read -ra ORIGINS_ARRAY <<< "$CORS_ORIGINS"
    CORS_ORIGINS_JSON=$(printf '%s\n' "${ORIGINS_ARRAY[@]}" | jq -R . | jq -s .)
  fi

  CORS_PATTERNS_JSON="[]"
  if [[ -n "$CORS_PATTERNS" ]]; then
    IFS=',' read -ra PATTERNS_ARRAY <<< "$CORS_PATTERNS"
    CORS_PATTERNS_JSON=$(printf '%s\n' "${PATTERNS_ARRAY[@]}" | jq -R . | jq -s .)
  fi

  # Router Worker usage
  USE_ROUTER="true"

  # Generate JSON
  cat > "$CONFIG_FILE" <<EOF
{
  "version": "$VERSION",
  "created_at": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "environment": "$ENVIRONMENT",
  "operation_mode": "$OPERATION_MODE",
  "pattern": "$PATTERN",
  "components": {
    "api": {
      "enabled": $ENABLE_API,
      "custom_domain": ${API_CUSTOM_DOMAIN:-false},
      "domain": "${API_DOMAIN:-}",
      "worker_name": "${API_WORKER_NAME:-}"
    },
    "login_page": {
      "enabled": $ENABLE_LOGIN_PAGE,
      "hosting": "${LOGIN_HOSTING:-cloudflare-pages}",
      "custom_domain": ${LOGIN_CUSTOM_DOMAIN:-false},
      "domain": "${LOGIN_DOMAIN:-}",
      "pages_project_name": "${LOGIN_PAGES_PROJECT:-}"
    },
    "admin_page": {
      "enabled": $ENABLE_ADMIN_PAGE,
      "hosting": "${ADMIN_HOSTING:-cloudflare-pages}",
      "custom_domain": ${ADMIN_CUSTOM_DOMAIN:-false},
      "domain": "${ADMIN_DOMAIN:-}",
      "pages_project_name": "${ADMIN_PAGES_PROJECT:-}"
    }
  },
  "cloudflare": {
    "account_name": "$ACCOUNT_NAME",
    "use_router": $USE_ROUTER
  },
  "secrets": {
    "generate_keys": $GENERATE_KEYS,
    "reuse_existing": false,
    "key_locations": {
      "local": ".keys/",
      "remote_checked": false
    }
  },
  "cors": {
    "enabled": $CORS_ENABLED,
    "allowed_origins": $CORS_ORIGINS_JSON,
    "allowed_patterns": $CORS_PATTERNS_JSON
  },
  "resources": {
    "kv_namespaces": [],
    "durable_objects": [],
    "d1_databases": []
  }
}
EOF

  # Format with jq
  jq . "$CONFIG_FILE" > "$CONFIG_FILE.tmp" && mv "$CONFIG_FILE.tmp" "$CONFIG_FILE"

  log_success "Configuration file generated: $CONFIG_FILE"

  # Add to .gitignore
  if [[ ! -f .gitignore ]] || ! grep -q "enrai-config-\*.json" .gitignore 2>/dev/null; then
    echo "enrai-config-*.json" >> .gitignore
    log_success "Added to .gitignore"
  fi

  echo ""
}

###############################################################################
# [12] Confirm Build
###############################################################################

confirm_build() {
  read -p "Run build script now? [Y/n]: " run_build
  if [[ ! "$run_build" =~ ^[Nn]$ ]]; then
    log_info "Running build script..."
    ./scripts/build.sh --config "$CONFIG_FILE"
  else
    log_info "You can run the build later: ./scripts/build.sh --config $CONFIG_FILE"
  fi
}

###############################################################################
# Main Process
###############################################################################

main() {
  echo ""
  echo "========================================="
  echo "Enrai Configuration File Creation"
  echo "========================================="
  echo ""

  check_prerequisites
  select_environment
  select_operation_mode
  select_pattern
  select_components
  configure_domains
  configure_hosting
  configure_secrets
  configure_cors
  confirm_settings
  generate_config_file
  confirm_build

  echo ""
  log_success "All processes completed!"
}

# Run script
main "$@"
