#!/bin/bash
#
# Authrim Development Setup Script
# This script generates RSA keys and configures .dev.vars for local development

set -e

echo "🔐 Authrim Development Setup"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Check if keys already exist
if [ -f ".keys/private.pem" ]; then
    echo "⚠️  Keys already exist in .keys/ directory"
    read -p "Do you want to regenerate keys? (y/N): " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "Using existing keys..."
        PRIVATE_KEY=$(cat .keys/private.pem)
        PUBLIC_JWK=$(cat .keys/public.jwk.json | jq -c .)
        KEY_ID=$(cat .keys/metadata.json | jq -r '.kid')
    else
        echo "Regenerating keys..."
        pnpm run generate-keys
        PRIVATE_KEY=$(cat .keys/private.pem)
        PUBLIC_JWK=$(cat .keys/public.jwk.json | jq -c .)
        KEY_ID=$(cat .keys/metadata.json | jq -r '.kid')
    fi
else
    echo "📦 Generating RSA keys..."
    pnpm run generate-keys
    PRIVATE_KEY=$(cat .keys/private.pem)
    PUBLIC_JWK=$(cat .keys/public.jwk.json | jq -c .)
    KEY_ID=$(cat .keys/metadata.json | jq -r '.kid')
fi

echo ""
echo "📝 Creating .dev.vars file..."

# Prompt for optional Resend API Key
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📧 Email Configuration (Optional)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "Authrim uses Resend for sending magic link emails."
echo "If you have a Resend API key, enter it now."
echo "Otherwise, press Enter to skip (magic links will return URLs instead)."
echo ""
read -p "Resend API Key (or press Enter to skip): " RESEND_API_KEY

# Set default EMAIL_FROM
EMAIL_FROM="noreply@yourdomain.com"
if [ -n "$RESEND_API_KEY" ]; then
    echo ""
    read -p "Email From address (default: noreply@yourdomain.com): " EMAIL_FROM_INPUT
    if [ -n "$EMAIL_FROM_INPUT" ]; then
        EMAIL_FROM="$EMAIL_FROM_INPUT"
    fi
fi

# Create .dev.vars file
cat > .dev.vars << EOF
PRIVATE_KEY_PEM="$PRIVATE_KEY"
PUBLIC_JWK_JSON='$PUBLIC_JWK'
ALLOW_HTTP_REDIRECT="true"
UI_BASE_URL="http://localhost:5173"
EOF

# Add email configuration if provided
if [ -n "$RESEND_API_KEY" ]; then
    cat >> .dev.vars << EOF
RESEND_API_KEY="$RESEND_API_KEY"
EMAIL_FROM="$EMAIL_FROM"
EOF
    echo ""
    echo "✅ Email configuration added:"
    echo "   • Resend API Key: ${RESEND_API_KEY:0:10}..."
    echo "   • Email From: $EMAIL_FROM"
else
    echo ""
    echo "⊗ Email configuration skipped (magic links will return URLs)"
fi

echo ""
echo "✅ .dev.vars file created successfully!"
echo ""

echo "📝 Generating wrangler.toml files for each worker..."
echo ""

# Function to generate wrangler.toml for a worker
generate_wrangler_toml() {
    local package=$1
    local port=$2
    local kv_namespaces=$3
    local do_bindings=$4

    local file="packages/$package/wrangler.toml"

    # Check if file already exists
    if [ -f "$file" ]; then
        echo "  ⚠️  $file already exists"
        read -p "    Overwrite? This will reset KV IDs, D1 bindings, and other configurations (y/N): " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            echo "    ⊗ Skipping $package (keeping existing configuration)"
            return
        fi
        echo "    ✓ Overwriting $package/wrangler.toml"
    fi

    cat > "$file" << TOML_EOF
name = "authrim-$package"
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

    echo "  ✅ $package/wrangler.toml"
}

# Generate wrangler.toml for shared package (Durable Objects)
SHARED_FILE="packages/shared/wrangler.toml"
if [ -f "$SHARED_FILE" ]; then
    echo "  ⚠️  $SHARED_FILE already exists"
    read -p "    Overwrite? This will reset Durable Objects configuration (y/N): " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "    ⊗ Skipping shared (keeping existing configuration)"
    else
        echo "    ✓ Overwriting shared/wrangler.toml"
        cat > packages/shared/wrangler.toml << 'SHARED_TOML_EOF'
name = "authrim-shared"
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
        echo "  ✅ shared/wrangler.toml (Durable Objects)"
    fi
else
    echo "  ✅ shared/wrangler.toml (Durable Objects)"
    cat > packages/shared/wrangler.toml << 'SHARED_TOML_EOF'
name = "authrim-shared"
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

