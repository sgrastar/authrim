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
echo "KV namespaces are Cloudflare's key-value storage used by the workers."
echo "We'll create both production and preview namespaces for:"
echo "  • AUTH_CODES - OAuth authorization codes"
echo "  • STATE_STORE - OAuth state parameters"
echo "  • NONCE_STORE - OpenID Connect nonces"
echo "  • CLIENTS - Registered OAuth clients"
echo "  • RATE_LIMIT - Rate limiting counters"
echo "  • REFRESH_TOKENS - OAuth refresh tokens"
echo "  • REVOKED_TOKENS - Revoked token list"
echo ""

# Function to create KV namespace and extract ID
create_kv_namespace() {
    local name=$1
    local preview_flag=$2

    echo "  📝 Creating KV namespace: $name $preview_flag" >&2
    local output=$(wrangler kv namespace create "$name" $preview_flag 2>&1)
    local exit_code=$?

    echo "  📄 Wrangler output:" >&2
    echo "$output" >&2
    echo "" >&2

    if [ $exit_code -ne 0 ]; then
        echo "❌ Wrangler command failed with exit code: $exit_code" >&2
        echo "❌ Failed to create namespace: $name $preview_flag" >&2
        exit 1
    fi

    local id=$(echo "$output" | grep -o 'id = "[^"]*"' | cut -d'"' -f2)

    if [ -z "$id" ]; then
        echo "❌ Could not extract ID from wrangler output" >&2
        echo "❌ Failed to create namespace: $name $preview_flag" >&2
        echo "Full output was:" >&2
        echo "$output" >&2
        exit 1
    fi

    echo "$id"
}

# Create production namespaces
echo "Creating production namespaces (for live environment)..."
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
echo "Creating preview namespaces (for development/testing)..."

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

    # Check if file exists
    if [ ! -f "$file" ]; then
        echo "    ⚠️  Warning: File not found: $file"
        return 1
    fi

    # Check if IDs are provided
    if [ -z "$id" ] || [ -z "$preview_id" ]; then
        echo "    ⚠️  Warning: Empty ID provided for $binding (id: '$id', preview_id: '$preview_id')"
        return 1
    fi

    # Create a temporary file
    local temp_file=$(mktemp)

    # Use awk to update the IDs more reliably
    awk -v binding="$binding" -v id="$id" -v preview_id="$preview_id" '
    BEGIN { in_block = 0 }
    /\[\[kv_namespaces\]\]/ { in_block = 0 }
    /binding = / {
        if ($0 ~ binding) {
            in_block = 1
        }
    }
    in_block && /^id = / {
        print "id = \"" id "\""
        next
    }
    in_block && /^preview_id = / {
        print "preview_id = \"" preview_id "\""
        in_block = 0
        next
    }
    { print }
    ' "$file" > "$temp_file"

    # Verify the update was successful
    if grep -q "id = \"$id\"" "$temp_file"; then
        mv "$temp_file" "$file"
        echo "    ✓ Updated $binding: $id / $preview_id"
    else
        echo "    ⚠️  Warning: Failed to update $binding in $file"
        rm "$temp_file"
        return 1
    fi
}

# Update op-auth wrangler.toml
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📝 Updating packages/op-auth/wrangler.toml..."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
update_wrangler_toml "packages/op-auth/wrangler.toml" "AUTH_CODES" "$AUTH_CODES_ID" "$PREVIEW_AUTH_CODES_ID"
update_wrangler_toml "packages/op-auth/wrangler.toml" "STATE_STORE" "$STATE_STORE_ID" "$PREVIEW_STATE_STORE_ID"
update_wrangler_toml "packages/op-auth/wrangler.toml" "NONCE_STORE" "$NONCE_STORE_ID" "$PREVIEW_NONCE_STORE_ID"
update_wrangler_toml "packages/op-auth/wrangler.toml" "CLIENTS" "$CLIENTS_ID" "$PREVIEW_CLIENTS_ID"
update_wrangler_toml "packages/op-auth/wrangler.toml" "RATE_LIMIT" "$RATE_LIMIT_ID" "$PREVIEW_RATE_LIMIT_ID"
echo "✅ op-auth updated"

# Update op-discovery wrangler.toml
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📝 Updating packages/op-discovery/wrangler.toml..."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
update_wrangler_toml "packages/op-discovery/wrangler.toml" "RATE_LIMIT" "$RATE_LIMIT_ID" "$PREVIEW_RATE_LIMIT_ID"
echo "✅ op-discovery updated"

