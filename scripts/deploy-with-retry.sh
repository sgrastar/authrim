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
VERSIONED_WORKERS=(
    "op-auth"
    "op-token"
    "op-management"
    "op-userinfo"
    "op-async"
    "op-discovery"
    "policy-service"
    "op-saml"
    "external-idp"
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
            local response=$(curl -s -w "\n%{http_code}" -X POST "${issuer_url}/api/internal/version/${worker}" \
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
        if [ "$package_name" = "router" ]; then
            continue
        fi

        # Skip UI package
        if [ "$package_name" = "ui" ]; then
            continue
        fi

        # Skip library packages (not deployable workers)
        if [ "$package_name" = "policy-core" ] || [ "$package_name" = "scim" ]; then
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
    "shared:packages/shared"
    "op-discovery:packages/op-discovery"
    "op-management:packages/op-management"
    "op-auth:packages/op-auth"
    "op-token:packages/op-token"
    "op-userinfo:packages/op-userinfo"
    "op-async:packages/op-async"
    "policy-service:packages/policy-service"
    "op-saml:packages/op-saml"
    "external-idp:packages/external-idp"
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
        echo "⏳ Waiting 15 seconds for workers to be available..."
        sleep 15
        register_versions "$ISSUER_URL" "$ADMIN_API_SECRET"
        verify_versions_registered "$ISSUER_URL" "$ADMIN_API_SECRET" "$VERSION_UUID"
    else
        echo "⚠️  Skipping version registration: ISSUER_URL or ADMIN_API_SECRET not found"
    fi

    # Set PUBLIC_JWK_JSON secret for op-token worker (DO bypass optimization)
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "🔑 Setting PUBLIC_JWK_JSON secret for op-token"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    if [ -n "$ISSUER_URL" ]; then
        echo "   Fetching JWKS from ${ISSUER_URL}/.well-known/jwks.json..."
        JWKS=$(curl -s "${ISSUER_URL}/.well-known/jwks.json" --connect-timeout 10 --max-time 30 2>/dev/null)
        if [ -n "$JWKS" ] && echo "$JWKS" | jq -e '.keys' > /dev/null 2>&1; then
            echo "   Setting PUBLIC_JWK_JSON secret..."
            # Skip this step - wrangler secret put can hang waiting for interactive input
            # The secret is only needed for DO bypass optimization and is not critical
            echo "   ⏭️  Skipped (manual setup recommended if needed)"
            echo "   💡 To set manually: echo '\$JWKS' | wrangler secret put PUBLIC_JWK_JSON --name ${DEPLOY_ENV}-authrim-op-token"
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
