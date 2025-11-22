#!/bin/bash
#
# Authrim Local wrangler.toml Generation Script
# Generates wrangler.toml files for local development with localhost ISSUER_URL
#
# Usage:
#   ./setup-local-wrangler.sh --env=dev
#   ./setup-local-wrangler.sh --env=staging
#

set -e

# Color codes
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Parse command line arguments
DEPLOY_ENV="dev"

for arg in "$@"; do
    if [[ $arg == --env=* ]]; then
        DEPLOY_ENV="${arg#--env=}"
    fi
done

echo -e "${BLUE}🔨 Authrim Local wrangler.toml Generation - Environment: $DEPLOY_ENV${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Check if keys exist to get KEY_ID
if [ ! -f ".keys/metadata.json" ]; then
    echo -e "${RED}❌ Error: Key metadata not found${NC}"
    echo ""
    echo "Please run setup-keys.sh first:"
    echo "  ./scripts/setup-keys.sh"
    echo ""
    exit 1
fi

KEY_ID=$(cat .keys/metadata.json | jq -r '.kid' 2>/dev/null || echo "")
if [ -z "$KEY_ID" ]; then
    echo -e "${RED}❌ Error: Could not extract KEY_ID from metadata${NC}"
    exit 1
fi

echo "📦 Key Information:"
echo "   Key ID: $KEY_ID"
echo ""

# Function to generate wrangler.toml for a worker
generate_wrangler_toml() {
    local package=$1
    local port=$2
    local kv_namespaces=$3
    local do_bindings=$4

    local file="packages/$package/wrangler.${DEPLOY_ENV}.toml"

    # Check if file already exists
    if [ -f "$file" ]; then
        echo "  ⚠️  $file already exists"
        read -p "    Overwrite? This will reset KV IDs and D1 bindings (y/N): " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            echo "    ⊗ Skipping $package (keeping existing configuration)"
            return
        fi
        echo "    ✓ Overwriting $package/wrangler.${DEPLOY_ENV}.toml"
    fi

    cat > "$file" << TOML_EOF
name = "${DEPLOY_ENV}-authrim-$package"
main = "src/index.ts"
compatibility_date = "2024-09-23"
compatibility_flags = ["nodejs_compat"]
workers_dev = true
preview_urls = true

# KV Namespaces
$kv_namespaces

# Durable Objects Bindings
$do_bindings

# Environment variables
[vars]
ISSUER_URL = "http://localhost:8787"
TOKEN_EXPIRY = "3600"
CODE_EXPIRY = "120"
STATE_EXPIRY = "300"
NONCE_EXPIRY = "300"
REFRESH_TOKEN_EXPIRY = "2592000"
KEY_ID = "$KEY_ID"
ALLOW_HTTP_REDIRECT = "true"
OPEN_REGISTRATION = "true"
TRUSTED_DOMAINS = "www.certification.openid.net"

# Development configuration
[dev]
port = $port
TOML_EOF

    echo "  ✅ $package/wrangler.${DEPLOY_ENV}.toml"
}

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📝 Generating wrangler.toml files..."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Generate wrangler.toml for shared package (Durable Objects)
SHARED_FILE="packages/shared/wrangler.${DEPLOY_ENV}.toml"
if [ -f "$SHARED_FILE" ]; then
    echo "  ⚠️  $SHARED_FILE already exists"
    read -p "    Overwrite? This will reset Durable Objects configuration (y/N): " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "    ⊗ Skipping shared (keeping existing configuration)"
    else
        echo "    ✓ Overwriting shared/wrangler.${DEPLOY_ENV}.toml"
        cat > "packages/shared/wrangler.${DEPLOY_ENV}.toml" << SHARED_TOML_EOF
name = "${DEPLOY_ENV}-authrim-shared"
main = "src/durable-objects/index.ts"
compatibility_date = "2024-09-23"
compatibility_flags = ["nodejs_compat"]

