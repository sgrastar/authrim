#!/bin/bash
#
# Authrim Remote wrangler.toml Generation Script
# Generates wrangler.toml files for remote Cloudflare Workers deployment
#
# Supports two deployment modes:
#   1) Test Environment (workers.dev + Router Worker)
#   2) Production Environment (Custom Domain + Cloudflare Routes)
#
# Usage:
#   ./setup-remote-wrangler.sh --env=dev --domain=https://dev-auth.example.com
#   ./setup-remote-wrangler.sh --env=prod --domain=https://auth.example.com --mode=production
#

set -e

# Color codes
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
MAGENTA='\033[0;35m'
NC='\033[0m'

# Parse command line arguments first
DEPLOY_ENV=""
ISSUER_URL=""
DEPLOYMENT_MODE=""
SUBDOMAIN=""

for arg in "$@"; do
    if [[ $arg == --env=* ]]; then
        DEPLOY_ENV="${arg#--env=}"
    elif [[ $arg == --domain=* ]]; then
        ISSUER_URL="${arg#--domain=}"
    elif [[ $arg == --issuer-url=* ]]; then
        ISSUER_URL="${arg#--issuer-url=}"
    elif [[ $arg == --mode=* ]]; then
        DEPLOYMENT_MODE="${arg#--mode=}"
    elif [[ $arg == --subdomain=* ]]; then
        SUBDOMAIN="${arg#--subdomain=}"
    fi
done

# Validate required parameters
if [ -z "$DEPLOY_ENV" ]; then
    echo -e "${RED}❌ Error: --env parameter is required${NC}"
    echo ""
    echo "Usage: $0 --env=<environment> --domain=<issuer-url> [--mode=test|production]"
    echo ""
    echo "Examples:"
    echo "  $0 --env=dev --domain=https://dev-auth.example.com"
    echo "  $0 --env=staging --domain=https://staging-auth.example.com"
    echo "  $0 --env=prod --domain=https://auth.example.com --mode=production"
    exit 1
fi

echo -e "${MAGENTA}🔨 Authrim Remote wrangler.toml Generation - Environment: $DEPLOY_ENV${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Check if keys exist to get KEY_ID
if [ ! -f ".keys/metadata.json" ]; then
    echo -e "${RED}❌ Error: Key metadata not found${NC}"
    echo ""
    echo "Please run setup-keys.sh first:"
    echo "  ./scripts/setup-keys.sh"
    echo ""
    exit 1
fi

KEY_ID=$(cat .keys/metadata.json | jq -r '.kid' 2>/dev/null || echo "")
if [ -z "$KEY_ID" ]; then
    echo -e "${RED}❌ Error: Could not extract KEY_ID from metadata${NC}"
    exit 1
fi

echo "📦 Key Information:"
echo "   Key ID: $KEY_ID"
echo ""

# Prompt for KEY_MANAGER_SECRET (used for DO auth and token signing)
EXISTING_KEY_MANAGER_SECRET=${KEY_MANAGER_SECRET:-}
echo "🔐 Key Manager Authentication"
echo "   This secret secures requests between workers and the KeyManager Durable Object."
if [ -n "$EXISTING_KEY_MANAGER_SECRET" ]; then
    echo "   Existing KEY_MANAGER_SECRET detected (from env). Press Enter to reuse or type a new value."
else
    echo "   No KEY_MANAGER_SECRET configured. Enter a strong secret or leave blank to use the"
    echo "   default 'production-secret-change-me' (development only)."
fi
read -s -p "KEY_MANAGER_SECRET: " KEY_MANAGER_SECRET_INPUT
echo ""

if [ -n "$KEY_MANAGER_SECRET_INPUT" ]; then
    KEY_MANAGER_SECRET="$KEY_MANAGER_SECRET_INPUT"
elif [ -n "$EXISTING_KEY_MANAGER_SECRET" ]; then
    KEY_MANAGER_SECRET="$EXISTING_KEY_MANAGER_SECRET"
else
    KEY_MANAGER_SECRET="production-secret-change-me"
fi

echo ""


