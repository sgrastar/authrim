#!/bin/bash
#
# Enrai Cloudflare Secrets Setup Script
# This script uploads private and public keys to Cloudflare Workers secrets
#

set -e

echo "🔐 Enrai Cloudflare Secrets Setup"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Check if wrangler is installed
if ! command -v wrangler &> /dev/null; then
    echo "❌ Error: wrangler is not installed"
    echo "Please install it with: pnpm install -g wrangler"
    exit 1
fi

# Check if user is logged in
if ! wrangler whoami &> /dev/null; then
    echo "❌ Error: Not logged in to Cloudflare"
    echo "Please run: wrangler login"
    exit 1
fi

# Check if keys exist
if [ ! -f ".keys/private.pem" ]; then
    echo "❌ Error: Private key not found at .keys/private.pem"
    echo "Please run: ./scripts/setup-dev.sh"
    exit 1
fi

if [ ! -f ".keys/public.jwk.json" ]; then
    echo "❌ Error: Public key not found at .keys/public.jwk.json"
    echo "Please run: ./scripts/setup-dev.sh"
    exit 1
fi

echo "✅ Keys found"
echo ""
echo "📋 Found cryptographic keys:"
echo "  • Private key (.keys/private.pem)"
echo "  • Public key (.keys/public.jwk.json)"
echo ""
echo "These keys will be uploaded as secrets to Cloudflare Workers:"
echo "  • PRIVATE_KEY_PEM - Used by op-token and op-discovery to sign JWTs"
echo "  • PUBLIC_JWK_JSON - Used by op-auth and op-userinfo to verify JWTs"
echo ""

# Prepare the public JWK as compact JSON
PUBLIC_JWK=$(cat .keys/public.jwk.json | jq -c .)

# Function to upload secrets to a worker
upload_secrets() {
    local package=$1
    local needs_private=$2
    local needs_public=$3

    echo "📦 Uploading secrets to $package..."
    cd "packages/$package"

    if [ "$needs_private" = "true" ]; then
        echo "  • Uploading PRIVATE_KEY_PEM..."
        cat ../../.keys/private.pem | wrangler secret put PRIVATE_KEY_PEM
    fi

    if [ "$needs_public" = "true" ]; then
        echo "  • Uploading PUBLIC_JWK_JSON..."
        echo "$PUBLIC_JWK" | wrangler secret put PUBLIC_JWK_JSON
    fi

    cd ../..
    echo "✅ $package secrets uploaded"
    echo ""
}

# Upload secrets to each worker that needs them
echo "🚀 Uploading secrets to workers..."
echo ""

# op-discovery: Needs both keys (for JWKS endpoint and token signing)
upload_secrets "op-discovery" "true" "true"

# op-auth: Needs public key (for token verification)
upload_secrets "op-auth" "false" "true"

# op-token: Needs private key (for token signing)
upload_secrets "op-token" "true" "false"

# op-userinfo: Needs public key (for token verification)
upload_secrets "op-userinfo" "false" "true"

# op-management: Needs both keys (for registration token signing and verification)
upload_secrets "op-management" "true" "true"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🎉 All secrets uploaded successfully!"
echo ""
echo "Next steps:"
echo "  1. Run './scripts/setup-production.sh' to configure production URLs"
echo "  2. Run 'pnpm run deploy' to deploy all workers"
echo ""
echo "⚠️  Security Note:"
echo "  Secrets are now stored securely in Cloudflare."
echo "  Never commit .keys/ directory to version control!"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
