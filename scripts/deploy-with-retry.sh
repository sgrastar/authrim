#!/bin/bash

# Deployment script for Cloudflare Workers
#
# This script deploys workers SEQUENTIALLY with delays to avoid:
# - Cloudflare API rate limits (1,200 requests per 5 minutes)
# - Service unavailable errors (code 7010) from concurrent deployments
# - API overload from parallel deployments
#
# Usage:
#   ./scripts/deploy-with-retry.sh --env=dev
#   ./scripts/deploy-with-retry.sh --env=staging --api-only

set -e

# Trap Ctrl+C and other signals to ensure clean exit
trap 'echo ""; echo "⚠️  Deployment cancelled by user"; exit 130' INT TERM

INTER_DEPLOY_DELAY=10    # Delay between deployments to avoid rate limits
DEPLOY_ENV=""
API_ONLY=false

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --env=*)
            DEPLOY_ENV="${1#*=}"
            shift
            ;;
        --api-only)
            API_ONLY=true
            shift
            ;;
        *)
            echo "❌ Unknown parameter: $1"
            echo ""
            echo "Usage: $0 --env=<environment> [--api-only]"
            echo ""
            echo "Options:"
            echo "  --env=<name>    Environment name (required, e.g., dev, staging, prod)"
            echo "  --api-only      Deploy API packages only (exclude UI)"
            echo ""
            echo "Examples:"
            echo "  $0 --env=dev"
            echo "  $0 --env=staging --api-only"
            echo "  $0 --env=prod"
            exit 1
            ;;
    esac
done

# Validate required parameters
if [ -z "$DEPLOY_ENV" ]; then
    echo "❌ Error: --env parameter is required"
    echo ""
    echo "Usage: $0 --env=<environment> [--api-only]"
    echo ""
    echo "Examples:"
    echo "  $0 --env=dev"
    echo "  $0 --env=staging"
    echo "  $0 --env=prod"
    exit 1
fi

# Export environment variable for package scripts
export DEPLOY_ENV

# Generate version identifiers for this deployment
# UUID v4 format (lowercase)
if command -v uuidgen &> /dev/null; then
    VERSION_UUID=$(uuidgen | tr '[:upper:]' '[:lower:]')
else
    # Fallback for systems without uuidgen
    VERSION_UUID=$(cat /proc/sys/kernel/random/uuid 2>/dev/null || python3 -c 'import uuid; print(str(uuid.uuid4()))')
fi
DEPLOY_TIME=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

echo "📋 Version Information:"
echo "   UUID: ${VERSION_UUID}"
echo "   Time: ${DEPLOY_TIME}"
echo ""

deploy_package() {
    local package_name=$1
    local package_path=$2

    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "📦 Deploying: $package_name"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

    # Build the wrangler deploy command with version vars
    local deploy_cmd="wrangler deploy --config wrangler.${DEPLOY_ENV}.toml"

    # Add version vars for non-shared packages (workers that use version check)
    if [ "$package_name" != "shared" ] && [ "$package_name" != "router" ]; then
        deploy_cmd="$deploy_cmd --var CODE_VERSION_UUID:${VERSION_UUID} --var DEPLOY_TIME_UTC:${DEPLOY_TIME}"
    fi

    if (cd "$package_path" && eval "$deploy_cmd"); then
        echo "✅ Successfully deployed: $package_name"
        return 0
    else
        local exit_code=$?
        echo "❌ Deploy failed: $package_name (exit code: $exit_code)"
        return $exit_code
    fi
}

# Register version in VersionManager DO after deployment
register_versions() {
    local issuer_url=$1
    local admin_secret=$2

    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "📝 Registering versions in VersionManager DO"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

    local workers=("op-auth" "op-token" "op-management" "op-userinfo" "op-async" "op-discovery")
    local success_count=0
    local fail_count=0

    for worker in "${workers[@]}"; do
        echo -n "  • Registering $worker... "

        local response=$(curl -s -w "\n%{http_code}" -X POST "${issuer_url}/api/internal/version/${worker}" \
            -H "Authorization: Bearer ${admin_secret}" \
            -H "Content-Type: application/json" \
            -d "{\"uuid\":\"${VERSION_UUID}\",\"deployTime\":\"${DEPLOY_TIME}\"}" 2>/dev/null)

        local http_code=$(echo "$response" | tail -n1)
        local body=$(echo "$response" | sed '$d')

        if [ "$http_code" = "200" ]; then
            echo "✅"
            ((success_count++))
        else
            echo "❌ (HTTP $http_code)"
            ((fail_count++))
        fi
    done

    echo ""
    echo "   Registered: $success_count/${#workers[@]} workers"

    if [ $fail_count -gt 0 ]; then
        echo "   ⚠️  Some registrations failed. Workers will continue without version check."
    fi
}

