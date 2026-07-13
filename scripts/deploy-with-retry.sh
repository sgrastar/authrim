#!/bin/bash

# Deployment script for Cloudflare Workers
#
# Standard deployments use the shared dependency-aware TypeScript engine with
# bounded concurrency and adaptive rate-limit retries. Gradual rollout remains
# intentionally serial because each traffic stage requires a health decision.
#
# Gradual Rollout:
# This script supports Cloudflare Versions Deploy for gradual rollouts.
# When --gradual is specified, each worker is deployed to a percentage of traffic,
# health checks are performed, and rollback is automatic on failure.
#
# Usage:
#   ./scripts/deploy-with-retry.sh --env=dev
#   ./scripts/deploy-with-retry.sh --env=staging --api-only
#   ./scripts/deploy-with-retry.sh --env=prod --gradual
#   ./scripts/deploy-with-retry.sh --env=prod --gradual-stages=10,30,50,100
#   ./scripts/deploy-with-retry.sh --env=prod --gradual --gradual-wait=5

set -e

# Source common utilities
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "${SCRIPT_DIR}/lib/authrim-paths.sh" ]; then
  source "${SCRIPT_DIR}/lib/authrim-paths.sh"
fi

# Trap Ctrl+C and other signals to ensure clean exit
trap 'echo ""; echo "⚠️  Deployment cancelled by user"; exit 130' INT TERM

DEPLOY_ENV=""
API_ONLY=false
GRADUAL_ROLLOUT=false
GRADUAL_STAGES="10,50,100"    # Default gradual rollout stages (percentage)
GRADUAL_WAIT=3                 # Wait time between stages in minutes
KEYS_DIR_OVERRIDE=""

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
        --keys-dir=*)
            KEYS_DIR_OVERRIDE="${1#*=}"
            shift
            ;;
        --keys-dir)
            if [ $# -lt 2 ] || [ -z "$2" ]; then
                echo "❌ --keys-dir requires a directory path"
                exit 1
            fi
            KEYS_DIR_OVERRIDE="$2"
            shift 2
            ;;
        --gradual)
            GRADUAL_ROLLOUT=true
            shift
            ;;
        --gradual-stages=*)
            GRADUAL_STAGES="${1#*=}"
            GRADUAL_ROLLOUT=true
            shift
            ;;
        --gradual-wait=*)
            GRADUAL_WAIT="${1#*=}"
            shift
            ;;
        *)
            echo "❌ Unknown parameter: $1"
            echo ""
            echo "Usage: $0 --env=<environment> [options]"
            echo ""
            echo "Options:"
            echo "  --env=<name>           Environment name (required, e.g., dev, staging, prod)"
            echo "  --api-only             Deploy API packages only (exclude UI)"
            echo "  --keys-dir=<path>      Override the environment key archive directory"
            echo "  --gradual              Enable gradual rollout (default: 10% → 50% → 100%)"
            echo "  --gradual-stages=N,N   Custom rollout stages (comma-separated percentages)"
            echo "  --gradual-wait=N       Wait time between stages in minutes (default: 3)"
            echo ""
            echo "Examples:"
            echo "  $0 --env=dev"
            echo "  $0 --env=staging --api-only"
            echo "  $0 --env=prod"
            echo "  $0 --env=prod --gradual"
            echo "  $0 --env=prod --gradual-stages=10,30,50,100"
            echo "  $0 --env=prod --gradual --gradual-wait=5"
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
if [[ ! "$DEPLOY_ENV" =~ ^[a-z][a-z0-9-]*$ ]]; then
    echo "❌ Invalid environment name: $DEPLOY_ENV"
    exit 1
fi
if [[ ! "$GRADUAL_WAIT" =~ ^[0-9]+$ ]]; then
    echo "❌ --gradual-wait must be a non-negative integer"
    exit 1
fi
if [[ ! "$GRADUAL_STAGES" =~ ^[0-9]+(,[0-9]+)*$ ]]; then
    echo "❌ --gradual-stages must be a comma-separated list of integers"
    exit 1
fi

IFS=',' read -r -a GRADUAL_STAGE_VALUES <<< "$GRADUAL_STAGES"
previous_stage=0
for stage in "${GRADUAL_STAGE_VALUES[@]}"; do
    if [ "$stage" -lt 1 ] || [ "$stage" -gt 100 ] || [ "$stage" -le "$previous_stage" ]; then
        echo "❌ --gradual-stages must be strictly increasing integers from 1 to 100"
        exit 1
    fi
    previous_stage=$stage