# Prompt for deployment mode if not provided via CLI
if [ -z "$DEPLOYMENT_MODE" ]; then
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "📝 Deployment Mode Configuration"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo "Choose how you want to deploy Authrim:"
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  1) Test Environment (workers.dev + Router Worker)"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "     • Single unified endpoint via Router Worker"
    echo "     • Uses Service Bindings for internal routing"
    echo "     • Best for: Development, testing, quick setup"
    echo "     • OpenID Connect compliant ✅"
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  2) Production Environment (Custom Domain + Routes)"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "     • Direct routing via Cloudflare Routes"
    echo "     • Optimal performance (no extra router hop)"
    echo "     • Best for: Production deployments"
    echo "     • Requires: Cloudflare-managed domain"
    echo ""
    read -p "Enter your choice (1/2): " -r DEPLOYMENT_CHOICE
    echo ""

    case $DEPLOYMENT_CHOICE in
        1)
            DEPLOYMENT_MODE="test"
            ;;
        2)
            DEPLOYMENT_MODE="production"
            ;;
        *)
            echo -e "${RED}❌ Invalid choice. Exiting.${NC}"
            exit 1
            ;;
    esac
fi

# Validate deployment mode
if [ "$DEPLOYMENT_MODE" != "test" ] && [ "$DEPLOYMENT_MODE" != "production" ]; then
    echo -e "${RED}❌ Error: Invalid deployment mode '$DEPLOYMENT_MODE'${NC}"
    echo "   Valid options: test, production"
    exit 1
fi

# For test environment, detect or prompt for workers.dev subdomain
if [ "$DEPLOYMENT_MODE" = "test" ] && [ -z "$SUBDOMAIN" ]; then
    echo "🔍 Detecting workers.dev subdomain..."

    # Try to detect subdomain from wrangler whoami
    if command -v wrangler &> /dev/null; then
        SUBDOMAIN=$(wrangler whoami 2>&1 | grep -o '[a-zA-Z0-9_-]*@[a-zA-Z0-9_-]*' | cut -d'@' -f2 || true)
    fi

    if [ -z "$SUBDOMAIN" ]; then
        echo "⚠️  Could not automatically detect your workers.dev subdomain"
        echo ""
        echo "Please enter your workers.dev subdomain:"
        echo "  (This is from your Cloudflare account)"
        echo "  Example: If your workers are at 'authrim-op-discovery.sgrastar.workers.dev',"
        echo "           enter 'sgrastar'"
        echo ""
        read -p "Your subdomain: " SUBDOMAIN

        if [ -z "$SUBDOMAIN" ]; then
            echo -e "${RED}❌ Error: Subdomain cannot be empty${NC}"
            exit 1
        fi
    fi

    echo -e "${GREEN}✅ Using subdomain: $SUBDOMAIN.workers.dev${NC}"
    echo ""
fi

# Prompt for ISSUER_URL if not provided
if [ -z "$ISSUER_URL" ]; then
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "🌍 Configure ISSUER_URL"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""

    if [ "$DEPLOYMENT_MODE" = "test" ]; then
        ISSUER_URL="https://authrim.$SUBDOMAIN.workers.dev"
        echo "Test Environment ISSUER_URL (via Router Worker):"
        echo "  $ISSUER_URL"
        echo ""
        read -p "Confirm? (Y/n): " -n 1 -r
        echo
        if [[ $REPLY =~ ^[Nn]$ ]]; then
            read -p "Enter custom ISSUER_URL: " ISSUER_URL
        fi
    else
        echo "Enter your custom domain for Production Environment:"
        echo "  Example: https://id.yourdomain.com"
        echo ""
        read -p "ISSUER_URL: " ISSUER_URL
    fi

    if [ -z "$ISSUER_URL" ]; then
        echo -e "${RED}❌ Error: ISSUER_URL cannot be empty${NC}"
        exit 1
    fi
fi

# Remove trailing slash if present
ISSUER_URL=${ISSUER_URL%/}

echo ""
echo -e "${GREEN}✅ ISSUER_URL: $ISSUER_URL${NC}"
echo ""

