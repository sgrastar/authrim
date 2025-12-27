#!/bin/bash

# Deployment script for Cloudflare Workers
#
# This script deploys workers SEQUENTIALLY with delays to avoid:
# - Cloudflare API rate limits (1,200 requests per 5 minutes)
# - Service unavailable errors (code 7010) from concurrent deployments
# - API overload from parallel deployments
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

# Trap Ctrl+C and other signals to ensure clean exit
trap 'echo ""; echo "⚠️  Deployment cancelled by user"; exit 130' INT TERM

INTER_DEPLOY_DELAY=5     # Delay between deployments to avoid rate limits
DEPLOY_ENV=""
API_ONLY=false
GRADUAL_ROLLOUT=false
GRADUAL_STAGES="10,50,100"    # Default gradual rollout stages (percentage)
GRADUAL_WAIT=3                 # Wait time between stages in minutes
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

# Health check function for gradual rollout
# Checks OIDC Discovery endpoint and optionally API version header
perform_health_check() {
    local issuer_url=$1
    local expected_version=$2
    local max_retries=3
    local retry_delay=10

    echo "   🔎 Performing health check..."

    local attempt=1
    while [ $attempt -le $max_retries ]; do
        # Check OIDC Discovery endpoint
        local response=$(curl -s -w "\n%{http_code}" \
            "${issuer_url}/.well-known/openid-configuration" \
            --connect-timeout 10 \
            --max-time 30 2>/dev/null)

        local http_code=$(echo "$response" | tail -n1)
        local body=$(echo "$response" | sed '$d')

        if [ "$http_code" = "200" ]; then
            # Verify issuer matches
            local issuer=$(echo "$body" | jq -r '.issuer // empty')
            if [ -n "$issuer" ]; then
                echo "   ✅ OIDC Discovery: OK (issuer: $issuer)"

                # Optionally check API version header
                local version_response=$(curl -s -I \
                    "${issuer_url}/api/admin/health" \
                    -H "Authrim-Version: ${expected_version}" \
                    --connect-timeout 10 \
                    --max-time 30 2>/dev/null)

                local api_version=$(echo "$version_response" | grep -i "X-Authrim-Version:" | awk '{print $2}' | tr -d '\r')
                if [ -n "$api_version" ]; then
                    echo "   ✅ API Version: ${api_version}"
                fi

                return 0
            fi
        fi

        if [ $attempt -lt $max_retries ]; then
            echo "   ⏳ Health check failed (attempt $attempt/$max_retries), retrying in ${retry_delay}s..."
            sleep $retry_delay
        fi
        ((attempt++))
    done

    echo "   ❌ Health check failed after $max_retries attempts"
    return 1
}

# Rollback function for gradual rollout
perform_rollback() {
    local worker_name=$1
    local package_path=$2

    echo "   🔄 Rolling back ${worker_name}..."

    if (cd "$package_path" && pnpm exec wrangler rollback --config "wrangler.${DEPLOY_ENV}.toml" 2>/dev/null); then
        echo "   ✅ Rollback successful for ${worker_name}"
        return 0
    else
        echo "   ❌ Rollback failed for ${worker_name}"
        return 1
    fi
}

# Gradual deploy function - deploys to a percentage of traffic
deploy_gradual_stage() {
    local package_name=$1
    local package_path=$2
    local percentage=$3
    local worker_name="${DEPLOY_ENV}-${package_name}"

    echo "   📊 Deploying to ${percentage}% of traffic..."

    # Build the deploy command
    local deploy_cmd="pnpm exec wrangler deploy --config wrangler.${DEPLOY_ENV}.toml"

    # Add version vars for non-shared packages
    if [ "$package_name" != "ar-lib-core" ] && [ "$package_name" != "ar-router" ]; then
        deploy_cmd="$deploy_cmd --var CODE_VERSION_UUID:${VERSION_UUID} --var DEPLOY_TIME_UTC:${DEPLOY_TIME}"
    fi

    # First deployment creates a new version
    if (cd "$package_path" && eval "$deploy_cmd"); then
        if [ "$percentage" -lt 100 ]; then
            # Use wrangler versions deploy to set percentage
            # Note: This requires the version to be created first
            echo "   📈 Setting traffic split to ${percentage}%..."
            if (cd "$package_path" && pnpm exec wrangler versions deploy --percentage "${percentage}" --config "wrangler.${DEPLOY_ENV}.toml" 2>/dev/null); then
                echo "   ✅ Traffic split set to ${percentage}%"
                return 0
            else
                # Fallback: Cloudflare may not support percentage for all worker types
                echo "   ⚠️  Traffic split not available, deployed to 100%"
                return 0
            fi
        else
            echo "   ✅ Deployed to 100%"
            return 0
        fi
    else
        local exit_code=$?
        echo "   ❌ Deploy failed (exit code: $exit_code)"
        return $exit_code
    fi
}

