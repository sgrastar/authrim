#!/bin/bash
#
# Enrai Production Configuration Script
# This script updates wrangler.toml files with production URLs
#

set -e

echo "🌍 Enrai Production Configuration"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Check if wrangler is installed
if ! command -v wrangler &> /dev/null; then
    echo "❌ Error: wrangler is not installed"
    echo "Please install it with: pnpm install -g wrangler"
    exit 1
fi

# Check if user is logged in
echo "🔍 Checking Cloudflare authentication..."
echo ""

WHOAMI_OUTPUT=$(wrangler whoami 2>&1)

if ! echo "$WHOAMI_OUTPUT" | grep -q "You are logged in"; then
    echo "❌ Error: Not logged in to Cloudflare"
    echo "Please run: wrangler login"
    exit 1
fi

echo "✅ Logged in to Cloudflare"
echo ""

# Try to detect subdomain from existing deployments
echo "🔍 Attempting to detect your workers.dev subdomain..."
SUBDOMAIN=""

# Check for existing worker deployments
DEPLOYMENTS_OUTPUT=$(wrangler deployments list 2>&1 || true)
if echo "$DEPLOYMENTS_OUTPUT" | grep -q "workers.dev"; then
    # Extract subdomain from deployment URL (e.g., worker-name.subdomain.workers.dev)
    SUBDOMAIN=$(echo "$DEPLOYMENTS_OUTPUT" | grep -o '[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]*\.workers\.dev' | head -1 | cut -d'.' -f2)
fi

if [ -z "$SUBDOMAIN" ] || [ "$SUBDOMAIN" = "workers" ]; then
    echo "⚠️  Could not automatically detect your workers.dev subdomain"
    echo ""
    echo "Please enter your workers.dev subdomain:"
    echo "  (This is the unique subdomain assigned to your Cloudflare account)"
    echo "  Example: If your workers are at 'worker-name.sgrastar.workers.dev',"
    echo "           enter 'sgrastar'"
    echo ""
    read -p "Your subdomain: " MANUAL_SUBDOMAIN

    if [ -z "$MANUAL_SUBDOMAIN" ]; then
        echo "❌ Error: Subdomain cannot be empty"
        exit 1
    fi

    SUBDOMAIN="$MANUAL_SUBDOMAIN"
    echo ""
    echo "✅ Using subdomain: $SUBDOMAIN.workers.dev"
else
    echo "✅ Detected subdomain: $SUBDOMAIN.workers.dev"
fi

echo ""

# Prompt for deployment mode
echo "📝 Deployment Mode Configuration"
echo ""
echo "   Choose how you want to deploy Enrai:"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  1) Test Environment (workers.dev + Router Worker)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "     • Single unified endpoint: https://enrai-router.$SUBDOMAIN.workers.dev"
echo "     • Uses Router Worker with Service Bindings"
echo "     • All endpoints accessible under one domain"
echo "     • Best for: Development, testing, quick setup"
echo "     • OpenID Connect compliant ✅"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  2) Production Environment (Custom Domain + Routes)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "     • Custom domain: https://id.yourdomain.com"
echo "     • Uses Cloudflare Routes (direct routing)"
echo "     • Optimal performance (no extra hop)"
echo "     • Best for: Production deployments"
echo "     • Requires: Cloudflare-managed domain"
echo ""
read -p "Enter your choice (1/2): " -r DEPLOYMENT_MODE