# Optional: Prompt for UI_BASE_URL (for Device Flow)
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📱 UI Base URL (Optional, for Device Flow)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "Enter the base URL for your SvelteKit UI (Cloudflare Pages):"
echo "  Examples:"
echo "    • https://authrim-login.pages.dev (Cloudflare Pages)"
echo "    • https://login.yourdomain.com (custom domain)"
echo ""
read -p "UI_BASE_URL [https://authrim-login.pages.dev]: " UI_BASE_URL_INPUT
UI_BASE_URL=${UI_BASE_URL_INPUT:-https://authrim-login.pages.dev}
UI_BASE_URL=${UI_BASE_URL%/}

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅ Configuration Summary"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "Deployment Mode: $([ "$DEPLOYMENT_MODE" = "test" ] && echo "Test (Router Worker)" || echo "Production (Cloudflare Routes)")"
echo "ISSUER_URL: $ISSUER_URL"
echo "UI_BASE_URL: $UI_BASE_URL"
echo ""

# For production mode, extract domain and zone info
if [ "$DEPLOYMENT_MODE" = "production" ]; then
    DOMAIN_ONLY=$(echo "$ISSUER_URL" | sed 's|https://||' | sed 's|/.*||')
    ZONE_NAME=$(echo "$DOMAIN_ONLY" | awk -F. '{print $(NF-1)"."$NF}')
    echo "Domain: $DOMAIN_ONLY"
    echo "Zone: $ZONE_NAME"
    echo ""
fi

read -p "Continue with this configuration? (y/N): " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo -e "${BLUE}❌ Configuration cancelled${NC}"
    exit 0
fi

echo ""
echo "📝 Generating wrangler.toml files..."
echo ""

# Function to generate base wrangler.toml file
generate_base_wrangler() {
    local package=$1
    local kv_namespaces=$2
    local d1_databases=$3
    local r2_buckets=$4
    local do_bindings=$5

    local file="packages/$package/wrangler.${DEPLOY_ENV}.toml"

    cat > "$file" << TOML_EOF
name = "${DEPLOY_ENV}-authrim-$package"
main = "src/index.ts"
compatibility_date = "2024-09-23"
compatibility_flags = ["nodejs_compat"]
workers_dev = false

# KV Namespaces
$kv_namespaces
# D1 Databases
$d1_databases
# R2 Buckets
$r2_buckets
# Durable Objects Bindings
$do_bindings

# Environment variables
[vars]
ISSUER_URL = "$ISSUER_URL"
UI_BASE_URL = "$UI_BASE_URL"
TOKEN_EXPIRY = "3600"
CODE_EXPIRY = "120"
STATE_EXPIRY = "300"
NONCE_EXPIRY = "300"
REFRESH_TOKEN_EXPIRY = "2592000"
KEY_ID = "$KEY_ID"
ALLOW_HTTP_REDIRECT = "false"
OPEN_REGISTRATION = "false"
TRUSTED_DOMAINS = "www.certification.openid.net"
KEY_MANAGER_SECRET = "$KEY_MANAGER_SECRET"
ADMIN_API_SECRET = "$KEY_MANAGER_SECRET"
# Version management (set by deploy script via --var)
CODE_VERSION_UUID = ""
DEPLOY_TIME_UTC = ""
TOML_EOF
}

# Function to update wrangler.toml with ISSUER_URL
update_issuer_url() {
    local file=$1
    local package_name=$(basename $(dirname "$file"))

    # Use sed to update ISSUER_URL
    if [[ "$OSTYPE" == "darwin"* ]]; then
        sed -i '' "s|ISSUER_URL = \".*\"|ISSUER_URL = \"$ISSUER_URL\"|" "$file"
        sed -i '' "s|UI_BASE_URL = \".*\"|UI_BASE_URL = \"$UI_BASE_URL\"|" "$file"
    else
        sed -i "s|ISSUER_URL = \".*\"|ISSUER_URL = \"$ISSUER_URL\"|" "$file"
        sed -i "s|UI_BASE_URL = \".*\"|UI_BASE_URL = \"$UI_BASE_URL\"|" "$file"
    fi
}

# Function to update workers_dev setting
update_workers_dev() {
    local file=$1
    local value=$2
    local ostype=$3

    # Remove existing workers_dev line
    if [[ "$ostype" == "darwin"* ]]; then
        sed -i '' '/^workers_dev = /d' "$file"
    else
        sed -i '/^workers_dev = /d' "$file"
    fi

    # Add new workers_dev line after compatibility_flags
    if [[ "$ostype" == "darwin"* ]]; then
        sed -i '' "/^compatibility_flags = /a\\
workers_dev = $value
" "$file"
    else
        sed -i "/^compatibility_flags = /a\\workers_dev = $value" "$file"
    fi
}

# Function to add Cloudflare Routes (production mode)
add_routes_to_worker() {
    local file=$1
    local package_name=$(basename $(dirname "$file"))
    local routes=""

    case $package_name in
        op-discovery)
            routes="
[[routes]]
pattern = \"$DOMAIN_ONLY/.well-known/*\"
zone_name = \"$ZONE_NAME\""
            ;;
        op-auth)
            routes="