# Generate wrangler.toml for op-discovery
generate_wrangler_toml "op-discovery" 8787 '' '[[durable_objects.bindings]]
name = "KEY_MANAGER"
class_name = "KeyManager"
script_name = "authrim-shared"

[[durable_objects.bindings]]
name = "RATE_LIMITER"
class_name = "RateLimiterCounter"
script_name = "authrim-shared"'

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
script_name = "authrim-shared"

[[durable_objects.bindings]]
name = "SESSION_STORE"
class_name = "SessionStore"
script_name = "authrim-shared"

[[durable_objects.bindings]]
name = "AUTH_CODE_STORE"
class_name = "AuthorizationCodeStore"
script_name = "authrim-shared"

[[durable_objects.bindings]]
name = "CHALLENGE_STORE"
class_name = "ChallengeStore"
script_name = "authrim-shared"

[[durable_objects.bindings]]
name = "RATE_LIMITER"
class_name = "RateLimiterCounter"
script_name = "authrim-shared"

[[durable_objects.bindings]]
name = "PAR_REQUEST_STORE"
class_name = "PARRequestStore"
script_name = "authrim-shared"'

# Generate wrangler.toml for op-token
generate_wrangler_toml "op-token" 8789 '[[kv_namespaces]]
binding = "CLIENTS"
id = "placeholder"
preview_id = "placeholder"

# Durable Objects Bindings' '[[durable_objects.bindings]]
name = "KEY_MANAGER"
class_name = "KeyManager"
script_name = "authrim-shared"

[[durable_objects.bindings]]
name = "SESSION_STORE"
class_name = "SessionStore"
script_name = "authrim-shared"

[[durable_objects.bindings]]
name = "AUTH_CODE_STORE"
class_name = "AuthorizationCodeStore"
script_name = "authrim-shared"

[[durable_objects.bindings]]
name = "REFRESH_TOKEN_ROTATOR"
class_name = "RefreshTokenRotator"
script_name = "authrim-shared"

[[durable_objects.bindings]]
name = "RATE_LIMITER"
class_name = "RateLimiterCounter"
script_name = "authrim-shared"

[[durable_objects.bindings]]
name = "DPOP_JTI_STORE"
class_name = "DPoPJTIStore"
script_name = "authrim-shared"'

# Generate wrangler.toml for op-userinfo
generate_wrangler_toml "op-userinfo" 8790 '[[kv_namespaces]]
binding = "CLIENTS"
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
script_name = "authrim-shared"

[[durable_objects.bindings]]
name = "SESSION_STORE"
class_name = "SessionStore"
script_name = "authrim-shared"

[[durable_objects.bindings]]
name = "RATE_LIMITER"
class_name = "RateLimiterCounter"
script_name = "authrim-shared"

[[durable_objects.bindings]]
name = "DPOP_JTI_STORE"
class_name = "DPoPJTIStore"
script_name = "authrim-shared"'

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
script_name = "authrim-shared"

[[durable_objects.bindings]]
name = "REFRESH_TOKEN_ROTATOR"
class_name = "RefreshTokenRotator"
script_name = "authrim-shared"

[[durable_objects.bindings]]
name = "RATE_LIMITER"
class_name = "RateLimiterCounter"
script_name = "authrim-shared"

[[durable_objects.bindings]]
name = "SESSION_STORE"
class_name = "SessionStore"
script_name = "authrim-shared"'

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
service = "authrim-op-discovery"

[[services]]
binding = "OP_AUTH"
service = "authrim-op-auth"

[[services]]
binding = "OP_TOKEN"
service = "authrim-op-token"

[[services]]
binding = "OP_USERINFO"
service = "authrim-op-userinfo"

[[services]]
binding = "OP_MANAGEMENT"
service = "authrim-op-management"

# Development configuration
[dev]
port = 8786
ROUTER_TOML_EOF

echo ""
echo "✅ All wrangler.toml files generated!"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🎉 Setup complete!"
echo ""
echo "📋 Key Information:"
echo "  • Key ID: $KEY_ID"
echo "  • Private Key: .keys/private.pem"
echo "  • Public JWK: .keys/public.jwk.json"
echo ""
echo "Next steps:"
echo "  1. Run 'pnpm install' to install dependencies (if not done)"
echo "  2. Run 'pnpm run build' to build all packages"
echo "  3. Run 'pnpm run dev' to start all workers"
echo "  4. Visit http://localhost:8787/.well-known/openid-configuration"
echo ""
echo "For production deployment:"
echo "  • Run './scripts/setup-kv.sh' to create KV namespaces"
echo "  • Run './scripts/setup-secrets.sh' to configure Cloudflare Secrets"
echo "  • Run './scripts/setup-production.sh' to set production URLs"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
