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

# Prompt for production URL choice
echo "📝 Production URL Configuration"
echo ""
echo "   This URL will be used as the ISSUER_URL for your OpenID Provider."
echo "   The issuer URL is the base URL that identifies your OAuth/OIDC server."
echo "   It's used in tokens, discovery endpoints, and client configurations."
echo ""
echo "Choose your deployment option:"
echo ""
echo "  1) Use workers.dev subdomain (recommended for testing)"
echo "     URL: https://enrai.$SUBDOMAIN.workers.dev"
echo ""
echo "  2) Use custom domain (recommended for production)"
echo "     You will enter your custom domain"
echo ""
read -p "Enter your choice (1/2): " -r choice

case $choice in
    1)
        PRODUCTION_URL="https://enrai.$SUBDOMAIN.workers.dev"
        echo ""
        echo "✅ Using workers.dev subdomain"
        ;;
    2)
        echo ""
        echo "Enter your custom domain (e.g., https://id.yourdomain.com):"
        read -p "Custom domain: " CUSTOM_DOMAIN

        # Validate URL format
        if [[ ! $CUSTOM_DOMAIN =~ ^https:// ]]; then
            echo "❌ Error: URL must start with https://"
            exit 1
        fi

        PRODUCTION_URL="$CUSTOM_DOMAIN"
        echo ""
        echo "✅ Using custom domain"
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

# Determine if we're using workers_dev based on user choice
if [[ $choice == "1" ]]; then
    USE_WORKERS_DEV="true"
else
    USE_WORKERS_DEV="false"
fi

# Update all package wrangler.toml files
for toml_file in packages/*/wrangler.toml; do
    if [ -f "$toml_file" ]; then
        update_wrangler_toml "$toml_file" "$USE_WORKERS_DEV"
    fi
done

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

if [[ $choice == "1" ]]; then
    echo "📌 Workers.dev Deployment Notes:"
    echo ""
    echo "  Your workers will be automatically accessible at:"
    echo "    • enrai-op-discovery.$SUBDOMAIN.workers.dev"
    echo "    • enrai-op-auth.$SUBDOMAIN.workers.dev"
    echo "    • enrai-op-token.$SUBDOMAIN.workers.dev"
    echo "    • enrai-op-userinfo.$SUBDOMAIN.workers.dev"
    echo "    • enrai-op-management.$SUBDOMAIN.workers.dev"
    echo ""
    echo "  ⚠️  Note: For a unified endpoint, you'll need to set up routing."
    echo "  See DEPLOYMENT.md for routing configuration options."
    echo ""
elif [[ $choice == "2" ]]; then
    echo "📌 Custom Domain Deployment Notes:"
    echo ""
    echo "  ⚠️  IMPORTANT: After deployment, you MUST configure custom domain routing!"
    echo ""
    echo "  Your workers will deploy to workers.dev by default, but won't be"
    echo "  accessible on your custom domain until you configure routes."
    echo ""
    echo "  See DEPLOYMENT.md section 'Custom Domain Setup' for detailed instructions."
    echo ""
fi

echo "Next steps:"
echo "  1. Run 'pnpm run build' to build all packages"
echo "  2. Run 'pnpm run deploy' to deploy to Cloudflare"
if [[ $choice == "2" ]]; then
    echo "  3. Configure custom domain routes (see DEPLOYMENT.md)"
    echo "  4. Test your endpoints using the URLs above"
else
    echo "  3. Test your endpoints using the URLs above"
fi
echo ""
echo "⚠️  Prerequisites:"
echo "  Make sure you've run these scripts first:"
echo "  • ./scripts/setup-dev.sh (to generate keys)"
echo "  • ./scripts/setup-kv.sh (to create KV namespaces)"
echo "  • ./scripts/setup-secrets.sh (to upload secrets)"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