[[routes]]
pattern = \"$DOMAIN_ONLY/authorize*\"
zone_name = \"$ZONE_NAME\"

[[routes]]
pattern = \"$DOMAIN_ONLY/as/*\"
zone_name = \"$ZONE_NAME\"

[[routes]]
pattern = \"$DOMAIN_ONLY/api/auth/*\"
zone_name = \"$ZONE_NAME\"

[[routes]]
pattern = \"$DOMAIN_ONLY/api/sessions/*\"
zone_name = \"$ZONE_NAME\"

[[routes]]
pattern = \"$DOMAIN_ONLY/logout*\"
zone_name = \"$ZONE_NAME\""
            ;;
        op-token)
            routes="
[[routes]]
pattern = \"$DOMAIN_ONLY/token*\"
zone_name = \"$ZONE_NAME\""
            ;;
        op-userinfo)
            routes="
[[routes]]
pattern = \"$DOMAIN_ONLY/userinfo*\"
zone_name = \"$ZONE_NAME\""
            ;;
        op-management)
            routes="
[[routes]]
pattern = \"$DOMAIN_ONLY/register*\"
zone_name = \"$ZONE_NAME\"

[[routes]]
pattern = \"$DOMAIN_ONLY/introspect*\"
zone_name = \"$ZONE_NAME\"

[[routes]]
pattern = \"$DOMAIN_ONLY/revoke*\"
zone_name = \"$ZONE_NAME\"

[[routes]]
pattern = \"$DOMAIN_ONLY/api/admin/*\"
zone_name = \"$ZONE_NAME\""
            ;;
        op-async)
            routes="
[[routes]]
pattern = \"$DOMAIN_ONLY/device_authorization*\"
zone_name = \"$ZONE_NAME\"

[[routes]]
pattern = \"$DOMAIN_ONLY/device*\"
zone_name = \"$ZONE_NAME\"

[[routes]]
pattern = \"$DOMAIN_ONLY/bc-authorize*\"
zone_name = \"$ZONE_NAME\"

[[routes]]
pattern = \"$DOMAIN_ONLY/api/device/*\"
zone_name = \"$ZONE_NAME\"

[[routes]]
pattern = \"$DOMAIN_ONLY/api/ciba/*\"
zone_name = \"$ZONE_NAME\"

[[routes]]
pattern = \"$DOMAIN_ONLY/ciba/*\"
zone_name = \"$ZONE_NAME\""
            ;;
        policy-service)
            routes="
[[routes]]
pattern = \"$DOMAIN_ONLY/policy/*\"
zone_name = \"$ZONE_NAME\"

[[routes]]
pattern = \"$DOMAIN_ONLY/api/rebac/*\"
zone_name = \"$ZONE_NAME\""
            ;;
    esac

    if [ -n "$routes" ]; then
        # Remove existing routes
        if [[ "$OSTYPE" == "darwin"* ]]; then
            sed -i '' '/^\[\[routes\]\]/,/^zone_name = /d' "$file"
        else
            sed -i '/^\[\[routes\]\]/,/^zone_name = /d' "$file"
        fi

        # Append new routes
        echo "$routes" >> "$file"
    fi
}

# Generate shared worker wrangler file
if [ ! -f "packages/shared/wrangler.${DEPLOY_ENV}.toml" ]; then
    echo "  • Generating shared/wrangler.${DEPLOY_ENV}.toml (Durable Objects)..."
    cat > "packages/shared/wrangler.${DEPLOY_ENV}.toml" << EOF
name = "${DEPLOY_ENV}-authrim-shared"
main = "src/durable-objects/index.ts"
compatibility_date = "2024-09-23"
compatibility_flags = ["nodejs_compat"]

# Durable Objects definitions
[[durable_objects.bindings]]
name = "SESSION_STORE"
class_name = "SessionStore"

[[durable_objects.bindings]]
name = "AUTH_CODE_STORE"
class_name = "AuthorizationCodeStore"

[[durable_objects.bindings]]
name = "REFRESH_TOKEN_ROTATOR"
class_name = "RefreshTokenRotator"

[[durable_objects.bindings]]
name = "KEY_MANAGER"
class_name = "KeyManager"