done
if [ "$previous_stage" -ne 100 ]; then
    echo "❌ --gradual-stages must end at 100"
    exit 1
fi

KEYS_DIR_ARGS=()
if [ -n "$KEYS_DIR_OVERRIDE" ]; then
    KEYS_DIR_ARGS+=("--keys-dir=${KEYS_DIR_OVERRIDE}")
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
if [ "$GRADUAL_ROLLOUT" = true ]; then
    echo "   Mode: Gradual Rollout"
    echo "   Stages: ${GRADUAL_STAGES}%"
    echo "   Wait: ${GRADUAL_WAIT} minutes between stages"
fi
echo ""

# Validate URL format (security: prevent command injection via malformed URLs)
# Only allows https:// URLs with valid hostname format
validate_url() {
    local url=$1

    # Check if URL is empty
    if [ -z "$url" ]; then
        return 1
    fi

    # Check URL format: must be https:// with valid hostname
    # Pattern: https://[a-z0-9.-]+(/[^<>&'\"]*)?
    if [[ ! "$url" =~ ^https://[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?(\.[a-zA-Z]{2,})+(/[^\<\>\&\'\"]*)?$ ]]; then
        # Also allow localhost for development
        if [[ ! "$url" =~ ^https?://localhost(:[0-9]+)?(/[^\<\>\&\'\"]*)?$ ]]; then
            echo "❌ Invalid URL format: $url"
            return 1
        fi
    fi

    # Check for shell metacharacters that could cause command injection
    if [[ "$url" =~ [\$\`\|\;\&\(\)\{\}\[\]] ]]; then
        echo "❌ URL contains invalid characters: $url"
        return 1
    fi

    return 0
}

# Deploy one package with exact old/new Cloudflare Version IDs. The shared
# TypeScript engine uploads secrets with the version, applies triggers, checks
# health, and rolls traffic back to the exact baseline Version ID on failure.
deploy_package_gradual() {
    local package_name=$1
    local _package_path=$2
    local issuer_url=$3

    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "📦 Deploying (Gradual): $package_name"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

    local gradual_args=(
        "--env=${DEPLOY_ENV}"
        "--component=${package_name}"
        "--mode=auto"
        "--concurrency=1"
        "--gradual-stages=${GRADUAL_STAGES}"
        "--gradual-wait-seconds=$((GRADUAL_WAIT * 60))"
        "${KEYS_DIR_ARGS[@]}"
    )
    if [ -n "$issuer_url" ]; then
        gradual_args+=("--health-url=${issuer_url}")
    fi

    AUTHRIM_DEPLOY_UUID="$VERSION_UUID" \
    AUTHRIM_DEPLOY_TIME="$DEPLOY_TIME" \
        pnpm exec tsx scripts/deploy-api.ts "${gradual_args[@]}"
}

deploy_package() {
    local package_name=$1
    local _package_path=$2

    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "📦 Deploying: $package_name"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

    if AUTHRIM_DEPLOY_UUID="$VERSION_UUID" \
       AUTHRIM_DEPLOY_TIME="$DEPLOY_TIME" \
       pnpm exec tsx scripts/deploy-api.ts \
         --env="$DEPLOY_ENV" \
         --component="$package_name" \
         --mode=direct \
         --concurrency=1 \
         "${KEYS_DIR_ARGS[@]}"; then
        echo "✅ Successfully deployed: $package_name"
        return 0
    else
        local exit_code=$?
        echo "❌ Deploy failed: $package_name (exit code: $exit_code)"
        return $exit_code
    fi
}

# Main deployment sequence
echo "🚀 Starting deployment for environment: $DEPLOY_ENV"
echo ""

# Validation: Check for wrangler.toml with [env.xxx] sections
echo "🔍 Validating configuration..."
MISSING_CONFIG=false
MISSING_ENV_SECTION=false
PLACEHOLDER_FOUND=false

for pkg_dir in packages/*/; do
    if [ -d "$pkg_dir" ]; then
        package_name=$(basename "$pkg_dir")
        toml_file="${pkg_dir}wrangler.toml"

        # Skip UI packages (deployed via Cloudflare Pages, not Workers)
        if [ "$package_name" = "ar-ui" ] || [ "$package_name" = "ar-admin-ui" ] || [ "$package_name" = "ar-login-ui" ]; then
            continue
        fi

        # Skip setup package (CLI tool, not a deployable worker)
        if [ "$package_name" = "setup" ]; then
            continue
        fi

        # Skip library packages (not deployable workers)
        # ar-lib-core is special - it contains Durable Objects and IS deployed
        if [[ "$package_name" == ar-lib-* && "$package_name" != "ar-lib-core" ]]; then
            continue
        fi

        # Check if wrangler.toml exists
        if [ ! -f "$toml_file" ]; then
            echo "  ⚠️  Missing: $package_name/wrangler.toml"
            MISSING_CONFIG=true
            continue
        fi

        # Check if [env.xxx] section exists for the target environment
        if ! grep -q "\\[env\\.${DEPLOY_ENV}\\]" "$toml_file" 2>/dev/null; then
            echo "  ⚠️  Missing [env.${DEPLOY_ENV}] section in $package_name/wrangler.toml"
            MISSING_ENV_SECTION=true
            continue
        fi

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

if [ "$MISSING_CONFIG" = true ]; then
    echo ""
    echo "❌ Deployment aborted: Missing wrangler.toml configuration files"
    echo ""
    echo "Please run the setup script first:"
    echo "  ./scripts/setup-remote-wrangler.sh --env=$DEPLOY_ENV --domain=<your-domain>"
    echo ""
    exit 1
fi

if [ "$MISSING_ENV_SECTION" = true ]; then
    echo ""
    echo "❌ Deployment aborted: Missing [env.${DEPLOY_ENV}] sections in wrangler.toml"
    echo ""
    echo "Please run the setup script to generate the environment configuration:"
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

# Fail before creating UI binding targets or changing Worker traffic. This
# probes remote existence and verifies all secrets required by fresh Workers.
echo "🔎 Running deployment preflight..."
pnpm exec tsx scripts/deploy-api.ts \
    --env="$DEPLOY_ENV" \
    --mode=auto \
    --concurrency=2 \
    --preflight \
    "${KEYS_DIR_ARGS[@]}"
echo ""

# Build first (always clear cache to ensure fresh builds)
echo "🔨 Building packages..."
echo "   Clearing turbo cache to ensure fresh build..."
rm -rf .turbo node_modules/.cache 2>/dev/null || true

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
    "ar-lib-core:packages/ar-lib-core"
    "ar-bridge:packages/ar-bridge"
    "ar-discovery:packages/ar-discovery"
    "ar-token:packages/ar-token"
    "ar-userinfo:packages/ar-userinfo"
    "ar-async:packages/ar-async"
    "ar-policy:packages/ar-policy"
    "ar-saml:packages/ar-saml"
    "ar-vc:packages/ar-vc"
    "ar-auth:packages/ar-auth"
    "ar-management:packages/ar-management"
    "ar-router:packages/ar-router"
)

# Get ISSUER_URL early for health checks during gradual rollout
# Priority: 1. .authrim/{env}/config.json, 2. wrangler.toml [env.xxx.vars]
ISSUER_URL=""
if type get_issuer_url &>/dev/null; then
    ISSUER_URL=$(get_issuer_url "$DEPLOY_ENV" 2>/dev/null)
else
    # Fallback: Extract from wrangler.toml
    if [ -f "packages/ar-discovery/wrangler.toml" ]; then
        ISSUER_URL=$(grep -A 100 "\\[env\\.${DEPLOY_ENV}\\.vars\\]" "packages/ar-discovery/wrangler.toml" 2>/dev/null | grep 'ISSUER_URL = ' | head -1 | sed 's/.*ISSUER_URL = "\(.*\)"/\1/')
    fi
fi
# Validate URL before use (security: prevent command injection)
if [ -n "$ISSUER_URL" ] && ! validate_url "$ISSUER_URL"; then
    echo "⚠️  ISSUER_URL validation failed. Health checks will be skipped."
    ISSUER_URL=""
fi

# Display gradual rollout warning
if [ "$GRADUAL_ROLLOUT" = true ]; then
    echo "⚠️  Gradual rollout enabled. Each worker will be deployed in stages:"
    echo "   Stages: ${GRADUAL_STAGES}%"
    echo "   Wait time: ${GRADUAL_WAIT} minutes between stages"
    if [ -n "$ISSUER_URL" ]; then
        echo "   Health check URL: ${ISSUER_URL}/.well-known/openid-configuration"
    fi
    echo ""
    echo "   Note: Gradual rollout is applied to user-facing workers only."
    echo "   ar-lib-core and ar-router are deployed directly to 100%."
    echo ""
fi

FAILED_PACKAGES=()

# ar-router may bind UI Workers while the final UI Workers bind back to the
# router. Create only missing binding targets to break that first-deploy cycle.
if ! pnpm exec tsx scripts/deploy-ui.ts \
    --env="$DEPLOY_ENV" \
    "${KEYS_DIR_ARGS[@]}" \
    --phase=binding-targets-if-missing; then
    echo "❌ Failed to prepare UI Worker binding targets"
    FAILED_PACKAGES+=("UI Worker binding targets")
fi

if [ ${#FAILED_PACKAGES[@]} -eq 0 ] && [ "$GRADUAL_ROLLOUT" = false ]; then
    export AUTHRIM_DEPLOY_UUID="$VERSION_UUID"
    export AUTHRIM_DEPLOY_TIME="$DEPLOY_TIME"
    if ! pnpm exec tsx scripts/deploy-api.ts --env="$DEPLOY_ENV" --mode=auto --concurrency=2 "${KEYS_DIR_ARGS[@]}"; then
        FAILED_PACKAGES+=("dependency-aware API deployment")
    fi
elif [ ${#FAILED_PACKAGES[@]} -eq 0 ]; then
    for pkg in "${PACKAGES[@]}"; do
        IFS=':' read -r name path <<< "$pkg"

        if [ "$name" = "ar-router" ]; then
            if [ ! -f "$path/wrangler.toml" ] || ! grep -q "\\[env\\.${DEPLOY_ENV}\\]" "$path/wrangler.toml" 2>/dev/null; then
                echo "❌ ar-router is missing wrangler.toml or [env.${DEPLOY_ENV}] section"
                FAILED_PACKAGES+=("$name")
                break
            fi
        fi

        if [ "$name" != "ar-lib-core" ] && [ "$name" != "ar-router" ]; then
            if ! deploy_package_gradual "$name" "$path" "$ISSUER_URL"; then
                FAILED_PACKAGES+=("$name")
                echo ""
                echo "❌ Gradual rollout failed for $name. Stopping deployment."
                echo "   Previous packages may have been deployed."
                break
            fi
        elif ! deploy_package "$name" "$path"; then
            FAILED_PACKAGES+=("$name")
        fi
        echo ""
    done
fi

if [ ${#FAILED_PACKAGES[@]} -eq 0 ] && [ "$GRADUAL_ROLLOUT" = true ]; then
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "🧹 Finalizing legacy static secret cleanup"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    FINALIZE_ARGS=(
        "--env=${DEPLOY_ENV}"
        "--concurrency=2"
        "--finalize-legacy-static-secret-cleanup"
    )
    if [ -n "$ISSUER_URL" ]; then
        FINALIZE_ARGS+=("--health-url=${ISSUER_URL}")
    fi
    if ! pnpm exec tsx scripts/deploy-api.ts "${FINALIZE_ARGS[@]}"; then
        FAILED_PACKAGES+=("legacy static secret cleanup")
    fi
    echo ""
fi

# Summary
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📊 Deployment Summary"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if [ ${#FAILED_PACKAGES[@]} -eq 0 ]; then
    echo "✅ All packages deployed successfully!"
    echo ""

    # Post-deployment endpoint display is best-effort.
    set +e

    # Get ISSUER_URL
    # Priority: 1. .authrim/{env}/config.json, 2. wrangler.toml [env.xxx.vars]
    ISSUER_URL=""

    # Get ISSUER_URL
    if type get_issuer_url &>/dev/null; then
        ISSUER_URL=$(get_issuer_url "$DEPLOY_ENV" 2>/dev/null)
    else
        if [ -f "packages/ar-discovery/wrangler.toml" ]; then
            ISSUER_URL=$(grep -A 100 "\\[env\\.${DEPLOY_ENV}\\.vars\\]" "packages/ar-discovery/wrangler.toml" 2>/dev/null | grep 'ISSUER_URL = ' | head -1 | sed 's/.*ISSUER_URL = "\(.*\)"/\1/')
        fi
    fi
    # Validate URL before use (security: prevent command injection)
    if [ -n "$ISSUER_URL" ] && ! validate_url "$ISSUER_URL"; then
        echo "⚠️  ISSUER_URL validation failed. Skipping endpoint display."
        ISSUER_URL=""
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
        echo "  • PAR (Pushed AuthZ):    $ISSUER_URL/par"
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
