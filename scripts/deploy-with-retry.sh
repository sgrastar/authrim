#!/bin/bash

# Deployment script for Cloudflare Workers
#
# This script deploys workers SEQUENTIALLY with delays to avoid:
# - Cloudflare API rate limits (1,200 requests per 5 minutes)
# - Service unavailable errors (code 7010) from concurrent deployments
# - API overload from parallel deployments
#
# Usage: ./scripts/deploy-with-retry.sh

set -e

# Trap Ctrl+C and other signals to ensure clean exit
trap 'echo ""; echo "⚠️  Deployment cancelled by user"; exit 130' INT TERM

INTER_DEPLOY_DELAY=10    # Delay between deployments to avoid rate limits

deploy_package() {
    local package_name=$1
    local package_path=$2

    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "📦 Deploying: $package_name"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

    if (cd "$package_path" && pnpm run deploy); then
        echo "✅ Successfully deployed: $package_name"
        return 0
    else
        local exit_code=$?
        echo "❌ Deploy failed: $package_name (exit code: $exit_code)"
        return $exit_code
    fi
}

# Main deployment sequence
echo "🚀 Starting deployment..."
echo ""

# Validation: Check for placeholder values in wrangler.toml files
echo "🔍 Validating configuration..."
PLACEHOLDER_FOUND=false
for toml_file in packages/*/wrangler.toml; do
    if [ -f "$toml_file" ]; then
        package_name=$(basename $(dirname "$toml_file"))

        # Check for placeholder in KV namespaces
        if grep -q 'id = "placeholder"' "$toml_file" 2>/dev/null; then
            echo "  ❌ Found placeholder KV namespace ID in $package_name/wrangler.toml"
            PLACEHOLDER_FOUND=true
        fi

        # Check for placeholder in D1 databases
        if grep -q 'database_id = "placeholder"' "$toml_file" 2>/dev/null; then
            echo "  ❌ Found placeholder D1 database ID in $package_name/wrangler.toml"
            PLACEHOLDER_FOUND=true
        fi
    fi
done

if [ "$PLACEHOLDER_FOUND" = true ]; then
    echo ""
    echo "❌ Deployment aborted: Configuration contains placeholder values"
    echo ""
    echo "Please run the following setup scripts first:"
    echo "  1. ./scripts/setup-kv.sh        - Create KV namespaces and update IDs"
    echo "  2. ./scripts/setup-secrets.sh   - Upload secrets to Cloudflare"
    echo "  3. ./scripts/setup-d1.sh        - Create D1 database (if exists)"
    echo ""
    exit 1
fi

echo "  ✅ Configuration validated"
echo ""

# Build first
echo "🔨 Building packages..."
if [ "$BUILD_TARGET" = "api" ]; then
    echo "   (API only - excluding UI)"
    pnpm run build:api
else
    pnpm run build
fi
echo ""

# Deploy packages in order
# 1. Shared package (Durable Objects) must be deployed FIRST
# 2. Other workers depend on shared package for DO bindings
# 3. Router must be deployed LAST as it depends on all other workers via Service Bindings
PACKAGES=(
    "shared:packages/shared"
    "op-discovery:packages/op-discovery"
    "op-management:packages/op-management"
    "op-auth:packages/op-auth"
    "op-token:packages/op-token"
    "op-userinfo:packages/op-userinfo"
    "router:packages/router"
)

FAILED_PACKAGES=()
FIRST_DEPLOY=true

for pkg in "${PACKAGES[@]}"; do
    IFS=':' read -r name path <<< "$pkg"

    # Skip router if wrangler.toml doesn't exist (production custom domain mode)
    if [ "$name" = "router" ] && [ ! -f "$path/wrangler.toml" ]; then
        echo "⊗ Skipping router (wrangler.toml not found - not needed in production mode)"
        echo ""
        continue
    fi

    # Add delay between deployments to avoid rate limits (except for first deployment)
    if [ "$FIRST_DEPLOY" = true ]; then
        FIRST_DEPLOY=false
    else
        echo "⏸️  Waiting ${INTER_DEPLOY_DELAY}s before next deployment to avoid rate limits..."
        sleep $INTER_DEPLOY_DELAY
        echo ""
    fi

    if ! deploy_package "$name" "$path"; then
        FAILED_PACKAGES+=("$name")
    fi
    echo ""
done

# Summary
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📊 Deployment Summary"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if [ ${#FAILED_PACKAGES[@]} -eq 0 ]; then
    echo "✅ All packages deployed successfully!"
    echo ""

    # Extract ISSUER_URL from wrangler.toml
    ISSUER_URL=""
    if [ -f "packages/op-discovery/wrangler.toml" ]; then
        ISSUER_URL=$(grep 'ISSUER_URL = ' packages/op-discovery/wrangler.toml | head -1 | sed 's/.*ISSUER_URL = "\(.*\)"/\1/')
    fi

    if [ -n "$ISSUER_URL" ]; then
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        echo "🌐 OpenID Connect Endpoints"
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        echo ""
        echo "ISSUER: $ISSUER_URL"
        echo ""
        echo "Discovery & Keys:"
        echo "  • OpenID Configuration:  $ISSUER_URL/.well-known/openid-configuration"
        echo "  • JWKS (Public Keys):    $ISSUER_URL/.well-known/jwks.json"
        echo ""
        echo "Core Endpoints:"
        echo "  • Authorization:         $ISSUER_URL/authorize"
        echo "  • Token:                 $ISSUER_URL/token"
        echo "  • UserInfo:              $ISSUER_URL/userinfo"
        echo ""
        echo "Management:"
        echo "  • Client Registration:   $ISSUER_URL/register"
        echo "  • Token Introspection:   $ISSUER_URL/introspect"
        echo "  • Token Revocation:      $ISSUER_URL/revoke"
        echo ""
        echo "Advanced:"
        echo "  • PAR (Pushed AuthZ):    $ISSUER_URL/as/par"
        echo ""
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        echo "🧪 Quick Test:"
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        echo ""
        echo "curl $ISSUER_URL/.well-known/openid-configuration | jq"
        echo ""
    fi

    exit 0
else
    echo "❌ Failed packages:"
    for pkg in "${FAILED_PACKAGES[@]}"; do
        echo "   - $pkg"
    done
    exit 1
fi
