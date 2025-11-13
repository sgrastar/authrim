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

# Get KEY_ID from metadata
KEY_ID=$(cat .keys/metadata.json | jq -r '.kid')

# Function to generate wrangler.toml for a worker
generate_wrangler_toml() {
    local package=$1
    local port=$2
    local kv_namespaces=$3

    local file="packages/$package/wrangler.toml"

    cat > "$file" << TOML_EOF
name = "enrai-$package"
main = "src/index.ts"
compatibility_date = "2024-09-23"
compatibility_flags = ["nodejs_compat"]

# KV Namespaces
$kv_namespaces

# Environment variables
[vars]
ISSUER_URL = "http://localhost:8787"
TOKEN_EXPIRY = "3600"
CODE_EXPIRY = "120"
STATE_EXPIRY = "300"
NONCE_EXPIRY = "300"
REFRESH_TOKEN_EXPIRY = "2592000"
KEY_ID = "$KEY_ID"
ALLOW_HTTP_REDIRECT = "true"

# Development configuration
[dev]
port = $port
TOML_EOF
}

# Check if wrangler.toml files exist, generate if missing
echo "Checking for wrangler.toml files..."
missing_configs=()
for package in op-discovery op-auth op-token op-userinfo op-management; do
    if [ ! -f "packages/$package/wrangler.toml" ]; then
        missing_configs+=("$package")
    fi
done

if [ ${#missing_configs[@]} -gt 0 ]; then
    echo "⚠️  Missing wrangler.toml files for: ${missing_configs[*]}"
    echo "📝 Generating missing wrangler.toml files..."
    echo ""

    # Generate wrangler.toml for op-discovery (if missing)
    if [[ ! -f "packages/op-discovery/wrangler.toml" ]]; then
        generate_wrangler_toml "op-discovery" 8787 '[[kv_namespaces]]
binding = "RATE_LIMIT"
id = "placeholder"
preview_id = "placeholder"'
        echo "  ✅ op-discovery/wrangler.toml"
    fi

    # Generate wrangler.toml for op-auth (if missing)
    if [[ ! -f "packages/op-auth/wrangler.toml" ]]; then
        generate_wrangler_toml "op-auth" 8788 '[[kv_namespaces]]
binding = "AUTH_CODES"
id = "placeholder"
preview_id = "placeholder"

[[kv_namespaces]]
binding = "STATE_STORE"
id = "placeholder"
preview_id = "placeholder"

[[kv_namespaces]]
binding = "NONCE_STORE"
id = "placeholder"
preview_id = "placeholder"

[[kv_namespaces]]
binding = "CLIENTS"
id = "placeholder"
preview_id = "placeholder"

[[kv_namespaces]]
binding = "RATE_LIMIT"
id = "placeholder"
preview_id = "placeholder"'
        echo "  ✅ op-auth/wrangler.toml"
    fi

    # Generate wrangler.toml for op-token (if missing)
    if [[ ! -f "packages/op-token/wrangler.toml" ]]; then
        generate_wrangler_toml "op-token" 8789 '[[kv_namespaces]]
binding = "AUTH_CODES"
id = "placeholder"
preview_id = "placeholder"

[[kv_namespaces]]
binding = "REFRESH_TOKENS"
id = "placeholder"
preview_id = "placeholder"

[[kv_namespaces]]
binding = "REVOKED_TOKENS"
id = "placeholder"
preview_id = "placeholder"

[[kv_namespaces]]
binding = "CLIENTS"
id = "placeholder"
preview_id = "placeholder"

[[kv_namespaces]]
binding = "RATE_LIMIT"
id = "placeholder"
preview_id = "placeholder"'
        echo "  ✅ op-token/wrangler.toml"
    fi

    # Generate wrangler.toml for op-userinfo (if missing)
    if [[ ! -f "packages/op-userinfo/wrangler.toml" ]]; then
        generate_wrangler_toml "op-userinfo" 8790 '[[kv_namespaces]]
binding = "CLIENTS"
id = "placeholder"
preview_id = "placeholder"

[[kv_namespaces]]
binding = "REVOKED_TOKENS"
id = "placeholder"
preview_id = "placeholder"

[[kv_namespaces]]
binding = "RATE_LIMIT"
id = "placeholder"
preview_id = "placeholder"'
        echo "  ✅ op-userinfo/wrangler.toml"
    fi

    # Generate wrangler.toml for op-management (if missing)
    if [[ ! -f "packages/op-management/wrangler.toml" ]]; then
        generate_wrangler_toml "op-management" 8791 '[[kv_namespaces]]
binding = "CLIENTS"
id = "placeholder"
preview_id = "placeholder"

[[kv_namespaces]]
binding = "REFRESH_TOKENS"
id = "placeholder"
preview_id = "placeholder"

[[kv_namespaces]]
binding = "REVOKED_TOKENS"
id = "placeholder"
preview_id = "placeholder"

[[kv_namespaces]]
binding = "RATE_LIMIT"
id = "placeholder"
preview_id = "placeholder"'
        echo "  ✅ op-management/wrangler.toml"
    fi

    echo ""
fi
echo "✅ All wrangler.toml files ready"
echo ""

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
