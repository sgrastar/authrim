#!/bin/bash

# Deployment script with retry logic for Cloudflare API errors
#
# This script deploys workers SEQUENTIALLY with delays to avoid:
# - Cloudflare API rate limits (1,200 requests per 5 minutes)
# - Service unavailable errors (code 7010) from concurrent deployments
# - API overload from parallel deployments
#
# Usage: ./scripts/deploy-with-retry.sh

set -e

MAX_RETRIES=4
RETRY_DELAYS=(2 4 8 16)  # Exponential backoff in seconds
INTER_DEPLOY_DELAY=10    # Delay between successful deployments to avoid rate limits

deploy_package() {
    local package_name=$1
    local package_path=$2

    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "📦 Deploying: $package_name"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

    for i in $(seq 0 $((MAX_RETRIES - 1))); do
        if [ $i -gt 0 ]; then
            local delay=${RETRY_DELAYS[$((i-1))]}
            echo "⏳ Retry $i/$MAX_RETRIES after ${delay}s delay..."
            sleep $delay
        fi

        if (cd "$package_path" && pnpm run deploy); then
            echo "✅ Successfully deployed: $package_name"
            return 0
        else
            local exit_code=$?
            if [ $i -lt $((MAX_RETRIES - 1)) ]; then
                echo "⚠️  Deploy failed (exit code: $exit_code), will retry..."
            else
                echo "❌ Deploy failed after $MAX_RETRIES attempts: $package_name"
                return $exit_code
            fi
        fi
    done

    return 1
}

# Main deployment sequence
echo "🚀 Starting deployment with retry logic..."
echo ""

# Build first
echo "🔨 Building packages..."
pnpm run build
echo ""

# Deploy packages in order
# Router must be deployed LAST as it depends on all other workers via Service Bindings
PACKAGES=(
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
    exit 0
else
    echo "❌ Failed packages:"
    for pkg in "${FAILED_PACKAGES[@]}"; do
        echo "   - $pkg"
    done
    exit 1
fi
