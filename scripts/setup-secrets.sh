#!/bin/bash
#
# Authrim Cloudflare Secrets Setup Script
# This script uploads private and public keys to Cloudflare Workers secrets
#
# Usage:
#   ./setup-secrets.sh --env=dev    - Upload secrets to dev environment workers
#   ./setup-secrets.sh --env=prod   - Upload secrets to prod environment workers
#
# Keys are searched in (priority order):
#   1. .authrim-keys/{env}/ (external - recommended)
#   2. .authrim/{env}/keys/ (internal)
#   3. .keys/ (legacy)
#

set -e

# Color codes
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

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

# Validate environment name (prevent path traversal)
if [[ "$DEPLOY_ENV" =~ \.\. ]] || [[ "$DEPLOY_ENV" =~ / ]] || [[ "$DEPLOY_ENV" =~ \\ ]]; then
    echo -e "${RED}❌ Error: Invalid environment name '${DEPLOY_ENV}': path traversal characters not allowed${NC}"
    exit 1
fi
if ! [[ "$DEPLOY_ENV" =~ ^[a-z][a-z0-9-]*$ ]]; then
    echo -e "${RED}❌ Error: Invalid environment name '${DEPLOY_ENV}': must be lowercase alphanumeric with hyphens, starting with a letter${NC}"
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

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 3-tier Key Search
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

KEYS_DIR=""

# 1. External: .authrim-keys/{env}/
if [ -f ".authrim-keys/$DEPLOY_ENV/private.pem" ]; then
    KEYS_DIR=".authrim-keys/$DEPLOY_ENV"
    echo -e "${GREEN}✅ Keys found in .authrim-keys/$DEPLOY_ENV/ (external)${NC}"
# 2. Internal: .authrim/{env}/keys/
elif [ -f ".authrim/$DEPLOY_ENV/keys/private.pem" ]; then
    KEYS_DIR=".authrim/$DEPLOY_ENV/keys"
    echo -e "${GREEN}✅ Keys found in .authrim/$DEPLOY_ENV/keys/ (internal)${NC}"
# 3. Legacy: .keys/
elif [ -f ".keys/private.pem" ]; then
    KEYS_DIR=".keys"
    echo -e "${YELLOW}⚠️  Keys found in .keys/ (legacy)${NC}"
    echo "   Consider migrating to .authrim-keys/$DEPLOY_ENV/ with:"
    echo "   ./scripts/setup-keys.sh --env=$DEPLOY_ENV"
else
    echo -e "${RED}❌ Error: Keys not found${NC}"
    echo ""
    echo "Searched locations:"
    echo "  1. .authrim-keys/$DEPLOY_ENV/private.pem (external)"
    echo "  2. .authrim/$DEPLOY_ENV/keys/private.pem (internal)"
    echo "  3. .keys/private.pem (legacy)"
    echo ""
    echo "Please run setup-keys.sh first:"
    echo "  ./scripts/setup-keys.sh --env=$DEPLOY_ENV"
    exit 1
fi

# Verify public key also exists
if [ ! -f "$KEYS_DIR/public.jwk.json" ]; then
    echo -e "${RED}❌ Error: Public key not found at $KEYS_DIR/public.jwk.json${NC}"
    echo "Please run: ./scripts/setup-keys.sh --env=$DEPLOY_ENV"
    exit 1
fi

echo ""
echo "📋 Found cryptographic keys in $KEYS_DIR/:"
echo "  • Private key ($KEYS_DIR/private.pem)"
echo "  • Public key ($KEYS_DIR/public.jwk.json)"
echo ""
echo "These keys will be uploaded as secrets to Cloudflare Workers:"
echo "  • PRIVATE_KEY_PEM - Used by ar-token and ar-discovery to sign JWTs"
echo "  • PUBLIC_JWK_JSON - Used by ar-auth and ar-userinfo to verify JWTs"
echo ""

# Prepare the public JWK as compact JSON
PUBLIC_JWK=$(cat "$KEYS_DIR/public.jwk.json" | jq -c .)