case $DEPLOYMENT_MODE in
    1)
        # Test Environment: Router Worker + workers.dev
        PRODUCTION_URL="https://enrai-router.$SUBDOMAIN.workers.dev"
        USE_ROUTER="true"
        DEPLOYMENT_TYPE="test"
        echo ""
        echo "✅ Test Environment selected"
        echo "   Router Worker will be deployed with Service Bindings"
        ;;
    2)
        # Production Environment: Custom Domain + Routes
        echo ""
        echo "Enter your custom domain (e.g., https://id.yourdomain.com):"
        read -p "Custom domain: " CUSTOM_DOMAIN

        # Validate URL format
        if [[ ! $CUSTOM_DOMAIN =~ ^https:// ]]; then
            echo "❌ Error: URL must start with https://"
            exit 1
        fi

        PRODUCTION_URL="$CUSTOM_DOMAIN"
        USE_ROUTER="false"
        DEPLOYMENT_TYPE="production"

        # Extract domain for routes configuration
        DOMAIN_ONLY=$(echo "$CUSTOM_DOMAIN" | sed 's|https://||' | sed 's|/.*||')
        # Extract zone name (last two parts of domain)
        ZONE_NAME=$(echo "$DOMAIN_ONLY" | awk -F. '{print $(NF-1)"."$NF}')

        echo ""
        echo "✅ Production Environment selected"
        echo "   Custom domain: $CUSTOM_DOMAIN"
        echo "   Zone name: $ZONE_NAME"
        echo "   Cloudflare Routes will be configured"
        ;;
    *)
        echo "❌ Invalid choice. Exiting."
        exit 1
        ;;
esac

# Remove trailing slash if present
PRODUCTION_URL=${PRODUCTION_URL%/}

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🔍 Configuration Summary:"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "   ISSUER_URL: $PRODUCTION_URL"
echo ""

# Show additional notes for custom domains
if [[ $choice == "2" ]]; then
    echo "📌 Custom Domain Setup Notes:"
    echo ""
    echo "   After deployment, you'll need to configure custom domain routing:"
    echo ""
    echo "   Option A: Using Cloudflare Workers Routes"
    echo "     • Add routes in your wrangler.toml files for each worker"
    echo "     • Example:"
    echo "       [[routes]]"
    echo "       pattern = \"$PRODUCTION_URL/.well-known/*\""
    echo "       zone_name = \"yourdomain.com\""
    echo ""
    echo "   Option B: Using a Router Worker"
    echo "     • Deploy a single router worker that dispatches to the correct endpoint"
    echo "     • See WORKERS.md for detailed routing configuration"
    echo ""
    echo "   Without proper routing, endpoints won't be accessible on your custom domain."
    echo ""
fi

read -p "Continue with this configuration? (y/N): " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "❌ Configuration cancelled"
    exit 1
fi

echo ""
echo "📝 Updating wrangler.toml files..."
echo ""

# Function to update wrangler.toml with deployment settings
update_wrangler_toml() {
    local file=$1
    local use_workers_dev=$2
    local package_name=$(basename $(dirname "$file"))

    echo "  • Updating $package_name..."

    # Update ISSUER_URL
    if [[ "$OSTYPE" == "darwin"* ]]; then
        # macOS
        sed -i '' "s|ISSUER_URL = \".*\"|ISSUER_URL = \"$PRODUCTION_URL\"|" "$file"
    else
        # Linux
        sed -i "s|ISSUER_URL = \".*\"|ISSUER_URL = \"$PRODUCTION_URL\"|" "$file"
    fi

    # Set OPEN_REGISTRATION to false for production (require Initial Access Token)
    # Only update if the line exists, otherwise it will be added by op-management specific logic
    if grep -q "^OPEN_REGISTRATION = " "$file"; then
        if [[ "$OSTYPE" == "darwin"* ]]; then
            sed -i '' "s|OPEN_REGISTRATION = \".*\"|OPEN_REGISTRATION = \"false\"|" "$file"
        else
            sed -i "s|OPEN_REGISTRATION = \".*\"|OPEN_REGISTRATION = \"false\"|" "$file"
        fi
    fi

    # Remove existing workers_dev and preview_urls settings if present
    if [[ "$OSTYPE" == "darwin"* ]]; then
        sed -i '' '/^workers_dev = /d' "$file"
        sed -i '' '/^preview_urls = /d' "$file"
    else
        sed -i '/^workers_dev = /d' "$file"
        sed -i '/^preview_urls = /d' "$file"
    fi

    # Add new settings after compatibility_flags line
    local new_settings=""
    if [ "$use_workers_dev" = "true" ]; then
        new_settings="workers_dev = true\npreview_urls = true"
    else
        new_settings="workers_dev = false\npreview_urls = false"
    fi

    # Insert after compatibility_flags line
    if [[ "$OSTYPE" == "darwin"* ]]; then
        # macOS - need to escape newlines properly
        sed -i '' "/^compatibility_flags = /a\\
$new_settings
" "$file"
    else
        # Linux
        sed -i "/^compatibility_flags = /a\\$new_settings" "$file"
    fi
}

# Function to add routes to wrangler.toml (for production mode)
add_routes_to_worker() {
    local file=$1
    local package_name=$(basename $(dirname "$file"))
    local routes=""

    case $package_name in
        op-discovery)
            routes="
# Cloudflare Routes (Production)
[[routes]]
pattern = \"$DOMAIN_ONLY/.well-known/*\"
zone_name = \"$ZONE_NAME\""
            ;;
        op-auth)
            routes="
# Cloudflare Routes (Production)
[[routes]]
pattern = \"$DOMAIN_ONLY/authorize\"
zone_name = \"$ZONE_NAME\"

[[routes]]
pattern = \"$DOMAIN_ONLY/as/*\"
zone_name = \"$ZONE_NAME\""
            ;;
        op-token)
            routes="
# Cloudflare Routes (Production)
[[routes]]
pattern = \"$DOMAIN_ONLY/token\"
zone_name = \"$ZONE_NAME\""
            ;;
        op-userinfo)
            routes="
# Cloudflare Routes (Production)
[[routes]]
pattern = \"$DOMAIN_ONLY/userinfo\"
zone_name = \"$ZONE_NAME\""
            ;;
        op-management)
            routes="
# Cloudflare Routes (Production)
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

    # Remove existing routes section if present
    if [[ "$OSTYPE" == "darwin"* ]]; then
        sed -i '' '/^# Cloudflare Routes/,/^zone_name = /d' "$file"
    else
        sed -i '/^# Cloudflare Routes/,/^zone_name = /d' "$file"
    fi

    # Append routes to the end of the file
    echo "$routes" >> "$file"
}

