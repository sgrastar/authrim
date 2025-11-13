#!/bin/bash
#
# Enrai KV Namespace Setup Script
# This script creates all required KV namespaces and updates wrangler.toml files
#

set -e

echo "⚡️ Enrai KV Namespace Setup"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Check if wrangler is installed
if ! command -v wrangler &> /dev/null; then
    echo "❌ Error: wrangler is not installed"
    echo "Please install it with: npm install -g wrangler"
    exit 1
fi

# Check if user is logged in
if ! wrangler whoami &> /dev/null; then
    echo "❌ Error: Not logged in to Cloudflare"
    echo "Please run: wrangler login"
    exit 1
fi

echo "📦 Creating KV namespaces..."
echo ""

# Function to create KV namespace and extract ID
create_kv_namespace() {
    local name=$1
    local output=$(wrangler kv:namespace create "$name" 2>&1)
    local id=$(echo "$output" | grep -o 'id = "[^"]*"' | cut -d'"' -f2)

    if [ -z "$id" ]; then
        echo "❌ Failed to create namespace: $name"
        echo "$output"
        exit 1
    fi

    echo "$id"
}

# Create production namespaces
echo "Creating production namespaces..."
AUTH_CODES_ID=$(create_kv_namespace "AUTH_CODES")
echo "✅ AUTH_CODES: $AUTH_CODES_ID"

STATE_STORE_ID=$(create_kv_namespace "STATE_STORE")
echo "✅ STATE_STORE: $STATE_STORE_ID"

NONCE_STORE_ID=$(create_kv_namespace "NONCE_STORE")
echo "✅ NONCE_STORE: $NONCE_STORE_ID"

CLIENTS_ID=$(create_kv_namespace "CLIENTS")
echo "✅ CLIENTS: $CLIENTS_ID"

RATE_LIMIT_ID=$(create_kv_namespace "RATE_LIMIT")
echo "✅ RATE_LIMIT: $RATE_LIMIT_ID"

REFRESH_TOKENS_ID=$(create_kv_namespace "REFRESH_TOKENS")
echo "✅ REFRESH_TOKENS: $REFRESH_TOKENS_ID"

REVOKED_TOKENS_ID=$(create_kv_namespace "REVOKED_TOKENS")
echo "✅ REVOKED_TOKENS: $REVOKED_TOKENS_ID"

echo ""
echo "Creating preview namespaces..."

# Create preview namespaces
PREVIEW_AUTH_CODES_ID=$(create_kv_namespace "AUTH_CODES" "--preview")
echo "✅ AUTH_CODES (preview): $PREVIEW_AUTH_CODES_ID"

PREVIEW_STATE_STORE_ID=$(create_kv_namespace "STATE_STORE" "--preview")
echo "✅ STATE_STORE (preview): $PREVIEW_STATE_STORE_ID"

PREVIEW_NONCE_STORE_ID=$(create_kv_namespace "NONCE_STORE" "--preview")
echo "✅ NONCE_STORE (preview): $PREVIEW_NONCE_STORE_ID"

PREVIEW_CLIENTS_ID=$(create_kv_namespace "CLIENTS" "--preview")
echo "✅ CLIENTS (preview): $PREVIEW_CLIENTS_ID"

PREVIEW_RATE_LIMIT_ID=$(create_kv_namespace "RATE_LIMIT" "--preview")
echo "✅ RATE_LIMIT (preview): $PREVIEW_RATE_LIMIT_ID"

PREVIEW_REFRESH_TOKENS_ID=$(create_kv_namespace "REFRESH_TOKENS" "--preview")
echo "✅ REFRESH_TOKENS (preview): $PREVIEW_REFRESH_TOKENS_ID"

PREVIEW_REVOKED_TOKENS_ID=$(create_kv_namespace "REVOKED_TOKENS" "--preview")
echo "✅ REVOKED_TOKENS (preview): $PREVIEW_REVOKED_TOKENS_ID"

echo ""
echo "📝 Updating wrangler.toml files..."
echo ""

# Function to update wrangler.toml
update_wrangler_toml() {
    local file=$1
    local binding=$2
    local id=$3
    local preview_id=$4

    if [[ "$OSTYPE" == "darwin"* ]]; then
        # macOS
        sed -i '' "/binding = \"$binding\"/,/preview_id/ s/id = \"[^\"]*\"/id = \"$id\"/" "$file"
        sed -i '' "/binding = \"$binding\"/,/preview_id/ s/preview_id = \"[^\"]*\"/preview_id = \"$preview_id\"/" "$file"
    else
        # Linux
        sed -i "/binding = \"$binding\"/,/preview_id/ s/id = \"[^\"]*\"/id = \"$id\"/" "$file"
        sed -i "/binding = \"$binding\"/,/preview_id/ s/preview_id = \"[^\"]*\"/preview_id = \"$preview_id\"/" "$file"
    fi
}