# Deploy package with gradual rollout stages
deploy_package_gradual() {
    local package_name=$1
    local package_path=$2
    local issuer_url=$3

    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "📦 Deploying (Gradual): $package_name"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

    # Parse stages from comma-separated list
    IFS=',' read -ra STAGES <<< "$GRADUAL_STAGES"

    for stage in "${STAGES[@]}"; do
        echo ""
        echo "   ▶ Stage: ${stage}%"

        # Deploy to this percentage
        if ! deploy_gradual_stage "$package_name" "$package_path" "$stage"; then
            echo "   ❌ Deployment failed at ${stage}%"
            perform_rollback "$package_name" "$package_path"
            return 1
        fi

        # Skip health check and wait for 100% stage (final)
        if [ "$stage" -lt 100 ]; then
            # Wait before health check
            echo "   ⏳ Waiting 30s for deployment to stabilize..."
            sleep 30

            # Perform health check if issuer_url is available
            if [ -n "$issuer_url" ]; then
                if ! perform_health_check "$issuer_url" ""; then
                    echo "   ⚠️  Health check failed at ${stage}%, initiating rollback..."
                    perform_rollback "$package_name" "$package_path"
                    return 1
                fi
            fi

            # Wait between stages
            echo "   ⏳ Waiting ${GRADUAL_WAIT} minutes before next stage..."
            sleep $((GRADUAL_WAIT * 60))
        fi
    done

    echo "✅ Successfully deployed: $package_name (gradual rollout complete)"
    return 0
}