[[durable_objects.bindings]]
name = "CHALLENGE_STORE"
class_name = "ChallengeStore"

[[durable_objects.bindings]]
name = "RATE_LIMITER"
class_name = "RateLimiterCounter"

[[durable_objects.bindings]]
name = "PAR_REQUEST_STORE"
class_name = "PARRequestStore"

[[durable_objects.bindings]]
name = "DPOP_JTI_STORE"
class_name = "DPoPJTIStore"

[[durable_objects.bindings]]
name = "DEVICE_CODE_STORE"
class_name = "DeviceCodeStore"

[[durable_objects.bindings]]
name = "CIBA_REQUEST_STORE"
class_name = "CIBARequestStore"

[[durable_objects.bindings]]
name = "TOKEN_REVOCATION_STORE"
class_name = "TokenRevocationStore"

[[durable_objects.bindings]]
name = "VERSION_MANAGER"
class_name = "VersionManager"

# Durable Objects migrations
[[migrations]]
tag = "v1"
new_sqlite_classes = [
  "SessionStore",
  "AuthorizationCodeStore",
  "RefreshTokenRotator",
  "KeyManager",
  "ChallengeStore",
  "RateLimiterCounter",
  "PARRequestStore",
  "DPoPJTIStore"
]

[[migrations]]
tag = "v2"
# Empty migration to match production state
# Keeps existing Durable Objects intact

[[migrations]]
tag = "v3"
new_sqlite_classes = [
  "DeviceCodeStore",
  "CIBARequestStore"
]

[[migrations]]
tag = "v4"
new_sqlite_classes = [
  "TokenRevocationStore"
]

[[migrations]]
tag = "v5"
new_sqlite_classes = [
  "VersionManager"
]

# Environment variables
[vars]
KEY_MANAGER_SECRET = "$KEY_MANAGER_SECRET"
ADMIN_API_SECRET = "$KEY_MANAGER_SECRET"
EOF
fi

# Generate op-discovery wrangler file
if [ ! -f "packages/op-discovery/wrangler.${DEPLOY_ENV}.toml" ]; then
    echo "  • Generating op-discovery/wrangler.${DEPLOY_ENV}.toml..."
    generate_base_wrangler "op-discovery" "" "" "" "[[durable_objects.bindings]]
name = \"KEY_MANAGER\"
class_name = \"KeyManager\"
script_name = \"${DEPLOY_ENV}-authrim-shared\"

[[durable_objects.bindings]]
name = \"RATE_LIMITER\"
class_name = \"RateLimiterCounter\"
script_name = \"${DEPLOY_ENV}-authrim-shared\"

[[durable_objects.bindings]]
name = \"VERSION_MANAGER\"
class_name = \"VersionManager\"
script_name = \"${DEPLOY_ENV}-authrim-shared\""
fi

# Generate op-auth wrangler file
if [ ! -f "packages/op-auth/wrangler.${DEPLOY_ENV}.toml" ]; then
    echo "  • Generating op-auth/wrangler.${DEPLOY_ENV}.toml..."
    generate_base_wrangler "op-auth" "[[kv_namespaces]]
binding = \"CLIENTS\"
id = \"placeholder\"

" "[[d1_databases]]
binding = \"DB\"
database_name = \"${DEPLOY_ENV}-authrim-users-db\"
database_id = \"placeholder\"

" "[[r2_buckets]]
binding = \"AVATARS\"
bucket_name = \"${DEPLOY_ENV}-authrim-avatars\"

" "[[durable_objects.bindings]]
name = \"KEY_MANAGER\"
class_name = \"KeyManager\"
script_name = \"${DEPLOY_ENV}-authrim-shared\"

[[durable_objects.bindings]]
name = \"SESSION_STORE\"
class_name = \"SessionStore\"
script_name = \"${DEPLOY_ENV}-authrim-shared\"

[[durable_objects.bindings]]
name = \"AUTH_CODE_STORE\"
class_name = \"AuthorizationCodeStore\"
script_name = \"${DEPLOY_ENV}-authrim-shared\"

[[durable_objects.bindings]]
name = \"CHALLENGE_STORE\"
class_name = \"ChallengeStore\"
script_name = \"${DEPLOY_ENV}-authrim-shared\"

