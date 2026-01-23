#!/bin/bash

# Rollback script for Cloudflare Workers
#
# This script rolls back all workers to their previous versions.
# Use this when a deployment causes issues and you need to quickly revert.
#
# Usage:
#   ./scripts/rollback-all.sh --env=prod
#   ./scripts/rollback-all.sh --env=staging --confirm
#
# Options:
#   --env=<name>    Environment name (required)
#   --confirm       Skip confirmation prompt
#   --single=<pkg>  Rollback only a specific package

set -e

# Trap Ctrl+C and other signals to ensure clean exit
trap 'echo ""; echo "⚠️  Rollback cancelled by user"; exit 130' INT TERM

DEPLOY_ENV=""
CONFIRM=false
SINGLE_PACKAGE=""

# All deployable workers (in dependency order)
WORKERS=(
    "ar-lib-core"
    "ar-discovery"
    "ar-management"
    "ar-auth"
    "ar-token"
    "ar-userinfo"
    "ar-async"
    "ar-policy"
    "ar-saml"
    "ar-bridge"
    "ar-vc"
    "ar-router"
)

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --env=*)
            DEPLOY_ENV="${1#*=}"
            shift
            ;;
        --confirm)
            CONFIRM=true
            shift
            ;;
        --single=*)
            SINGLE_PACKAGE="${1#*=}"
            shift
            ;;
        *)
            echo "❌ Unknown parameter: $1"
            echo ""
            echo "Usage: $0 --env=<environment> [options]"
            echo ""
            echo "Options:"
            echo "  --env=<name>    Environment name (required, e.g., dev, staging, prod)"
            echo "  --confirm       Skip confirmation prompt"
            echo "  --single=<pkg>  Rollback only a specific package (e.g., ar-token)"
            echo ""
            echo "Examples:"
            echo "  $0 --env=prod"
            echo "  $0 --env=staging --confirm"
            echo "  $0 --env=prod --single=ar-token"
            exit 1
            ;;
    esac
done

# Validate required parameters
if [ -z "$DEPLOY_ENV" ]; then
    echo "❌ Error: --env parameter is required"
    echo ""
    echo "Usage: $0 --env=<environment>"
    exit 1
fi

# Confirmation prompt
if [ "$CONFIRM" = false ]; then
    echo "⚠️  WARNING: You are about to rollback workers in environment: $DEPLOY_ENV"
    echo ""
    if [ -n "$SINGLE_PACKAGE" ]; then
        echo "   Package: $SINGLE_PACKAGE"
    else
        echo "   Packages: All workers"
    fi
    echo ""
    read -p "   Are you sure you want to continue? (y/N) " -n 1 -r
    echo ""
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "❌ Rollback cancelled"
        exit 1
    fi
fi

echo ""
echo "🔄 Starting rollback for environment: $DEPLOY_ENV"
echo ""

rollback_package() {
    local package_name=$1
    local package_path="packages/$package_name"

    # Check if wrangler.toml exists with [env.xxx] section
    if [ ! -f "$package_path/wrangler.toml" ]; then
        echo "  ⏭️  Skipping $package_name (no wrangler.toml)"
        return 0
    fi

    if ! grep -q "\\[env\\.${DEPLOY_ENV}\\]" "$package_path/wrangler.toml" 2>/dev/null; then
        echo "  ⏭️  Skipping $package_name (no [env.${DEPLOY_ENV}] section)"
        return 0
    fi

    echo "  🔄 Rolling back $package_name..."

    # Use --env to target [env.xxx] section in wrangler.toml
    if (cd "$package_path" && pnpm exec wrangler rollback --env "${DEPLOY_ENV}" 2>/dev/null); then
        echo "  ✅ Rolled back: $package_name"
        return 0
    else
        echo "  ⚠️  Rollback may have failed for $package_name (check manually)"
        return 1
    fi
}

SUCCESS_COUNT=0
FAIL_COUNT=0

if [ -n "$SINGLE_PACKAGE" ]; then
    # Rollback single package
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "📦 Rolling back: $SINGLE_PACKAGE"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

    if rollback_package "$SINGLE_PACKAGE"; then
        ((SUCCESS_COUNT++))
    else
        ((FAIL_COUNT++))
    fi
else
    # Rollback all packages
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "📦 Rolling back all workers"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

    for worker in "${WORKERS[@]}"; do
        if rollback_package "$worker"; then
            ((SUCCESS_COUNT++))
        else
            ((FAIL_COUNT++))
        fi
    done
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📊 Rollback Summary"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  ✅ Success: $SUCCESS_COUNT"
if [ $FAIL_COUNT -gt 0 ]; then
    echo "  ⚠️  Failed: $FAIL_COUNT"
fi
echo ""

# Post-rollback verification instructions
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🔍 Post-Rollback Verification"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "Please verify the following:"
echo ""
echo "1. Check OIDC Discovery endpoint:"
ISSUER_URL=""
if [ -f "packages/ar-discovery/wrangler.toml" ]; then
    ISSUER_URL=$(grep -A 100 "\\[env\\.${DEPLOY_ENV}\\.vars\\]" "packages/ar-discovery/wrangler.toml" 2>/dev/null | grep 'ISSUER_URL = ' | head -1 | sed 's/.*ISSUER_URL = "\(.*\)"/\1/')
fi
if [ -n "$ISSUER_URL" ]; then
    echo "   curl ${ISSUER_URL}/.well-known/openid-configuration | jq"
else
    echo "   curl <your-issuer-url>/.well-known/openid-configuration | jq"
fi
echo ""
echo "2. Check JWKS endpoint:"
if [ -n "$ISSUER_URL" ]; then
    echo "   curl ${ISSUER_URL}/.well-known/jwks.json | jq"
else
    echo "   curl <your-issuer-url>/.well-known/jwks.json | jq"
fi
echo ""
echo "3. Check deployment status:"
echo "   cd packages/ar-token && pnpm exec wrangler deployments list --env ${DEPLOY_ENV}"
echo ""

if [ $FAIL_COUNT -eq 0 ]; then
    exit 0
else
    exit 1
fi