# Update op-auth wrangler.toml
echo "Updating packages/op-auth/wrangler.toml..."
update_wrangler_toml "packages/op-auth/wrangler.toml" "AUTH_CODES" "$AUTH_CODES_ID" "$PREVIEW_AUTH_CODES_ID"
update_wrangler_toml "packages/op-auth/wrangler.toml" "STATE_STORE" "$STATE_STORE_ID" "$PREVIEW_STATE_STORE_ID"
update_wrangler_toml "packages/op-auth/wrangler.toml" "NONCE_STORE" "$NONCE_STORE_ID" "$PREVIEW_NONCE_STORE_ID"
update_wrangler_toml "packages/op-auth/wrangler.toml" "CLIENTS" "$CLIENTS_ID" "$PREVIEW_CLIENTS_ID"
update_wrangler_toml "packages/op-auth/wrangler.toml" "RATE_LIMIT" "$RATE_LIMIT_ID" "$PREVIEW_RATE_LIMIT_ID"
echo "✅ op-auth updated"

# Update op-discovery wrangler.toml
echo "Updating packages/op-discovery/wrangler.toml..."
update_wrangler_toml "packages/op-discovery/wrangler.toml" "RATE_LIMIT" "$RATE_LIMIT_ID" "$PREVIEW_RATE_LIMIT_ID"
echo "✅ op-discovery updated"

# Update op-management wrangler.toml
echo "Updating packages/op-management/wrangler.toml..."
update_wrangler_toml "packages/op-management/wrangler.toml" "CLIENTS" "$CLIENTS_ID" "$PREVIEW_CLIENTS_ID"
update_wrangler_toml "packages/op-management/wrangler.toml" "REFRESH_TOKENS" "$REFRESH_TOKENS_ID" "$PREVIEW_REFRESH_TOKENS_ID"
update_wrangler_toml "packages/op-management/wrangler.toml" "REVOKED_TOKENS" "$REVOKED_TOKENS_ID" "$PREVIEW_REVOKED_TOKENS_ID"
update_wrangler_toml "packages/op-management/wrangler.toml" "RATE_LIMIT" "$RATE_LIMIT_ID" "$PREVIEW_RATE_LIMIT_ID"
echo "✅ op-management updated"

# Update op-token wrangler.toml
echo "Updating packages/op-token/wrangler.toml..."
update_wrangler_toml "packages/op-token/wrangler.toml" "AUTH_CODES" "$AUTH_CODES_ID" "$PREVIEW_AUTH_CODES_ID"
update_wrangler_toml "packages/op-token/wrangler.toml" "CLIENTS" "$CLIENTS_ID" "$PREVIEW_CLIENTS_ID"
update_wrangler_toml "packages/op-token/wrangler.toml" "REFRESH_TOKENS" "$REFRESH_TOKENS_ID" "$PREVIEW_REFRESH_TOKENS_ID"
update_wrangler_toml "packages/op-token/wrangler.toml" "REVOKED_TOKENS" "$REVOKED_TOKENS_ID" "$PREVIEW_REVOKED_TOKENS_ID"
update_wrangler_toml "packages/op-token/wrangler.toml" "RATE_LIMIT" "$RATE_LIMIT_ID" "$PREVIEW_RATE_LIMIT_ID"
echo "✅ op-token updated"

# Update op-userinfo wrangler.toml
echo "Updating packages/op-userinfo/wrangler.toml..."
update_wrangler_toml "packages/op-userinfo/wrangler.toml" "CLIENTS" "$CLIENTS_ID" "$PREVIEW_CLIENTS_ID"
update_wrangler_toml "packages/op-userinfo/wrangler.toml" "REVOKED_TOKENS" "$REVOKED_TOKENS_ID" "$PREVIEW_REVOKED_TOKENS_ID"
update_wrangler_toml "packages/op-userinfo/wrangler.toml" "RATE_LIMIT" "$RATE_LIMIT_ID" "$PREVIEW_RATE_LIMIT_ID"
echo "✅ op-userinfo updated"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🎉 Setup complete!"
echo ""
echo "Created KV namespaces:"
echo "  • AUTH_CODES: $AUTH_CODES_ID"
echo "  • STATE_STORE: $STATE_STORE_ID"
echo "  • NONCE_STORE: $NONCE_STORE_ID"
echo "  • CLIENTS: $CLIENTS_ID"
echo "  • RATE_LIMIT: $RATE_LIMIT_ID"
echo "  • REFRESH_TOKENS: $REFRESH_TOKENS_ID"
echo "  • REVOKED_TOKENS: $REVOKED_TOKENS_ID"
echo ""
echo "All wrangler.toml files have been updated with the correct namespace IDs."
echo ""
echo "Next steps:"
echo "  1. Run 'npm run deploy' to deploy your workers"
echo "  2. Or run 'npm run dev' for local development"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
