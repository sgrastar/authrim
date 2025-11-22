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
#   ./setup-remote-wrangler.sh
#   ./setup-remote-wrangler.sh --mode=test|production
#   ./setup-remote-wrangler.sh --issuer-url=https://...
#

set -e

# Color codes
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
MAGENTA='\033[0;35m'
NC='\033[0m'

echo -e "${MAGENTA}🔨 Authrim Remote wrangler.toml Generation${NC}"
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

# Parse command line arguments
ISSUER_URL=""
DEPLOYMENT_MODE=""
SUBDOMAIN=""

for arg in "$@"; do
    if [[ $arg == --issuer-url=* ]]; then
        ISSUER_URL="${arg#--issuer-url=}"
    fi
    if [[ $arg == --mode=* ]]; then
        DEPLOYMENT_MODE="${arg#--mode=}"
    fi
    if [[ $arg == --subdomain=* ]]; then
        SUBDOMAIN="${arg#--subdomain=}"
    fi
done

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
pattern = \"$DOMAIN_ONLY/authorize\"
zone_name = \"$ZONE_NAME\"

[[routes]]
pattern = \"$DOMAIN_ONLY/as/*\"
zone_name = \"$ZONE_NAME\""
            ;;
        op-token)
            routes="
[[routes]]
pattern = \"$DOMAIN_ONLY/token\"
zone_name = \"$ZONE_NAME\""
            ;;
        op-userinfo)
            routes="
[[routes]]
pattern = \"$DOMAIN_ONLY/userinfo\"
zone_name = \"$ZONE_NAME\""
            ;;
        op-management)
            routes="
[[routes]]
pattern = \"$DOMAIN_ONLY/register\"
zone_name = \"$ZONE_NAME\"

[[routes]]
pattern = \"$DOMAIN_ONLY/introspect\"
zone_name = \"$ZONE_NAME\"

[[routes]]
pattern = \"$DOMAIN_ONLY/revoke\"
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

# Update all wrangler.toml files
for toml_file in packages/*/wrangler.toml; do
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
    # Test mode: generate router wrangler.toml with Service Bindings
    if [ ! -f "packages/router/wrangler.toml" ]; then
        echo "  • Generating router (with Service Bindings)..."
        cat > packages/router/wrangler.toml << 'EOF'
name = "authrim-router"
main = "src/index.ts"
compatibility_date = "2024-09-23"
compatibility_flags = ["nodejs_compat"]
workers_dev = true

# Service Bindings to backend workers
[[services]]
binding = "OP_DISCOVERY"
service = "authrim-op-discovery"

[[services]]
binding = "OP_AUTH"
service = "authrim-op-auth"

[[services]]
binding = "OP_TOKEN"
service = "authrim-op-token"

[[services]]
binding = "OP_USERINFO"
service = "authrim-op-userinfo"

[[services]]
binding = "OP_MANAGEMENT"
service = "authrim-op-management"

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
    echo "    2. pnpm run deploy"
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
    echo "  After 'pnpm run deploy', verify:"
    echo "    1. Domain ($ZONE_NAME) is managed by Cloudflare"
    echo "    2. DNS is properly configured"
    echo "    3. Routes are automatically applied"
    echo ""
    echo "  Next steps:"
    echo "    1. pnpm run build"
    echo "    2. pnpm run deploy"
    echo ""
fi

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