# Determine if we're using workers_dev based on deployment mode
if [[ "$USE_ROUTER" == "true" ]]; then
    USE_WORKERS_DEV="true"
else
    USE_WORKERS_DEV="false"
fi

# Update all package wrangler.toml files
for toml_file in packages/*/wrangler.toml; do
    if [ -f "$toml_file" ]; then
        package_name=$(basename $(dirname "$toml_file"))

        # Skip router in production mode
        if [[ "$USE_ROUTER" == "false" ]] && [[ "$package_name" == "router" ]]; then
            echo "  ⊗ Skipping router (not needed in production mode)"
            continue
        fi

        update_wrangler_toml "$toml_file" "$USE_WORKERS_DEV"

        # Add routes for production mode (except router)
        if [[ "$USE_ROUTER" == "false" ]] && [[ "$package_name" != "router" ]]; then
            add_routes_to_worker "$toml_file"
        fi
    fi
done

# Update router worker if in test mode
if [[ "$USE_ROUTER" == "true" ]]; then
    if [ -f "packages/router/wrangler.toml" ]; then
        echo "  • Updating router (test mode - Service Bindings enabled)"
        # Router doesn't need ISSUER_URL, but we ensure Service Bindings are present
        # (already generated by setup-dev.sh)
    fi
fi

echo ""
echo "✅ All wrangler.toml files updated!"
echo ""

# Display updated configuration
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📋 Updated Packages:"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
for toml_file in packages/*/wrangler.toml; do
    if [ -f "$toml_file" ]; then
        package_name=$(basename $(dirname "$toml_file"))
        worker_name=$(grep '^name = ' "$toml_file" | cut -d'"' -f2)
        echo "  • $package_name → $worker_name"
    fi
done

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🎉 Production configuration complete!"
echo ""
echo "📋 Important URLs:"
echo "  • Discovery: $PRODUCTION_URL/.well-known/openid-configuration"
echo "  • JWKS: $PRODUCTION_URL/.well-known/jwks.json"
echo "  • Authorization: $PRODUCTION_URL/authorize"
echo "  • Token: $PRODUCTION_URL/token"
echo "  • UserInfo: $PRODUCTION_URL/userinfo"
echo ""

if [[ "$USE_ROUTER" == "true" ]]; then
    echo "📌 Test Environment Deployment Notes:"
    echo ""
    echo "  ✅ Router Worker enabled with Service Bindings"
    echo ""
    echo "  Your unified endpoint will be:"
    echo "    🌐 $PRODUCTION_URL"
    echo ""
    echo "  Individual workers (for debugging):"
    echo "    • enrai-op-discovery.$SUBDOMAIN.workers.dev"
    echo "    • enrai-op-auth.$SUBDOMAIN.workers.dev"
    echo "    • enrai-op-token.$SUBDOMAIN.workers.dev"
    echo "    • enrai-op-userinfo.$SUBDOMAIN.workers.dev"
    echo "    • enrai-op-management.$SUBDOMAIN.workers.dev"
    echo "    • enrai-router.$SUBDOMAIN.workers.dev (main entry point)"
    echo ""
    echo "  ℹ️  All OpenID Connect endpoints will be accessible via the Router Worker"
    echo ""
else
    echo "📌 Production Environment Deployment Notes:"
    echo ""
    echo "  ✅ Cloudflare Routes configured for custom domain"
    echo ""
    echo "  Your custom domain endpoints:"
    echo "    🌐 $PRODUCTION_URL"
    echo ""
    echo "  ⚠️  IMPORTANT: Post-Deployment Steps Required!"
    echo ""
    echo "  After running 'pnpm run deploy', you MUST:"
    echo "    1. Ensure your domain ($ZONE_NAME) is managed by Cloudflare"
    echo "    2. Verify DNS is properly configured"
    echo "    3. Routes will be automatically applied on deployment"
    echo ""
    echo "  See DEPLOYMENT.md section 'Custom Domain Setup' for details."
    echo ""
fi

echo "Next steps:"
echo "  1. Run 'pnpm run build' to build all packages"
if [[ "$USE_ROUTER" == "true" ]]; then
    echo "  2. Run 'pnpm run deploy:with-router' to deploy (includes Router Worker)"
else
    echo "  2. Run 'pnpm run deploy' to deploy (Router Worker skipped)"
fi
echo "  3. Test your endpoints using: $PRODUCTION_URL/.well-known/openid-configuration"
echo ""
echo "⚠️  Prerequisites:"
echo "  Make sure you've run these scripts first:"
echo "  • ./scripts/setup-dev.sh (to generate keys)"
echo "  • ./scripts/setup-kv.sh (to create KV namespaces)"
echo "  • ./scripts/setup-secrets.sh (to upload secrets)"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
