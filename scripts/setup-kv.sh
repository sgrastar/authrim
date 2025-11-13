#!/bin/bash
#
# Enrai KV Namespace Setup Script
# This script creates all required KV namespaces and updates wrangler.toml files
#
# Usage:
#   ./setup-kv.sh          - Interactive mode (prompts for existing namespaces)
#   ./setup-kv.sh --reset  - Reset mode (deletes and recreates all namespaces)
#

set -e

# Parse command line arguments
RESET_MODE=false
if [ "$1" = "--reset" ]; then
    RESET_MODE=true
    echo "⚠️  RESET MODE ENABLED"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "All existing KV namespaces will be deleted and recreated."
    echo "This will delete ALL data in the namespaces."
    echo ""
    read -p "Are you sure you want to continue? Type 'YES' to confirm: " -r
    if [ "$REPLY" != "YES" ]; then
        echo "❌ Reset cancelled"
        exit 1
    fi
    echo ""
fi

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

echo "📦 KV Namespace Setup"
echo ""
echo "This script will create or update KV namespaces for your Enrai deployment."
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
echo "  • INITIAL_ACCESS_TOKENS - Dynamic Client Registration tokens"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "⚠️  How this script works:"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "  For each namespace, if it already exists, you'll be prompted with:"
echo ""
echo "    Enter your choice (1/2/3):"
echo "      1) Use existing namespace (keeps all data)"
echo "      2) Delete and recreate (WARNING: deletes all data)"
echo "      3) Abort script"
echo ""
echo "  If the namespace doesn't exist, it will be created automatically."
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Skip confirmation prompt in reset mode
if [ "$RESET_MODE" = false ]; then
    read -p "Ready to start? Type 'y' to continue, 'N' to cancel: " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "❌ Setup cancelled"
        exit 1
    fi
    echo ""
fi

# Function to get namespace ID from list by exact title match
get_namespace_id_by_title() {
    local title=$1
    local list_output=$2

    # Try using jq if available for robust JSON parsing
    if command -v jq &> /dev/null; then
        echo "$list_output" | jq -r ".[] | select(.title == \"$title\") | .id" 2>/dev/null | head -1
    else
        # Fallback to grep-based parsing
        # Match the entire object that contains our title
        echo "$list_output" | grep -A 2 "\"title\"[[:space:]]*:[[:space:]]*\"$title\"" | grep "\"id\"" | grep -o '"[a-f0-9]\{32\}"' | tr -d '"' | head -1
    fi
}