# Durable Objects definitions
[[durable_objects.bindings]]
name = "SESSION_STORE"
class_name = "SessionStore"

[[durable_objects.bindings]]
name = "AUTH_CODE_STORE"
class_name = "AuthorizationCodeStore"

[[durable_objects.bindings]]
name = "REFRESH_TOKEN_ROTATOR"
class_name = "RefreshTokenRotator"

[[durable_objects.bindings]]
name = "KEY_MANAGER"
class_name = "KeyManager"

[[durable_objects.bindings]]
name = "CHALLENGE_STORE"
class_name = "ChallengeStore"

[[durable_objects.bindings]]
name = "RATE_LIMITER"
class_name = "RateLimiterCounter"

[[durable_objects.bindings]]
name = "PAR_REQUEST_STORE"
class_name = "PARRequestStore"

[[durable_objects.bindings]]
name = "DPOP_JTI_STORE"
class_name = "DPoPJTIStore"

# Durable Objects migrations
[[migrations]]
tag = "v1"
new_sqlite_classes = [
  "SessionStore",
  "AuthorizationCodeStore",
  "RefreshTokenRotator",
  "KeyManager",
  "ChallengeStore",
  "RateLimiterCounter",
  "PARRequestStore",
  "DPoPJTIStore"
]

[[migrations]]
tag = "v2"
# Empty migration to match production state
# Keeps existing Durable Objects intact

[[migrations]]
tag = "v3"
new_sqlite_classes = ["RateLimiterCounter", "PARRequestStore", "DPoPJTIStore"]

# Environment variables
[vars]
KEY_MANAGER_SECRET = "dev-secret-change-in-production"
SHARED_TOML_EOF
        echo "  ✅ shared/wrangler.${DEPLOY_ENV}.toml (Durable Objects)"
    fi
else
    echo "  ✅ shared/wrangler.${DEPLOY_ENV}.toml (Durable Objects)"
    cat > "packages/shared/wrangler.${DEPLOY_ENV}.toml" << SHARED_TOML_EOF
name = "${DEPLOY_ENV}-authrim-shared"
main = "src/durable-objects/index.ts"
compatibility_date = "2024-09-23"
compatibility_flags = ["nodejs_compat"]

# Durable Objects definitions
[[durable_objects.bindings]]
name = "SESSION_STORE"
class_name = "SessionStore"

[[durable_objects.bindings]]
name = "AUTH_CODE_STORE"
class_name = "AuthorizationCodeStore"

[[durable_objects.bindings]]
name = "REFRESH_TOKEN_ROTATOR"
class_name = "RefreshTokenRotator"

[[durable_objects.bindings]]
name = "KEY_MANAGER"
class_name = "KeyManager"

[[durable_objects.bindings]]
name = "CHALLENGE_STORE"
class_name = "ChallengeStore"

[[durable_objects.bindings]]
name = "RATE_LIMITER"
class_name = "RateLimiterCounter"

[[durable_objects.bindings]]
name = "PAR_REQUEST_STORE"
class_name = "PARRequestStore"

[[durable_objects.bindings]]
name = "DPOP_JTI_STORE"
class_name = "DPoPJTIStore"

# Durable Objects migrations
[[migrations]]
tag = "v1"
new_sqlite_classes = [
  "SessionStore",
  "AuthorizationCodeStore",
  "RefreshTokenRotator",
  "KeyManager",
  "ChallengeStore",
  "RateLimiterCounter",
  "PARRequestStore",
  "DPoPJTIStore"
]

[[migrations]]
tag = "v2"
# Empty migration to match production state
# Keeps existing Durable Objects intact

[[migrations]]
tag = "v3"
new_sqlite_classes = ["RateLimiterCounter", "PARRequestStore", "DPoPJTIStore"]

# Environment variables
[vars]
KEY_MANAGER_SECRET = "dev-secret-change-in-production"
SHARED_TOML_EOF
fi

echo ""

