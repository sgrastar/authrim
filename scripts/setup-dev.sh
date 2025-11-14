#!/bin/bash
#
# Enrai Development Setup Script
# This script generates RSA keys and configures .dev.vars for local development

set -e

echo "🔐 Enrai Development Setup"
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

# Create .dev.vars file
cat > .dev.vars << EOF
PRIVATE_KEY_PEM="$PRIVATE_KEY"
PUBLIC_JWK_JSON='$PUBLIC_JWK'
ALLOW_HTTP_REDIRECT="true"
EOF

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
name = "enrai-$package"
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
name = "enrai-shared"
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

# Durable Objects migrations
[[migrations]]
tag = "v1"
new_classes = [
  "SessionStore",
  "AuthorizationCodeStore",
  "RefreshTokenRotator",
  "KeyManager"
]

# Environment variables
[vars]
KEY_MANAGER_SECRET = "dev-secret-change-in-production"
SHARED_TOML_EOF
        echo "  ✅ shared/wrangler.toml (Durable Objects)"
    fi
else
    echo "  ✅ shared/wrangler.toml (Durable Objects)"
    cat > packages/shared/wrangler.toml << 'SHARED_TOML_EOF'
name = "enrai-shared"
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

# Durable Objects migrations
[[migrations]]
tag = "v1"
new_classes = [
  "SessionStore",
  "AuthorizationCodeStore",
  "RefreshTokenRotator",
  "KeyManager"
]

# Environment variables
[vars]
KEY_MANAGER_SECRET = "dev-secret-change-in-production"
SHARED_TOML_EOF
fi

# Generate wrangler.toml for op-discovery
generate_wrangler_toml "op-discovery" 8787 '[[kv_namespaces]]
binding = "RATE_LIMIT"
id = "placeholder"
preview_id = "placeholder"' '[[durable_objects.bindings]]
name = "KEY_MANAGER"
class_name = "KeyManager"
script_name = "enrai-shared"'

# Generate wrangler.toml for op-auth
generate_wrangler_toml "op-auth" 8788 '[[kv_namespaces]]
binding = "AUTH_CODES"
id = "placeholder"
preview_id = "placeholder"

[[kv_namespaces]]
binding = "STATE_STORE"
id = "placeholder"
preview_id = "placeholder"

[[kv_namespaces]]
binding = "NONCE_STORE"
id = "placeholder"
preview_id = "placeholder"

[[kv_namespaces]]
binding = "CLIENTS"
id = "placeholder"
preview_id = "placeholder"

[[kv_namespaces]]
binding = "RATE_LIMIT"
id = "placeholder"
preview_id = "placeholder"' '[[durable_objects.bindings]]
name = "KEY_MANAGER"
class_name = "KeyManager"
script_name = "enrai-shared"

[[durable_objects.bindings]]
name = "SESSION_STORE"
class_name = "SessionStore"
script_name = "enrai-shared"

[[durable_objects.bindings]]
name = "AUTH_CODE_STORE"
class_name = "AuthorizationCodeStore"
script_name = "enrai-shared"'

# Generate wrangler.toml for op-token
generate_wrangler_toml "op-token" 8789 '[[kv_namespaces]]
binding = "AUTH_CODES"
id = "placeholder"
preview_id = "placeholder"

[[kv_namespaces]]
binding = "REFRESH_TOKENS"
id = "placeholder"
preview_id = "placeholder"

[[kv_namespaces]]
binding = "REVOKED_TOKENS"
id = "placeholder"
preview_id = "placeholder"

[[kv_namespaces]]
binding = "CLIENTS"
id = "placeholder"
preview_id = "placeholder"

[[kv_namespaces]]
binding = "RATE_LIMIT"
id = "placeholder"
preview_id = "placeholder"' '[[durable_objects.bindings]]
name = "KEY_MANAGER"
class_name = "KeyManager"
script_name = "enrai-shared"

[[durable_objects.bindings]]
name = "SESSION_STORE"
class_name = "SessionStore"
script_name = "enrai-shared"

[[durable_objects.bindings]]
name = "AUTH_CODE_STORE"
class_name = "AuthorizationCodeStore"
script_name = "enrai-shared"

[[durable_objects.bindings]]
name = "REFRESH_TOKEN_ROTATOR"
class_name = "RefreshTokenRotator"
script_name = "enrai-shared"'

# Generate wrangler.toml for op-userinfo
generate_wrangler_toml "op-userinfo" 8790 '[[kv_namespaces]]
binding = "CLIENTS"
id = "placeholder"
preview_id = "placeholder"

[[kv_namespaces]]
binding = "REVOKED_TOKENS"
id = "placeholder"
preview_id = "placeholder"

[[kv_namespaces]]
binding = "RATE_LIMIT"
id = "placeholder"
preview_id = "placeholder"' '[[durable_objects.bindings]]
name = "KEY_MANAGER"
class_name = "KeyManager"
script_name = "enrai-shared"

[[durable_objects.bindings]]
name = "SESSION_STORE"
class_name = "SessionStore"
script_name = "enrai-shared"'

# Generate wrangler.toml for op-management
generate_wrangler_toml "op-management" 8791 '[[kv_namespaces]]
binding = "CLIENTS"
id = "placeholder"
preview_id = "placeholder"

[[kv_namespaces]]
binding = "REFRESH_TOKENS"
id = "placeholder"
preview_id = "placeholder"

[[kv_namespaces]]
binding = "REVOKED_TOKENS"
id = "placeholder"
preview_id = "placeholder"

[[kv_namespaces]]
binding = "RATE_LIMIT"
id = "placeholder"
preview_id = "placeholder"

[[kv_namespaces]]
binding = "INITIAL_ACCESS_TOKENS"
id = "placeholder"
preview_id = "placeholder"' '[[durable_objects.bindings]]
name = "KEY_MANAGER"
class_name = "KeyManager"
script_name = "enrai-shared"

[[durable_objects.bindings]]
name = "REFRESH_TOKEN_ROTATOR"
class_name = "RefreshTokenRotator"
script_name = "enrai-shared"'

# Generate wrangler.toml for router (with Service Bindings)
echo "  ✅ router/wrangler.toml (with Service Bindings)"
cat > packages/router/wrangler.toml << 'ROUTER_TOML_EOF'
name = "enrai"
main = "src/index.ts"
compatibility_date = "2024-09-23"
compatibility_flags = ["nodejs_compat"]

# Service Bindings to other workers
[[services]]
binding = "OP_DISCOVERY"
service = "enrai-op-discovery"

[[services]]
binding = "OP_AUTH"
service = "enrai-op-auth"

[[services]]
binding = "OP_TOKEN"
service = "enrai-op-token"

[[services]]
binding = "OP_USERINFO"
service = "enrai-op-userinfo"

[[services]]
binding = "OP_MANAGEMENT"
service = "enrai-op-management"

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
