#!/bin/bash
#
# Authrim Cloudflare Secrets Setup Script
# This script uploads private and public keys to Cloudflare Workers secrets
#
# Usage:
#   ./setup-secrets.sh --env=dev    - Upload secrets to dev environment workers
#   ./setup-secrets.sh --env=prod   - Upload secrets to prod environment workers
#

set -e

# Parse command line arguments
DEPLOY_ENV=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --env=*)
            DEPLOY_ENV="${1#*=}"
            shift
            ;;
        *)
            echo "❌ Unknown parameter: $1"
            echo ""
            echo "Usage: $0 --env=<environment>"
            echo ""
            echo "Options:"
            echo "  --env=<name>    Environment name (required, e.g., dev, staging, prod)"
            echo ""
            echo "Examples:"
            echo "  $0 --env=dev"
            echo "  $0 --env=staging"
            echo "  $0 --env=prod"
            exit 1
            ;;
    esac
done

# Validate required parameters
if [ -z "$DEPLOY_ENV" ]; then
    echo "❌ Error: --env parameter is required"
    echo ""
    echo "Usage: $0 --env=<environment>"
    echo ""
    echo "Examples:"
    echo "  $0 --env=dev"
    echo "  $0 --env=staging"
    echo "  $0 --env=prod"
    exit 1
fi

echo "🔐 Authrim Cloudflare Secrets Setup - Environment: $DEPLOY_ENV"
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
    local worker_name="${DEPLOY_ENV}-authrim-${package}"

    echo "📦 Uploading secrets to ${worker_name}..."

    if [ "$needs_private" = "true" ]; then
        echo "  • Uploading PRIVATE_KEY_PEM..."
        cat .keys/private.pem | wrangler secret put PRIVATE_KEY_PEM --name="${worker_name}"
    fi

    if [ "$needs_public" = "true" ]; then
        echo "  • Uploading PUBLIC_JWK_JSON..."
        echo "$PUBLIC_JWK" | wrangler secret put PUBLIC_JWK_JSON --name="${worker_name}"
    fi

    echo "✅ ${worker_name} secrets uploaded"
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

# Email configuration for op-auth (Magic Link support)
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📧 Email Configuration for Magic Links"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "Authrim uses Resend for sending magic link emails."
echo "If you don't configure this now, magic links will return URLs"
echo "instead of sending emails (useful for development)."
echo ""
read -p "Do you want to configure Resend API Key? (y/N): " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo ""
    echo "📦 Uploading email configuration to ${DEPLOY_ENV}-authrim-op-auth..."

    echo "  • Enter your Resend API Key:"
    read -s -p "    RESEND_API_KEY: " RESEND_API_KEY
    echo

    echo "  • Enter your 'From' email address (e.g., noreply@yourdomain.com):"
    read -p "    EMAIL_FROM: " EMAIL_FROM

    # Upload secrets
    echo "$RESEND_API_KEY" | wrangler secret put RESEND_API_KEY --name="${DEPLOY_ENV}-authrim-op-auth"
    echo "$EMAIL_FROM" | wrangler secret put EMAIL_FROM --name="${DEPLOY_ENV}-authrim-op-auth"

    echo "✅ Email configuration uploaded to ${DEPLOY_ENV}-authrim-op-auth"
    echo ""
else
    echo "⊗ Email configuration skipped (magic links will return URLs)"
    echo ""
fi

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🎉 All secrets uploaded successfully to environment: $DEPLOY_ENV"
echo ""
echo "Next steps:"
echo "  1. Run './scripts/setup-d1.sh --env=$DEPLOY_ENV' if you haven't already"
echo "  2. Run 'pnpm run deploy -- --env=$DEPLOY_ENV' to deploy all workers"
echo ""
echo "⚠️  Security Note:"
echo "  Secrets are now stored securely in Cloudflare for $DEPLOY_ENV environment."
echo "  Never commit .keys/ directory to version control!"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