# Generate wrangler.toml for op-discovery
generate_wrangler_toml "op-discovery" 8787 '' '[[durable_objects.bindings]]
name = "KEY_MANAGER"
class_name = "KeyManager"
script_name = "${DEPLOY_ENV}-authrim-shared"

[[durable_objects.bindings]]
name = "RATE_LIMITER"
class_name = "RateLimiterCounter"
script_name = "${DEPLOY_ENV}-authrim-shared"'

# Generate wrangler.toml for op-auth
generate_wrangler_toml "op-auth" 8788 '[[kv_namespaces]]
binding = "CLIENTS"
id = "placeholder"
preview_id = "placeholder"

# D1 Database
[[d1_databases]]
binding = "DB"
database_name = "authrim-users-db"
database_id = "placeholder"

# R2 Bucket
[[r2_buckets]]
binding = "AVATARS"
bucket_name = "authrim-avatars"' '[[durable_objects.bindings]]
name = "KEY_MANAGER"
class_name = "KeyManager"
script_name = "${DEPLOY_ENV}-authrim-shared"

[[durable_objects.bindings]]
name = "SESSION_STORE"
class_name = "SessionStore"
script_name = "${DEPLOY_ENV}-authrim-shared"

[[durable_objects.bindings]]
name = "AUTH_CODE_STORE"
class_name = "AuthorizationCodeStore"
script_name = "${DEPLOY_ENV}-authrim-shared"

[[durable_objects.bindings]]
name = "CHALLENGE_STORE"
class_name = "ChallengeStore"
script_name = "${DEPLOY_ENV}-authrim-shared"

[[durable_objects.bindings]]
name = "RATE_LIMITER"
class_name = "RateLimiterCounter"
script_name = "${DEPLOY_ENV}-authrim-shared"

[[durable_objects.bindings]]
name = "PAR_REQUEST_STORE"
class_name = "PARRequestStore"
script_name = "${DEPLOY_ENV}-authrim-shared"'

# Generate wrangler.toml for op-token
generate_wrangler_toml "op-token" 8789 '[[kv_namespaces]]
binding = "CLIENTS"
id = "placeholder"
preview_id = "placeholder"

# Durable Objects Bindings' '[[durable_objects.bindings]]
name = "KEY_MANAGER"
class_name = "KeyManager"
script_name = "${DEPLOY_ENV}-authrim-shared"

[[durable_objects.bindings]]
name = "SESSION_STORE"
class_name = "SessionStore"
script_name = "${DEPLOY_ENV}-authrim-shared"

[[durable_objects.bindings]]
name = "AUTH_CODE_STORE"
class_name = "AuthorizationCodeStore"
script_name = "${DEPLOY_ENV}-authrim-shared"

[[durable_objects.bindings]]
name = "REFRESH_TOKEN_ROTATOR"
class_name = "RefreshTokenRotator"
script_name = "${DEPLOY_ENV}-authrim-shared"

[[durable_objects.bindings]]
name = "RATE_LIMITER"
class_name = "RateLimiterCounter"
script_name = "${DEPLOY_ENV}-authrim-shared"

[[durable_objects.bindings]]
name = "DPOP_JTI_STORE"
class_name = "DPoPJTIStore"
script_name = "${DEPLOY_ENV}-authrim-shared"'

# Generate wrangler.toml for op-userinfo
generate_wrangler_toml "op-userinfo" 8790 '[[kv_namespaces]]
binding = "CLIENTS"
id = "placeholder"
preview_id = "placeholder"

# D1 Database
[[d1_databases]]
binding = "DB"
database_name = "authrim-users-db"
database_id = "placeholder"' '[[durable_objects.bindings]]
name = "KEY_MANAGER"
class_name = "KeyManager"
script_name = "${DEPLOY_ENV}-authrim-shared"

[[durable_objects.bindings]]
name = "SESSION_STORE"
class_name = "SessionStore"
script_name = "${DEPLOY_ENV}-authrim-shared"