[[durable_objects.bindings]]
name = \"RATE_LIMITER\"
class_name = \"RateLimiterCounter\"
script_name = \"${DEPLOY_ENV}-authrim-shared\"

[[durable_objects.bindings]]
name = \"PAR_REQUEST_STORE\"
class_name = \"PARRequestStore\"
script_name = \"${DEPLOY_ENV}-authrim-shared\"

[[durable_objects.bindings]]
name = \"VERSION_MANAGER\"
class_name = \"VersionManager\"
script_name = \"${DEPLOY_ENV}-authrim-shared\""
fi

# Generate op-token wrangler file
if [ ! -f "packages/op-token/wrangler.${DEPLOY_ENV}.toml" ]; then
    echo "  • Generating op-token/wrangler.${DEPLOY_ENV}.toml..."
    generate_base_wrangler "op-token" "[[kv_namespaces]]
binding = \"CLIENTS\"
id = \"placeholder\"

" "" "" "[[durable_objects.bindings]]
name = \"KEY_MANAGER\"
class_name = \"KeyManager\"
script_name = \"${DEPLOY_ENV}-authrim-shared\"

[[durable_objects.bindings]]
name = \"SESSION_STORE\"
class_name = \"SessionStore\"
script_name = \"${DEPLOY_ENV}-authrim-shared\"

[[durable_objects.bindings]]
name = \"AUTH_CODE_STORE\"
class_name = \"AuthorizationCodeStore\"
script_name = \"${DEPLOY_ENV}-authrim-shared\"

[[durable_objects.bindings]]
name = \"REFRESH_TOKEN_ROTATOR\"
class_name = \"RefreshTokenRotator\"
script_name = \"${DEPLOY_ENV}-authrim-shared\"

[[durable_objects.bindings]]
name = \"RATE_LIMITER\"
class_name = \"RateLimiterCounter\"
script_name = \"${DEPLOY_ENV}-authrim-shared\"

[[durable_objects.bindings]]
name = \"DPOP_JTI_STORE\"
class_name = \"DPoPJTIStore\"
script_name = \"${DEPLOY_ENV}-authrim-shared\"

[[durable_objects.bindings]]
name = \"TOKEN_REVOCATION_STORE\"
class_name = \"TokenRevocationStore\"
script_name = \"${DEPLOY_ENV}-authrim-shared\"

[[durable_objects.bindings]]
name = \"VERSION_MANAGER\"
class_name = \"VersionManager\"
script_name = \"${DEPLOY_ENV}-authrim-shared\""
fi

# Generate op-userinfo wrangler file
if [ ! -f "packages/op-userinfo/wrangler.${DEPLOY_ENV}.toml" ]; then
    echo "  • Generating op-userinfo/wrangler.${DEPLOY_ENV}.toml..."
    generate_base_wrangler "op-userinfo" "[[kv_namespaces]]
binding = \"CLIENTS\"
id = \"placeholder\"

" "[[d1_databases]]
binding = \"DB\"
database_name = \"${DEPLOY_ENV}-authrim-users-db\"
database_id = \"placeholder\"

" "" "[[durable_objects.bindings]]
name = \"KEY_MANAGER\"
class_name = \"KeyManager\"
script_name = \"${DEPLOY_ENV}-authrim-shared\"

[[durable_objects.bindings]]
name = \"SESSION_STORE\"
class_name = \"SessionStore\"
script_name = \"${DEPLOY_ENV}-authrim-shared\"

[[durable_objects.bindings]]
name = \"RATE_LIMITER\"
class_name = \"RateLimiterCounter\"
script_name = \"${DEPLOY_ENV}-authrim-shared\"

[[durable_objects.bindings]]
name = \"DPOP_JTI_STORE\"
class_name = \"DPoPJTIStore\"
script_name = \"${DEPLOY_ENV}-authrim-shared\"

[[durable_objects.bindings]]
name = \"TOKEN_REVOCATION_STORE\"
class_name = \"TokenRevocationStore\"
script_name = \"${DEPLOY_ENV}-authrim-shared\"

[[durable_objects.bindings]]
name = \"VERSION_MANAGER\"
class_name = \"VersionManager\"
script_name = \"${DEPLOY_ENV}-authrim-shared\""
fi

# Generate op-async wrangler file
if [ ! -f "packages/op-async/wrangler.${DEPLOY_ENV}.toml" ]; then
    echo "  • Generating op-async/wrangler.${DEPLOY_ENV}.toml..."
    generate_base_wrangler "op-async" "" "[[d1_databases]]
