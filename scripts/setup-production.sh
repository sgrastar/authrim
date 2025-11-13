#!/bin/bash
#
# Enrai Production Configuration Script
# This script updates wrangler.toml files with production URLs
#

set -e

echo "🌍 Enrai Production Configuration"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Prompt for production URL
echo "📝 Please enter your production URL:"
echo "   Examples:"
echo "   • https://id.yourdomain.com (custom domain)"
echo "   • https://enrai.your-subdomain.workers.dev (workers.dev subdomain)"
echo ""
read -p "Production URL: " PRODUCTION_URL

# Validate URL format
if [[ ! $PRODUCTION_URL =~ ^https:// ]]; then
    echo "❌ Error: URL must start with https://"
    exit 1
fi

# Remove trailing slash if present
PRODUCTION_URL=${PRODUCTION_URL%/}

echo ""
echo "🔍 Configuration Summary:"
echo "   ISSUER_URL: $PRODUCTION_URL"
echo ""
read -p "Is this correct? (y/N): " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "❌ Configuration cancelled"
    exit 1
fi

echo ""
echo "📝 Updating wrangler.toml files..."
echo ""

# Function to update ISSUER_URL in wrangler.toml
update_issuer_url() {
    local file=$1
    local package_name=$(basename $(dirname "$file"))

    echo "  • Updating $package_name..."

    if [[ "$OSTYPE" == "darwin"* ]]; then
        # macOS
        sed -i '' "s|ISSUER_URL = \".*\"|ISSUER_URL = \"$PRODUCTION_URL\"|" "$file"
    else
        # Linux
        sed -i "s|ISSUER_URL = \".*\"|ISSUER_URL = \"$PRODUCTION_URL\"|" "$file"
    fi
}

# Update all package wrangler.toml files
for toml_file in packages/*/wrangler.toml; do
    if [ -f "$toml_file" ]; then
        update_issuer_url "$toml_file"
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
echo "Next steps:"
echo "  1. Run 'pnpm run build' to build all packages"
echo "  2. Run 'pnpm run deploy' to deploy to Cloudflare"
echo "  3. Test your endpoints using the URLs above"
echo ""
echo "⚠️  Important:"
echo "  Make sure you've run the following scripts first:"
echo "  • ./scripts/setup-dev.sh (to generate keys)"
echo "  • ./scripts/setup-kv.sh (to create KV namespaces)"
echo "  • ./scripts/setup-secrets.sh (to upload secrets)"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