# Main deployment sequence
echo "🚀 Starting deployment for environment: $DEPLOY_ENV"
echo ""

# Validation: Check for environment-specific wrangler config files
echo "🔍 Validating configuration..."
MISSING_CONFIG=false
PLACEHOLDER_FOUND=false

for pkg_dir in packages/*/; do
    if [ -d "$pkg_dir" ]; then
        package_name=$(basename "$pkg_dir")
        toml_file="${pkg_dir}wrangler.${DEPLOY_ENV}.toml"

        # Skip router if not needed
        if [ "$package_name" = "router" ]; then
            continue
        fi

        # Skip UI package
        if [ "$package_name" = "ui" ]; then
            continue
        fi

        # Skip policy-core (it's a library, not a deployable worker)
        if [ "$package_name" = "policy-core" ]; then
            continue
        fi

        # Check if environment-specific config exists
        if [ ! -f "$toml_file" ]; then
            echo "  ⚠️  Missing: $package_name/wrangler.${DEPLOY_ENV}.toml"
            MISSING_CONFIG=true
            continue
        fi

        # Check for placeholder in KV namespaces
        if grep -q 'id = "placeholder"' "$toml_file" 2>/dev/null; then
            echo "  ❌ Found placeholder KV namespace ID in $package_name/wrangler.${DEPLOY_ENV}.toml"
            PLACEHOLDER_FOUND=true
        fi

        # Check for placeholder in D1 databases
        if grep -q 'database_id = "placeholder"' "$toml_file" 2>/dev/null; then
            echo "  ❌ Found placeholder D1 database ID in $package_name/wrangler.${DEPLOY_ENV}.toml"
            PLACEHOLDER_FOUND=true
        fi
    fi
done

if [ "$MISSING_CONFIG" = true ]; then
    echo ""
    echo "❌ Deployment aborted: Missing environment-specific configuration files"
    echo ""
    echo "Please run the setup script first:"
    echo "  ./scripts/setup-remote-wrangler.sh --env=$DEPLOY_ENV --domain=<your-domain>"
    echo ""
    exit 1
fi

if [ "$PLACEHOLDER_FOUND" = true ]; then
    echo ""
    echo "❌ Deployment aborted: Configuration contains placeholder values"
    echo ""
    echo "Please run the following setup scripts first:"
    echo "  1. ./scripts/setup-kv.sh --env=$DEPLOY_ENV"
    echo "  2. ./scripts/setup-secrets.sh --env=$DEPLOY_ENV"
    echo "  3. ./scripts/setup-d1.sh --env=$DEPLOY_ENV"
    echo ""
    exit 1
fi

echo "  ✅ Configuration validated"
echo ""

# Build first
echo "🔨 Building packages..."
if [ "$API_ONLY" = true ]; then
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

    # Skip router if environment-specific wrangler config doesn't exist
    if [ "$name" = "router" ] && [ ! -f "$path/wrangler.${DEPLOY_ENV}.toml" ]; then
        echo "⊗ Skipping router (wrangler.${DEPLOY_ENV}.toml not found - not needed when using custom domains)"
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

    # Extract ISSUER_URL and ADMIN_API_SECRET from environment-specific wrangler.toml
    ISSUER_URL=""
    ADMIN_API_SECRET=""
    if [ -f "packages/op-discovery/wrangler.${DEPLOY_ENV}.toml" ]; then
        ISSUER_URL=$(grep 'ISSUER_URL = ' "packages/op-discovery/wrangler.${DEPLOY_ENV}.toml" | head -1 | sed 's/.*ISSUER_URL = "\(.*\)"/\1/')
    fi
    if [ -f "packages/op-management/wrangler.${DEPLOY_ENV}.toml" ]; then
        ADMIN_API_SECRET=$(grep 'ADMIN_API_SECRET = ' "packages/op-management/wrangler.${DEPLOY_ENV}.toml" | head -1 | sed 's/.*ADMIN_API_SECRET = "\(.*\)"/\1/')
        # Fallback to KEY_MANAGER_SECRET if ADMIN_API_SECRET not found
        if [ -z "$ADMIN_API_SECRET" ]; then
            ADMIN_API_SECRET=$(grep 'KEY_MANAGER_SECRET = ' "packages/op-management/wrangler.${DEPLOY_ENV}.toml" | head -1 | sed 's/.*KEY_MANAGER_SECRET = "\(.*\)"/\1/')
        fi
    fi

    # Register versions in VersionManager DO
    if [ -n "$ISSUER_URL" ] && [ -n "$ADMIN_API_SECRET" ]; then
        # Wait a moment for workers to be fully available
        echo "⏳ Waiting 5 seconds for workers to be available..."
        sleep 5
        register_versions "$ISSUER_URL" "$ADMIN_API_SECRET"
    else
        echo "⚠️  Skipping version registration: ISSUER_URL or ADMIN_API_SECRET not found"
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