binding = \"DB\"
database_name = \"${DEPLOY_ENV}-authrim-users-db\"
database_id = \"placeholder\"

" "" "[[durable_objects.bindings]]
name = \"DEVICE_CODE_STORE\"
class_name = \"DeviceCodeStore\"
script_name = \"${DEPLOY_ENV}-authrim-shared\"

[[durable_objects.bindings]]
name = \"CIBA_REQUEST_STORE\"
class_name = \"CIBARequestStore\"
script_name = \"${DEPLOY_ENV}-authrim-shared\"

[[durable_objects.bindings]]
name = \"USER_CODE_RATE_LIMITER\"
class_name = \"RateLimiterCounter\"
script_name = \"${DEPLOY_ENV}-authrim-shared\"

[[durable_objects.bindings]]
name = \"VERSION_MANAGER\"
class_name = \"VersionManager\"
script_name = \"${DEPLOY_ENV}-authrim-shared\""
fi

# Generate op-management wrangler file
if [ ! -f "packages/op-management/wrangler.${DEPLOY_ENV}.toml" ]; then
    echo "  • Generating op-management/wrangler.${DEPLOY_ENV}.toml..."
    generate_base_wrangler "op-management" "[[kv_namespaces]]
binding = \"CLIENTS\"
id = \"placeholder\"

[[kv_namespaces]]
binding = \"INITIAL_ACCESS_TOKENS\"
id = \"placeholder\"

[[kv_namespaces]]
binding = \"SETTINGS\"
id = \"placeholder\"

" "[[d1_databases]]
binding = \"DB\"
database_name = \"${DEPLOY_ENV}-authrim-users-db\"
database_id = \"placeholder\"

" "" "[[durable_objects.bindings]]
name = \"KEY_MANAGER\"
class_name = \"KeyManager\"
script_name = \"${DEPLOY_ENV}-authrim-shared\"

[[durable_objects.bindings]]
name = \"REFRESH_TOKEN_ROTATOR\"
class_name = \"RefreshTokenRotator\"
script_name = \"${DEPLOY_ENV}-authrim-shared\"

[[durable_objects.bindings]]
name = \"RATE_LIMITER\"
class_name = \"RateLimiterCounter\"
script_name = \"${DEPLOY_ENV}-authrim-shared\"

[[durable_objects.bindings]]
name = \"SESSION_STORE\"
class_name = \"SessionStore\"
script_name = \"${DEPLOY_ENV}-authrim-shared\"

[[durable_objects.bindings]]
name = \"TOKEN_REVOCATION_STORE\"
class_name = \"TokenRevocationStore\"
script_name = \"${DEPLOY_ENV}-authrim-shared\"

[[durable_objects.bindings]]
name = \"VERSION_MANAGER\"
class_name = \"VersionManager\"
script_name = \"${DEPLOY_ENV}-authrim-shared\""
fi

# Generate policy-service wrangler file (ReBAC)
if [ ! -f "packages/policy-service/wrangler.${DEPLOY_ENV}.toml" ]; then
    echo "  • Generating policy-service/wrangler.${DEPLOY_ENV}.toml..."
    generate_base_wrangler "policy-service" "[[kv_namespaces]]
binding = \"REBAC_CACHE\"
id = \"placeholder\"

" "[[d1_databases]]
binding = \"DB\"
database_name = \"${DEPLOY_ENV}-authrim-users-db\"
database_id = \"placeholder\"

" "" "[[durable_objects.bindings]]
name = \"VERSION_MANAGER\"
class_name = \"VersionManager\"
script_name = \"${DEPLOY_ENV}-authrim-shared\""
fi