[[durable_objects.bindings]]
name = "RATE_LIMITER"
class_name = "RateLimiterCounter"
script_name = "${DEPLOY_ENV}-authrim-shared"

[[durable_objects.bindings]]
name = "DPOP_JTI_STORE"
class_name = "DPoPJTIStore"
script_name = "${DEPLOY_ENV}-authrim-shared"'

# Generate wrangler.toml for op-management
generate_wrangler_toml "op-management" 8791 '[[kv_namespaces]]
binding = "CLIENTS"
id = "placeholder"
preview_id = "placeholder"

[[kv_namespaces]]
binding = "INITIAL_ACCESS_TOKENS"
id = "placeholder"
preview_id = "placeholder"

[[kv_namespaces]]
binding = "SETTINGS"
id = "placeholder"
preview_id = "placeholder"

# D1 Database
[[d1_databases]]
binding = "DB"
database_name = "authrim-users-db"
database_id = "placeholder"

# Durable Objects Bindings' '[[durable_objects.bindings]]
name = "KEY_MANAGER"
class_name = "KeyManager"
script_name = "${DEPLOY_ENV}-authrim-shared"

[[durable_objects.bindings]]
name = "REFRESH_TOKEN_ROTATOR"
class_name = "RefreshTokenRotator"
script_name = "${DEPLOY_ENV}-authrim-shared"

[[durable_objects.bindings]]
name = "RATE_LIMITER"
class_name = "RateLimiterCounter"
script_name = "${DEPLOY_ENV}-authrim-shared"

[[durable_objects.bindings]]
name = "SESSION_STORE"
class_name = "SessionStore"
script_name = "${DEPLOY_ENV}-authrim-shared"'

# Generate wrangler.toml for router (with Service Bindings)
echo "  ✅ router/wrangler.toml (with Service Bindings)"
cat > packages/router/wrangler.toml << 'ROUTER_TOML_EOF'
name = "authrim"
main = "src/index.ts"
compatibility_date = "2024-09-23"
compatibility_flags = ["nodejs_compat"]

# Service Bindings to other workers
[[services]]
binding = "OP_DISCOVERY"
service = "${DEPLOY_ENV}-authrim-op-discovery"

[[services]]
binding = "OP_AUTH"
service = "${DEPLOY_ENV}-authrim-op-auth"

[[services]]
binding = "OP_TOKEN"
service = "${DEPLOY_ENV}-authrim-op-token"

[[services]]
binding = "OP_USERINFO"
service = "${DEPLOY_ENV}-authrim-op-userinfo"

[[services]]
binding = "OP_MANAGEMENT"
service = "${DEPLOY_ENV}-authrim-op-management"

# Development configuration
[dev]
port = 8786
ROUTER_TOML_EOF

echo ""
echo -e "${GREEN}✅ All wrangler.${DEPLOY_ENV}.toml files generated!${NC}"
echo ""

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${BLUE}🎉 Local wrangler.toml Setup Complete for Environment: $DEPLOY_ENV${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "📋 Next steps:"
echo ""
echo "1. Setup KV namespaces:"
echo "   ./scripts/setup-kv.sh --env=$DEPLOY_ENV"
echo ""
echo "2. Setup D1 database:"
echo "   ./scripts/setup-d1.sh --env=$DEPLOY_ENV"
echo ""
echo "3. Deploy Durable Objects:"
echo "   ./scripts/setup-durable-objects.sh --env=$DEPLOY_ENV"
echo ""
echo "4. Start local development:"
echo "   pnpm run dev"
echo ""
echo "📋 Configuration:"
echo "   • Environment: $DEPLOY_ENV"
echo "   • ISSUER_URL: http://localhost:8787"
echo "   • KEY_ID: $KEY_ID"
echo ""
echo "⚠️  Note: KV namespace IDs and D1 database IDs are set to 'placeholder'"
echo "       They will be updated after running setup-kv.sh and setup-d1.sh"
echo ""