# Function to get or create KV namespace and extract ID
create_kv_namespace() {
    local name=$1
    local preview_flag=$2

    # First, try to get existing namespace
    echo "  📝 Checking for existing KV namespace: $name $preview_flag" >&2
    local list_output=$(wrangler kv namespace list 2>&1)
    local list_exit_code=$?

    if [ $list_exit_code -ne 0 ]; then
        echo "  ⚠️  Warning: Could not list namespaces" >&2
        echo "$list_output" >&2
    fi

    # Determine the title to search for
    # Wrangler creates preview namespaces with suffix like "AUTH_CODES_preview_xyz"
    local title="$name"
    local id=""

    if [ "$preview_flag" = "--preview" ]; then
        # For preview namespaces, try to find any namespace with the name followed by _preview
        if command -v jq &> /dev/null; then
            id=$(echo "$list_output" | jq -r ".[] | select(.title | test(\"^${name}_preview\"; \"i\")) | .id" 2>/dev/null | head -1)
        else
            # Fallback: look for title containing the name and preview
            id=$(echo "$list_output" | grep -i "\"title\".*$name" | grep -i "preview" | grep -o '"[a-f0-9]\{32\}"' | tr -d '"' | head -1)
        fi

        # If we didn't find a preview namespace, try exact match
        if [ -z "$id" ]; then
            id=$(get_namespace_id_by_title "$title" "$list_output")
        fi
    else
        # For production namespaces, look for exact title match
        id=$(get_namespace_id_by_title "$title" "$list_output")
    fi

    if [ -n "$id" ]; then
        echo "" >&2
        echo "  ⚠️  Found existing namespace: $name $preview_flag" >&2
        echo "      ID: $id" >&2
        echo "" >&2

        # In reset mode, automatically delete and recreate
        if [ "$RESET_MODE" = true ]; then
            echo "  🗑️  [RESET MODE] Deleting existing namespace: $id" >&2
            local delete_output=$(wrangler kv namespace delete --namespace-id="$id" 2>&1)
            local delete_exit_code=$?

            if [ $delete_exit_code -ne 0 ]; then
                echo "" >&2
                echo "  ❌ Failed to delete namespace:" >&2
                echo "$delete_output" >&2
                echo "" >&2

                # Check if it's because the namespace is in use
                if echo "$delete_output" | grep -q "associated scripts"; then
                    echo "  ⚠️  The namespace is currently being used by deployed workers." >&2
                    echo "  ⚠️  You may need to undeploy the workers first using:" >&2
                    echo "      wrangler delete <worker-name>" >&2
                    echo "" >&2
                    exit 1
                else
                    echo "  ❌ Script aborted due to deletion failure" >&2
                    exit 1
                fi
            fi

            echo "  ✓ Successfully deleted namespace" >&2
            echo "  📝 Creating new namespace: $name $preview_flag" >&2
            # Fall through to create new namespace
        else
            # Interactive mode - ask user what to do
            echo "  What would you like to do?" >&2
            echo "    1) Use existing namespace (keep all data)" >&2
            echo "    2) Delete and recreate namespace (WARNING: all data will be lost)" >&2
            echo "    3) Abort script" >&2
            echo "" >&2
            read -p "  Enter your choice (1/2/3): " -r choice >&2

            case $choice in
                1)
                    echo "  ✓ Using existing namespace with ID: $id" >&2
                    echo "$id"
                    return 0
                    ;;
                2)
                    echo "  🗑️  Deleting existing namespace: $id" >&2
                    local delete_output=$(wrangler kv namespace delete --namespace-id="$id" 2>&1)
                    local delete_exit_code=$?

                    if [ $delete_exit_code -ne 0 ]; then
                        echo "" >&2
                        echo "  ❌ Failed to delete namespace:" >&2
                        echo "$delete_output" >&2
                        echo "" >&2

                        # Check if it's because the namespace is in use
                        if echo "$delete_output" | grep -q "associated scripts"; then
                            echo "  ⚠️  The namespace is currently being used by deployed workers." >&2
                            echo "  You need to either:" >&2
                            echo "    - Undeploy the workers using this namespace first" >&2
                            echo "    - Or use the existing namespace (option 1)" >&2
                            echo "" >&2
                            echo "  Would you like to use the existing namespace instead?" >&2
                            read -p "  Use existing namespace? (y/n): " -r use_existing >&2

                            if [[ $use_existing =~ ^[Yy]$ ]]; then
                                echo "  ✓ Using existing namespace with ID: $id" >&2
                                echo "$id"
                                return 0
                            else
                                echo "  ❌ Cannot proceed without deleting or using existing namespace" >&2
                                exit 1
                            fi
                        else
                            echo "  ❌ Script aborted due to deletion failure" >&2
                            exit 1
                        fi
                    fi

                    echo "  ✓ Successfully deleted namespace" >&2
                    echo "  📝 Creating new namespace: $name $preview_flag" >&2
                    # Fall through to create new namespace
                    ;;
                3)
                    echo "  ❌ Script aborted by user" >&2
                    exit 1
                    ;;
                *)
                    echo "  ❌ Invalid choice. Aborting." >&2
                    exit 1
                    ;;
            esac
        fi
    fi

    # Create new namespace (either first time or after deletion)
    echo "  📝 Creating new KV namespace: $name $preview_flag" >&2
    local output=$(wrangler kv namespace create "$name" $preview_flag 2>&1)
    local exit_code=$?

    echo "  📄 Wrangler output:" >&2
    echo "$output" >&2
    echo "" >&2

    # Check if the error is "already exists" (either from exit code or error message)
    # Wrangler sometimes returns exit code 0 even on errors, so check for error indicators
    if [ $exit_code -ne 0 ] || echo "$output" | grep -Eq "(ERROR|✘)"; then
        if echo "$output" | grep -qi "already exists"; then
            echo "  ⚠️  Namespace already exists, fetching ID from list..." >&2
            # Re-fetch the list
            list_output=$(wrangler kv namespace list 2>&1)

            if [ "$preview_flag" = "--preview" ]; then
                if command -v jq &> /dev/null; then
                    id=$(echo "$list_output" | jq -r ".[] | select(.title | test(\"^${name}_preview\"; \"i\")) | .id" 2>/dev/null | head -1)
                else
                    id=$(echo "$list_output" | grep -i "\"title\".*$name" | grep -i "preview" | grep -o '"[a-f0-9]\{32\}"' | tr -d '"' | head -1)
                fi

                if [ -z "$id" ]; then
                    id=$(get_namespace_id_by_title "$name" "$list_output")
                fi
            else
                id=$(get_namespace_id_by_title "$name" "$list_output")
            fi

            if [ -n "$id" ]; then
                echo "  ✓ Found existing namespace with ID: $id" >&2
                echo "$id"
                return 0
            else
                echo "❌ Could not find existing namespace ID" >&2
                echo "Full list output:" >&2
                echo "$list_output" >&2
                exit 1
            fi
        else
            echo "❌ Wrangler command failed with exit code: $exit_code" >&2
            echo "❌ Failed to create namespace: $name $preview_flag" >&2
            exit 1
        fi
    fi

    # Extract ID from successful creation output
    # Wrangler outputs in JSON format: "id": "abc123..." or "preview_id": "abc123..."
    local id=""
    if [ "$preview_flag" = "--preview" ]; then
        id=$(echo "$output" | grep -o '"preview_id"[[:space:]]*:[[:space:]]*"[a-f0-9]\{32\}"' | grep -o '[a-f0-9]\{32\}')
    else
        id=$(echo "$output" | grep -o '"id"[[:space:]]*:[[:space:]]*"[a-f0-9]\{32\}"' | grep -o '[a-f0-9]\{32\}')
    fi

    if [ -z "$id" ]; then
        echo "❌ Could not extract ID from wrangler output" >&2
        echo "❌ Failed to create namespace: $name $preview_flag" >&2
        echo "Full output was:" >&2
        echo "$output" >&2
        exit 1
    fi

    echo "  ✓ Created new namespace with ID: $id" >&2
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