# Update all wrangler.${DEPLOY_ENV}.toml files
for pkg_dir in packages/*/; do
    pkg_name=$(basename "$pkg_dir")
    toml_file="packages/${pkg_name}/wrangler.${DEPLOY_ENV}.toml"
    [ ! -f "$toml_file" ] && continue
    if [ -f "$toml_file" ]; then
        package_name=$(basename $(dirname "$toml_file"))

        # Skip router in production mode
        if [ "$DEPLOYMENT_MODE" = "production" ] && [ "$package_name" = "router" ]; then
            echo "  ⊗ Skipping router (not needed in production mode)"
            continue
        fi

        echo "  • Updating $package_name..."

        # Update ISSUER_URL and UI_BASE_URL
        update_issuer_url "$toml_file"

        # Update workers_dev based on deployment mode
        if [ "$DEPLOYMENT_MODE" = "test" ]; then
            # Test mode: only router is public
            if [ "$package_name" = "router" ]; then
                update_workers_dev "$toml_file" "true" "$OSTYPE"
            else
                update_workers_dev "$toml_file" "false" "$OSTYPE"
            fi
        else
            # Production mode: all workers use false (Routes)
            update_workers_dev "$toml_file" "false" "$OSTYPE"
        fi

        # Add Cloudflare Routes for production mode
        if [ "$DEPLOYMENT_MODE" = "production" ] && [ "$package_name" != "router" ]; then
            add_routes_to_worker "$toml_file"
        fi
    fi
done

# Handle router wrangler.toml
if [ "$DEPLOYMENT_MODE" = "test" ]; then
    # Test mode: generate router wrangler.${DEPLOY_ENV}.toml with Service Bindings
    if [ ! -f "packages/router/wrangler.${DEPLOY_ENV}.toml" ]; then
        echo "  • Generating router (with Service Bindings)..."
        cat > "packages/router/wrangler.${DEPLOY_ENV}.toml" << EOF
name = "${DEPLOY_ENV}-authrim-router"
main = "src/index.ts"
compatibility_date = "2024-09-23"
compatibility_flags = ["nodejs_compat"]
workers_dev = true

# Service Bindings to backend workers
[[services]]
binding = "OP_DISCOVERY"
service = "${DEPLOY_ENV}-authrim-op-discovery"

[[services]]
binding = "OP_AUTH"
service = "${DEPLOY_ENV}-authrim-op-auth"

[[services]]
binding = "OP_TOKEN"
service = "${DEPLOY_ENV}-authrim-op-token"

[[services]]
binding = "OP_USERINFO"
service = "${DEPLOY_ENV}-authrim-op-userinfo"

[[services]]
binding = "OP_MANAGEMENT"
service = "${DEPLOY_ENV}-authrim-op-management"

[vars]
KEY_ID = "{{KEY_ID}}"
ALLOW_HTTP_REDIRECT = "false"
EOF

        # Replace placeholder with actual KEY_ID
        if [[ "$OSTYPE" == "darwin"* ]]; then
            sed -i '' "s|{{KEY_ID}}|$KEY_ID|" "packages/router/wrangler.toml"
        else
            sed -i "s|{{KEY_ID}}|$KEY_ID|" "packages/router/wrangler.toml"
        fi
    fi
else
    # Production mode: remove router wrangler.toml if it exists
    if [ -f "packages/router/wrangler.toml" ]; then
        echo "  • Removing router/wrangler.toml (not needed in production mode)"
        rm packages/router/wrangler.toml
    fi
fi

echo ""
echo -e "${GREEN}✅ All wrangler.toml files generated!${NC}"
echo ""

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${BLUE}🎉 Remote wrangler.toml Setup Complete!${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

if [ "$DEPLOYMENT_MODE" = "test" ]; then
    echo "📌 Test Environment Configuration:"
    echo ""
    echo "  ✅ Router Worker enabled with Service Bindings"
    echo "  🌐 Unified endpoint: $ISSUER_URL"
    echo "  🔒 Backend workers are NOT publicly accessible"
    echo ""
    echo "  Next steps:"
    echo "    1. pnpm run build"
    echo "    2. pnpm run deploy -- --env=$DEPLOY_ENV"
    echo ""
else
    echo "📌 Production Environment Configuration:"
    echo ""
    echo "  ✅ Cloudflare Routes configured"
    echo "  🌐 Custom domain: $ISSUER_URL"
    echo "  🏗️  Zone: $ZONE_NAME"
    echo ""
    echo "  ⚠️  IMPORTANT: Post-Deployment Steps Required!"
    echo ""
    echo "  After 'pnpm run deploy -- --env=$DEPLOY_ENV', verify:"
    echo "    1. Domain ($ZONE_NAME) is managed by Cloudflare"
    echo "    2. DNS is properly configured"
    echo "    3. Routes are automatically applied"
    echo ""
    echo "  Next steps:"
    echo "    1. pnpm run build"
    echo "    2. pnpm run deploy -- --env=$DEPLOY_ENV"
    echo ""
fi

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