deploy_package() {
    local package_name=$1
    local package_path=$2

    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "📦 Deploying: $package_name"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

    # Build the pnpm exec wrangler deploy command with version vars
    local deploy_cmd="pnpm exec wrangler deploy --config wrangler.${DEPLOY_ENV}.toml"

    # Add version vars for non-shared packages (workers that use version check)
    if [ "$package_name" != "ar-lib-core" ] && [ "$package_name" != "ar-router" ]; then
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

# Validation: Check for environment-specific wrangler config files
echo "🔍 Validating configuration..."
MISSING_CONFIG=false
PLACEHOLDER_FOUND=false

for pkg_dir in packages/*/; do
    if [ -d "$pkg_dir" ]; then
        package_name=$(basename "$pkg_dir")
        toml_file="${pkg_dir}wrangler.${DEPLOY_ENV}.toml"

        # Skip router if not needed
        if [ "$package_name" = "ar-router" ]; then
            continue
        fi

        # Skip UI package
        if [ "$package_name" = "ar-ui" ]; then
            continue
        fi

        # Skip library packages (not deployable workers)
        # ar-lib-core is special - it contains Durable Objects and IS deployed
        if [[ "$package_name" == ar-lib-* && "$package_name" != "ar-lib-core" ]]; then
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
    "ar-discovery:packages/ar-discovery"
    "ar-management:packages/ar-management"
    "ar-auth:packages/ar-auth"
    "ar-token:packages/ar-token"
    "ar-userinfo:packages/ar-userinfo"
    "ar-async:packages/ar-async"
    "ar-policy:packages/ar-policy"
    "ar-saml:packages/ar-saml"
    "ar-bridge:packages/ar-bridge"
    "ar-vc:packages/ar-vc"
    "ar-router:packages/ar-router"
)

# Get ISSUER_URL early for health checks during gradual rollout
ISSUER_URL=""
if [ -f "packages/ar-discovery/wrangler.${DEPLOY_ENV}.toml" ]; then
    ISSUER_URL=$(grep 'ISSUER_URL = ' "packages/ar-discovery/wrangler.${DEPLOY_ENV}.toml" | head -1 | sed 's/.*ISSUER_URL = "\(.*\)"/\1/')
    # Validate URL before use (security: prevent command injection)
    if [ -n "$ISSUER_URL" ] && ! validate_url "$ISSUER_URL"; then
        echo "⚠️  ISSUER_URL validation failed. Health checks will be skipped."
        ISSUER_URL=""
    fi
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
FIRST_DEPLOY=true

for pkg in "${PACKAGES[@]}"; do
    IFS=':' read -r name path <<< "$pkg"

    # Skip router if environment-specific wrangler config doesn't exist
    if [ "$name" = "ar-router" ] && [ ! -f "$path/wrangler.${DEPLOY_ENV}.toml" ]; then
        echo "⊗ Skipping ar-router (wrangler.${DEPLOY_ENV}.toml not found - not needed when using custom domains)"
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

    # Use gradual rollout for user-facing workers (not for shared/router packages)
    if [ "$GRADUAL_ROLLOUT" = true ] && [ "$name" != "ar-lib-core" ] && [ "$name" != "ar-router" ]; then
        if ! deploy_package_gradual "$name" "$path" "$ISSUER_URL"; then
            FAILED_PACKAGES+=("$name")
            # On gradual rollout failure, stop deployment
            echo ""
            echo "❌ Gradual rollout failed for $name. Stopping deployment."
            echo "   Previous packages may have been deployed."
            echo "   Run ./scripts/rollback-all.sh --env=$DEPLOY_ENV to rollback all."
            break
        fi
    else
        if ! deploy_package "$name" "$path"; then
            FAILED_PACKAGES+=("$name")
        fi
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
    if [ -f "packages/ar-discovery/wrangler.${DEPLOY_ENV}.toml" ]; then
        ISSUER_URL=$(grep 'ISSUER_URL = ' "packages/ar-discovery/wrangler.${DEPLOY_ENV}.toml" | head -1 | sed 's/.*ISSUER_URL = "\(.*\)"/\1/')
        # Validate URL before use (security: prevent command injection)
        if [ -n "$ISSUER_URL" ] && ! validate_url "$ISSUER_URL"; then
            echo "⚠️  ISSUER_URL validation failed. Skipping version registration and endpoint display."
            ISSUER_URL=""
        fi
    fi
    if [ -f "packages/ar-management/wrangler.${DEPLOY_ENV}.toml" ]; then
        ADMIN_API_SECRET=$(grep 'ADMIN_API_SECRET = ' "packages/ar-management/wrangler.${DEPLOY_ENV}.toml" | head -1 | sed 's/.*ADMIN_API_SECRET = "\(.*\)"/\1/')
        # Fallback to KEY_MANAGER_SECRET if ADMIN_API_SECRET not found
        if [ -z "$ADMIN_API_SECRET" ]; then
            ADMIN_API_SECRET=$(grep 'KEY_MANAGER_SECRET = ' "packages/ar-management/wrangler.${DEPLOY_ENV}.toml" | head -1 | sed 's/.*KEY_MANAGER_SECRET = "\(.*\)"/\1/')
        fi
    fi

    # Register versions in VersionManager DO
    if [ -n "$ISSUER_URL" ] && [ -n "$ADMIN_API_SECRET" ]; then
        # Wait a moment for workers to be fully available
        echo "⏳ Waiting 15 seconds for workers to be available..."
        sleep 15
        register_versions "$ISSUER_URL" "$ADMIN_API_SECRET"
        verify_versions_registered "$ISSUER_URL" "$ADMIN_API_SECRET" "$VERSION_UUID"
    else
        echo "⚠️  Skipping version registration: ISSUER_URL or ADMIN_API_SECRET not found"
    fi

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

                # Workers that need PUBLIC_JWK_JSON
                WORKERS_NEEDING_JWK=("ar-token" "ar-management" "ar-userinfo" "ar-auth")

                for worker in "${WORKERS_NEEDING_JWK[@]}"; do
                    WORKER_NAME="${DEPLOY_ENV}-${worker}"
                    echo "   Setting PUBLIC_JWK_JSON for ${worker}..."
                    # Use printf with pipe to avoid interactive input issues
                    if printf '%s' "$ACTIVE_KEY" | wrangler secret put PUBLIC_JWK_JSON --name "$WORKER_NAME" 2>/dev/null; then
                        echo "   ✅ ${worker}: Updated"
                    else
                        echo "   ⚠️  ${worker}: Skipped (may not exist or already set)"
                    fi
                done
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