INITIAL_ACCESS_TOKENS_ID=$(create_kv_namespace "INITIAL_ACCESS_TOKENS")
echo "✅ INITIAL_ACCESS_TOKENS: $INITIAL_ACCESS_TOKENS_ID"

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

PREVIEW_INITIAL_ACCESS_TOKENS_ID=$(create_kv_namespace "INITIAL_ACCESS_TOKENS" "--preview")
echo "✅ INITIAL_ACCESS_TOKENS (preview): $PREVIEW_INITIAL_ACCESS_TOKENS_ID"

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
update_wrangler_toml "packages/op-management/wrangler.toml" "INITIAL_ACCESS_TOKENS" "$INITIAL_ACCESS_TOKENS_ID" "$PREVIEW_INITIAL_ACCESS_TOKENS_ID"
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
echo "  • INITIAL_ACCESS_TOKENS: $INITIAL_ACCESS_TOKENS_ID / $PREVIEW_INITIAL_ACCESS_TOKENS_ID"
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
echo "⚠️  Important: After creating or updating KV namespaces, wait 10-30 seconds"
echo "   before deploying to allow Cloudflare to propagate the changes."
echo ""
echo "Next steps:"
echo "  1. Run 'pnpm run deploy:retry' to deploy with retry logic (RECOMMENDED)"
echo "     This deploys sequentially with delays to avoid rate limits."
echo "  2. Or run 'pnpm run deploy' for parallel deployment (may fail with rate limits)"
echo "  3. Or run 'pnpm run dev' for local development"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