# Update op-management wrangler.toml
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📝 Updating packages/op-management/wrangler.toml..."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
update_wrangler_toml "packages/op-management/wrangler.toml" "CLIENTS" "$CLIENTS_ID" "$PREVIEW_CLIENTS_ID"
update_wrangler_toml "packages/op-management/wrangler.toml" "REFRESH_TOKENS" "$REFRESH_TOKENS_ID" "$PREVIEW_REFRESH_TOKENS_ID"
update_wrangler_toml "packages/op-management/wrangler.toml" "REVOKED_TOKENS" "$REVOKED_TOKENS_ID" "$PREVIEW_REVOKED_TOKENS_ID"
update_wrangler_toml "packages/op-management/wrangler.toml" "RATE_LIMIT" "$RATE_LIMIT_ID" "$PREVIEW_RATE_LIMIT_ID"
echo "✅ op-management updated"

# Update op-token wrangler.toml
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📝 Updating packages/op-token/wrangler.toml..."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
update_wrangler_toml "packages/op-token/wrangler.toml" "AUTH_CODES" "$AUTH_CODES_ID" "$PREVIEW_AUTH_CODES_ID"
update_wrangler_toml "packages/op-token/wrangler.toml" "CLIENTS" "$CLIENTS_ID" "$PREVIEW_CLIENTS_ID"
update_wrangler_toml "packages/op-token/wrangler.toml" "REFRESH_TOKENS" "$REFRESH_TOKENS_ID" "$PREVIEW_REFRESH_TOKENS_ID"
update_wrangler_toml "packages/op-token/wrangler.toml" "REVOKED_TOKENS" "$REVOKED_TOKENS_ID" "$PREVIEW_REVOKED_TOKENS_ID"
update_wrangler_toml "packages/op-token/wrangler.toml" "RATE_LIMIT" "$RATE_LIMIT_ID" "$PREVIEW_RATE_LIMIT_ID"
echo "✅ op-token updated"

# Update op-userinfo wrangler.toml
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📝 Updating packages/op-userinfo/wrangler.toml..."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
update_wrangler_toml "packages/op-userinfo/wrangler.toml" "CLIENTS" "$CLIENTS_ID" "$PREVIEW_CLIENTS_ID"
update_wrangler_toml "packages/op-userinfo/wrangler.toml" "REVOKED_TOKENS" "$REVOKED_TOKENS_ID" "$PREVIEW_REVOKED_TOKENS_ID"
update_wrangler_toml "packages/op-userinfo/wrangler.toml" "RATE_LIMIT" "$RATE_LIMIT_ID" "$PREVIEW_RATE_LIMIT_ID"
echo "✅ op-userinfo updated"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🎉 Setup complete!"
echo ""
echo "Created KV namespaces (production / preview):"
echo "  • AUTH_CODES: $AUTH_CODES_ID / $PREVIEW_AUTH_CODES_ID"
echo "  • STATE_STORE: $STATE_STORE_ID / $PREVIEW_STATE_STORE_ID"
echo "  • NONCE_STORE: $NONCE_STORE_ID / $PREVIEW_NONCE_STORE_ID"
echo "  • CLIENTS: $CLIENTS_ID / $PREVIEW_CLIENTS_ID"
echo "  • RATE_LIMIT: $RATE_LIMIT_ID / $PREVIEW_RATE_LIMIT_ID"
echo "  • REFRESH_TOKENS: $REFRESH_TOKENS_ID / $PREVIEW_REFRESH_TOKENS_ID"
echo "  • REVOKED_TOKENS: $REVOKED_TOKENS_ID / $PREVIEW_REVOKED_TOKENS_ID"
echo ""
echo "All wrangler.toml files have been updated with the correct namespace IDs."
echo ""
echo "📁 Updated files:"
echo "  • packages/op-auth/wrangler.toml"
echo "  • packages/op-discovery/wrangler.toml"
echo "  • packages/op-management/wrangler.toml"
echo "  • packages/op-token/wrangler.toml"
echo "  • packages/op-userinfo/wrangler.toml"
echo ""
echo "Next steps:"
echo "  1. Run 'pnpm run deploy' to deploy your workers"
echo "  2. Or run 'pnpm run dev' for local development"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