# Function to upload secrets to a worker
upload_secrets() {
    local package=$1
    local needs_private=$2
    local needs_public=$3
    local worker_name="${DEPLOY_ENV}-authrim-${package}"

    echo "📦 Uploading secrets to ${worker_name}..."

    if [ "$needs_private" = "true" ]; then
        echo "  • Uploading PRIVATE_KEY_PEM..."
        cat "$KEYS_DIR/private.pem" | wrangler secret put PRIVATE_KEY_PEM --name="${worker_name}"
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

# ar-discovery: Needs both keys (for JWKS endpoint and token signing)
upload_secrets "ar-discovery" "true" "true"

# ar-auth: Needs public key (for token verification)
upload_secrets "ar-auth" "false" "true"

# ar-token: Needs private key (for token signing)
upload_secrets "ar-token" "true" "false"

# ar-userinfo: Needs public key (for token verification)
upload_secrets "ar-userinfo" "false" "true"

# ar-management: Needs both keys (for registration token signing and verification)
upload_secrets "ar-management" "true" "true"

# Upload RP Token Encryption Key if available
if [ -f "$KEYS_DIR/rp_token_encryption_key.txt" ]; then
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "🔐 RP Token Encryption Key"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""

    RP_WORKERS=("ar-auth" "ar-token")
    for pkg in "${RP_WORKERS[@]}"; do
        local_worker="${DEPLOY_ENV}-authrim-${pkg}"
        echo "📦 Uploading RP_TOKEN_ENCRYPTION_KEY to ${local_worker}..."
        cat "$KEYS_DIR/rp_token_encryption_key.txt" | wrangler secret put RP_TOKEN_ENCRYPTION_KEY --name="${local_worker}"
        echo "✅ ${local_worker} RP key uploaded"
    done
    echo ""
fi

# Email configuration for ar-auth (Magic Link support)
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📧 Email Configuration for Magic Links"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "Authrim supports Cloudflare Email Service and Resend for magic link emails."
echo "If you don't configure this now, magic links will return URLs"
echo "instead of sending emails (useful for development)."
echo ""
echo "  1) Cloudflare Email Service"
echo "  2) Resend"
echo "  3) Skip"
read -p "Select provider (1-3): " -r email_provider
echo
if [[ "$email_provider" == "1" ]]; then
    echo ""
    echo "Cloudflare prerequisites: Workers Paid Plan + Cloudflare DNS + dashboard onboarding"
    echo "📦 Uploading email configuration to ${DEPLOY_ENV}-authrim-ar-auth and ${DEPLOY_ENV}-authrim-ar-management..."

    echo "  • Enter your 'From' email address (e.g., noreply@yourdomain.com):"
    read -p "    EMAIL_FROM: " EMAIL_FROM

    echo "$EMAIL_FROM" | wrangler secret put EMAIL_FROM --name="${DEPLOY_ENV}-authrim-ar-auth"
    echo "$EMAIL_FROM" | wrangler secret put EMAIL_FROM --name="${DEPLOY_ENV}-authrim-ar-management"

    echo "✅ Cloudflare email bootstrap uploaded"
    echo ""
elif [[ "$email_provider" == "2" ]]; then
    echo ""
    echo "📦 Uploading email configuration to ${DEPLOY_ENV}-authrim-ar-auth..."

    echo "  • Enter your Resend API Key:"
    read -s -p "    RESEND_API_KEY: " RESEND_API_KEY
    echo

    echo "  • Enter your 'From' email address (e.g., noreply@yourdomain.com):"
    read -p "    EMAIL_FROM: " EMAIL_FROM

    # Upload secrets
    echo "$RESEND_API_KEY" | wrangler secret put RESEND_API_KEY --name="${DEPLOY_ENV}-authrim-ar-auth"
    echo "$EMAIL_FROM" | wrangler secret put EMAIL_FROM --name="${DEPLOY_ENV}-authrim-ar-auth"

    echo "✅ Email configuration uploaded to ${DEPLOY_ENV}-authrim-ar-auth"
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
echo "  Never commit key directories to version control!"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
