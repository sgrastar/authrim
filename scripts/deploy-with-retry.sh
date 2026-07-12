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
VERSIONED_WORKERS=(
    "ar-auth"
    "ar-token"
    "ar-management"
    "ar-userinfo"
    "ar-async"
    "ar-discovery"
    "ar-policy"
    "ar-saml"
    "ar-bridge"
    "ar-vc"
)

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

# Register version in VersionManager DO after deployment
register_versions() {
    local issuer_url=$1
    local admin_secret=$2
    local max_retries=8
    local retry_delay=5

    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "📝 Registering versions in VersionManager DO"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

    local success_count=0
    local fail_count=0
    local skip_count=0

    for worker in "${VERSIONED_WORKERS[@]}"; do
        echo -n "  • Registering $worker... "

        local attempt=1
        local registered=false

        while [ $attempt -le $max_retries ] && [ "$registered" = false ]; do
            local response=$(curl -s -w "\n%{http_code}" -X POST "${issuer_url}/api/internal/versions/${worker}" \
                -H "Authorization: Bearer ${admin_secret}" \
                -H "Content-Type: application/json" \
                -d "{\"uuid\":\"${VERSION_UUID}\",\"deployTime\":\"${DEPLOY_TIME}\"}" \
                --connect-timeout 10 \
                --max-time 30 2>/dev/null)

            local http_code=$(echo "$response" | tail -n1)
            local body=$(echo "$response" | sed '$d')

            if [ "$http_code" = "200" ] || [ "$http_code" = "201" ]; then
                echo "✅"
                ((success_count++))
                registered=true
            elif [ "$http_code" = "000" ] || [ "$http_code" = "502" ] || [ "$http_code" = "503" ] || [ "$http_code" = "504" ]; then
                # Connection error or service unavailable - retry
                if [ $attempt -lt $max_retries ]; then
                    echo -n "⏳ (retry $attempt/$max_retries)... "
                    sleep $retry_delay
                    ((attempt++))
                else
                    echo "⏭️  (skipped - service not ready)"
                    ((skip_count++))
                    registered=true  # Exit retry loop
                fi
            elif [ "$http_code" = "404" ]; then
                # Endpoint not found - first deploy or route not configured
                echo "⏭️  (skipped - endpoint not available yet)"
                ((skip_count++))
                registered=true  # Exit retry loop
            else
                # Other error - don't retry
                echo "⚠️  (HTTP $http_code - non-critical)"
                ((fail_count++))
                registered=true  # Exit retry loop
            fi
        done
    done

    echo ""
    if [ $success_count -gt 0 ]; then
        echo "   ✅ Registered: $success_count/${#VERSIONED_WORKERS[@]} workers"
    fi
    if [ $skip_count -gt 0 ]; then
        echo "   ⏭️  Skipped: $skip_count (first deploy or service not ready)"
    fi
    if [ $fail_count -gt 0 ]; then
        echo "   ⚠️  Failed: $fail_count (non-critical - workers will continue)"
    fi
    echo ""
    echo "   💡 Note: Version registration is required for PoP cache forcing. This script fails if any worker is not registered."

    # Bubble up a failure when not all workers were registered so deployers notice immediately
    if [ $success_count -lt ${#VERSIONED_WORKERS[@]} ]; then
        return 1
    fi

    return 0
}

verify_versions_registered() {
    local issuer_url=$1
    local admin_secret=$2
    local expected_uuid=$3
    local max_retries=5
    local retry_delay=5

    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "🔎 Verifying VersionManager entries"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

    local attempt=1
    while [ $attempt -le $max_retries ]; do
        local response=$(
            curl -s -w "\n%{http_code}" -X GET "${issuer_url}/api/internal/version-manager/status" \
                -H "Authorization: Bearer ${admin_secret}" \
                --connect-timeout 10 \
                --max-time 30 2>/dev/null
        )

        local http_code=$(echo "$response" | tail -n1)
        local body=$(echo "$response" | sed '$d')

        if [ "$http_code" = "200" ]; then
            local missing=()
            local mismatched=()

            for worker in "${VERSIONED_WORKERS[@]}"; do
                local worker_uuid
                worker_uuid=$(echo "$body" | jq -r --arg w "$worker" '.versions[$w].uuid // empty')

                if [ -z "$worker_uuid" ]; then
                    missing+=("$worker")
                elif [ "$worker_uuid" != "$expected_uuid" ]; then
                    mismatched+=("$worker ($worker_uuid)")
                fi
            done

            if [ ${#missing[@]} -eq 0 ] && [ ${#mismatched[@]} -eq 0 ]; then
                echo "✅ VersionManager reports expected UUID for all workers"
                return 0
            fi

            if [ ${#missing[@]} -gt 0 ]; then
                echo "⚠️  Missing entries: ${missing[*]}"
            fi
            if [ ${#mismatched[@]} -gt 0 ]; then
                echo "⚠️  Mismatched UUIDs: ${mismatched[*]}"
            fi
        else
            echo "⚠️  Version status check failed (HTTP ${http_code})"
        fi

        if [ $attempt -lt $max_retries ]; then
            echo "   Retrying in ${retry_delay}s..."
            sleep $retry_delay
        fi

        ((attempt++))
    done

    echo "❌ VersionManager verification failed after retries"
    return 1
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

# Summary
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📊 Deployment Summary"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if [ ${#FAILED_PACKAGES[@]} -eq 0 ]; then
    echo "✅ All packages deployed successfully!"
    echo ""

    # Post-deployment steps are best-effort.
    # Disable set -e so that non-critical failures (JWKS fetch, secret update)
    # do not cause the deployment to report as failed.
    set +e

    # Get ISSUER_URL and ADMIN_API_SECRET
    # Priority: 1. .authrim/{env}/config.json, 2. wrangler.toml [env.xxx.vars]
    ISSUER_URL=""
    ADMIN_API_SECRET=""

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
        echo "⚠️  ISSUER_URL validation failed. Skipping version registration and endpoint display."
        ISSUER_URL=""
    fi

    # Get ADMIN_API_SECRET (from keys directory or wrangler.toml)
    if [ -n "$KEYS_DIR_OVERRIDE" ]; then
        KEYS_DIR="$KEYS_DIR_OVERRIDE"
    elif type find_keys_dir &>/dev/null; then
        KEYS_DIR=$(find_keys_dir "$DEPLOY_ENV" 2>/dev/null)
    fi
    if [ -n "${KEYS_DIR:-}" ] && [ -f "${KEYS_DIR}/admin_api_secret.txt" ]; then
        ADMIN_API_SECRET=$(cat "${KEYS_DIR}/admin_api_secret.txt" 2>/dev/null)
    fi
    # Fallback to wrangler.toml
    if [ -z "$ADMIN_API_SECRET" ] && [ -f "packages/ar-management/wrangler.toml" ]; then
        ADMIN_API_SECRET=$(grep -A 100 "\\[env\\.${DEPLOY_ENV}\\.vars\\]" "packages/ar-management/wrangler.toml" 2>/dev/null | grep 'ADMIN_API_SECRET = ' | head -1 | sed 's/.*ADMIN_API_SECRET = "\(.*\)"/\1/')
        # Fallback to KEY_MANAGER_SECRET if ADMIN_API_SECRET not found
        if [ -z "$ADMIN_API_SECRET" ]; then
            ADMIN_API_SECRET=$(grep -A 100 "\\[env\\.${DEPLOY_ENV}\\.vars\\]" "packages/ar-management/wrangler.toml" 2>/dev/null | grep 'KEY_MANAGER_SECRET = ' | head -1 | sed 's/.*KEY_MANAGER_SECRET = "\(.*\)"/\1/')
        fi
    fi

    # Register versions in VersionManager DO
    # NOTE: VersionManager is deprecated. versionCheckMiddleware has been removed from all Workers.
    # Cloudflare Versions Deploy (--gradual) is used instead. These calls are kept for reference only.
    # if [ -n "$ISSUER_URL" ] && [ -n "$ADMIN_API_SECRET" ]; then
    #     # Wait a moment for workers to be fully available
    #     echo "⏳ Waiting 15 seconds for workers to be available..."
    #     sleep 15
    #     register_versions "$ISSUER_URL" "$ADMIN_API_SECRET"
    #     verify_versions_registered "$ISSUER_URL" "$ADMIN_API_SECRET" "$VERSION_UUID"
    # else
    #     echo "⚠️  Skipping version registration: ISSUER_URL or ADMIN_API_SECRET not found"
    # fi

    # Set PUBLIC_JWK_JSON secret for workers that need JWT verification
    # This ensures tokens can be verified even when KeyManager DO is slow
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "🔑 Setting PUBLIC_JWK_JSON secret for workers"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    if [ -n "$ISSUER_URL" ]; then
        echo "   Fetching JWKS from ${ISSUER_URL}/.well-known/jwks.json..."
        JWKS=$(curl -s "${ISSUER_URL}/.well-known/jwks.json" --connect-timeout 10 --max-time 30 2>/dev/null)
        if [ -n "$JWKS" ] && echo "$JWKS" | jq -e '.keys' > /dev/null 2>&1; then
            # Extract the most recent (active) key from JWKS
            ACTIVE_KEY=$(echo "$JWKS" | jq -c '.keys | last')
            if [ -n "$ACTIVE_KEY" ] && [ "$ACTIVE_KEY" != "null" ]; then
                ACTIVE_KID=$(echo "$ACTIVE_KEY" | jq -r '.kid')
                echo "   Active key: $ACTIVE_KID"

                LOCAL_KID=""
                if [ -n "${KEYS_DIR:-}" ] && [ -f "${KEYS_DIR}/public.jwk.json" ]; then
                    LOCAL_KID=$(jq -r '.kid // empty' "${KEYS_DIR}/public.jwk.json" 2>/dev/null)
                fi

                if [ -n "$LOCAL_KID" ] && [ "$LOCAL_KID" = "$ACTIVE_KID" ]; then
                    echo "   ✅ Active key already shipped with the Worker versions; no extra secret deployment needed."
                else
                    JWK_SECRET_FILE=$(mktemp)
                    jq -n --arg value "$ACTIVE_KEY" '{PUBLIC_JWK_JSON: $value}' > "$JWK_SECRET_FILE"

                    # Workers that need PUBLIC_JWK_JSON. secret bulk performs one
                    # mutation per Worker instead of an interactive secret put.
                    WORKERS_NEEDING_JWK=("ar-discovery" "ar-auth" "ar-token" "ar-userinfo" "ar-management" "ar-vc")

                    for worker in "${WORKERS_NEEDING_JWK[@]}"; do
                        WORKER_NAME="${DEPLOY_ENV}-${worker}"
                        echo "   Setting PUBLIC_JWK_JSON for ${worker}..."
                        if pnpm exec wrangler secret bulk "$JWK_SECRET_FILE" --name "$WORKER_NAME" 2>/dev/null; then
                            echo "   ✅ ${worker}: Updated"
                        else
                            echo "   ⚠️  ${worker}: Skipped (may not exist or already set)"
                        fi
                    done
                    rm -f "$JWK_SECRET_FILE"
                fi
            else
                echo "   ⚠️  Could not extract active key from JWKS"
            fi
        else
            echo "   ⚠️  Could not fetch valid JWKS from ${ISSUER_URL}/.well-known/jwks.json"
            echo "   💡 You may need to manually set PUBLIC_JWK_JSON after deployment"
        fi
    else
        echo "   ⚠️  Skipping: ISSUER_URL not configured"
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
