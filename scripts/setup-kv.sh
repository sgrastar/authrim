#!/bin/bash
#
# Authrim KV Namespace Setup Script
# This script creates all required KV namespaces and updates wrangler.toml files
#
# Usage:
#   ./setup-kv.sh --env=dev           - Set up KV namespaces for dev environment
#   ./setup-kv.sh --env=prod --reset  - Reset mode (deletes and recreates all namespaces)
#

set -e

# Parse command line arguments
RESET_MODE=false
DEPLOY_ENV=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --env=*)
            DEPLOY_ENV="${1#*=}"
            shift
            ;;
        --reset)
            RESET_MODE=true
            shift
            ;;
        *)
            echo "❌ Unknown parameter: $1"
            echo ""
            echo "Usage: $0 --env=<environment> [--reset]"
            echo ""
            echo "Options:"
            echo "  --env=<name>    Environment name (required, e.g., dev, staging, prod)"
            echo "  --reset         Delete and recreate all namespaces (WARNING: deletes all data)"
            echo ""
            echo "Examples:"
            echo "  $0 --env=dev"
            echo "  $0 --env=staging"
            echo "  $0 --env=prod --reset"
            exit 1
            ;;
    esac
done

# Validate required parameters
if [ -z "$DEPLOY_ENV" ]; then
    echo "❌ Error: --env parameter is required"
    echo ""
    echo "Usage: $0 --env=<environment> [--reset]"
    echo ""
    echo "Examples:"
    echo "  $0 --env=dev"
    echo "  $0 --env=staging"
    echo "  $0 --env=prod"
    exit 1
fi

if [ "$RESET_MODE" = true ]; then
    echo "⚠️  RESET MODE ENABLED for environment: $DEPLOY_ENV"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "All existing KV namespaces for $DEPLOY_ENV will be deleted and recreated."
    echo "This will delete ALL data in the namespaces."
    echo ""
    read -p "Are you sure you want to continue? Type 'YES' to confirm: " -r
    if [ "$REPLY" != "YES" ]; then
        echo "❌ Reset cancelled"
        exit 1
    fi
    echo ""
fi

echo "⚡️ Authrim KV Namespace Setup - Environment: $DEPLOY_ENV"
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

echo "📦 KV Namespace Setup for Environment: $DEPLOY_ENV"
echo ""
echo "This script will create or update KV namespaces for your Authrim deployment."
echo ""
echo "KV namespaces are Cloudflare's key-value storage used by the workers."
echo "We'll create both production and preview namespaces for:"
echo "  • ${DEPLOY_ENV}-CLIENTS_CACHE - OAuth client metadata cache (Read-Through from D1)"
echo "  • ${DEPLOY_ENV}-INITIAL_ACCESS_TOKENS - Dynamic Client Registration tokens"
echo "  • ${DEPLOY_ENV}-SETTINGS - System settings storage"
echo "  • ${DEPLOY_ENV}-REBAC_CACHE - ReBAC authorization check cache (TTL: 60s)"
echo ""
echo "Note: The following have been migrated to Durable Objects:"
echo "  • AUTH_CODES → AuthorizationCodeStore DO"
echo "  • REFRESH_TOKENS → RefreshTokenRotator DO"
echo "  • REVOKED_TOKENS (removed)"
echo "  • STATE_STORE → PARRequestStore DO"
echo "  • NONCE_STORE → DPoPJTIStore DO"
echo "  • RATE_LIMIT → RateLimiterCounter DO"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "⚠️  How this script works:"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "  1. If all KV namespaces already exist:"
echo "     → You can choose to use all existing ones with a single choice (bulk mode)"
echo ""
echo "  2. If some namespaces are missing:"
echo "     → New ones will be created"
echo "     → For existing ones, you'll be asked individually what to do"
echo ""
echo "  3. Individual namespace choices (when prompted):"
echo "      1) Use existing namespace (keeps all data)"
echo "      2) Delete and recreate (WARNING: deletes all data)"
echo "      3) Abort script"
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

# Define all required KV namespaces (base names)
declare -a BASE_NAMESPACES=(
    "CLIENTS_CACHE"
    "INITIAL_ACCESS_TOKENS"
    "SETTINGS"
    "REBAC_CACHE"
)

# Add environment prefix to namespace names
declare -a REQUIRED_NAMESPACES=()
for namespace in "${BASE_NAMESPACES[@]}"; do
    REQUIRED_NAMESPACES+=("${DEPLOY_ENV}-${namespace}")
done

# Function to get namespace ID from list by exact title match
get_namespace_id_by_title() {
    local title=$1
    local list_output=$2

    # Try using jq if available for robust JSON parsing
    if command -v jq &> /dev/null; then
        echo "$list_output" | jq -r ".[] | select(.title == \"$title\") | .id" 2>/dev/null | head -1
    else
        # Fallback to awk-based parsing
        # Process JSON to find matching title and extract its id
        echo "$list_output" | awk -v title="$title" '
            /"id"/ {
                match($0, /"id"[[:space:]]*:[[:space:]]*"([a-f0-9]{32})"/, arr)
                if (arr[1]) current_id = arr[1]
            }
            /"title"/ {
                if ($0 ~ "\"" title "\"") {
                    print current_id
                    exit
                }
            }
        '
    fi
}

# Check if all namespaces exist
if [ "$RESET_MODE" = false ]; then
    echo "🔍 Checking for existing KV namespaces..."
    echo ""

    list_output=$(wrangler kv namespace list 2>&1)
    list_exit_code=$?

    if [ $list_exit_code -ne 0 ]; then
        echo "  ⚠️  Warning: Could not list namespaces"
        echo "$list_output"
        echo ""
    else
        all_exist=true
        missing_namespaces=()

        for namespace in "${REQUIRED_NAMESPACES[@]}"; do
            # Check for production namespace
            if command -v jq &> /dev/null; then
                prod_id=$(echo "$list_output" | jq -r ".[] | select(.title == \"$namespace\") | .id" 2>/dev/null | head -1)
                preview_id=$(echo "$list_output" | jq -r ".[] | select(.title | test(\"^${namespace}_preview\"; \"i\")) | .id" 2>/dev/null | head -1)
            else
                prod_id=$(get_namespace_id_by_title "$namespace" "$list_output")
                preview_id=$(echo "$list_output" | awk -v ns="$namespace" '
                    /"id"/ {
                        match($0, /"id"[[:space:]]*:[[:space:]]*"([a-f0-9]{32})"/, arr)
                        if (arr[1]) current_id = arr[1]
                    }
                    /"title"/ {
                        if (tolower($0) ~ tolower(ns "_preview")) {
                            print current_id
                            exit
                        }
                    }
                ')
            fi

            if [ -z "$prod_id" ] || [ -z "$preview_id" ]; then
                all_exist=false
                missing_namespaces+=("$namespace")
            fi
        done

        if [ "$all_exist" = true ]; then
            echo "✅ All required KV namespaces already exist!"
            echo ""
            echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
            echo "📋 Bulk Update Mode"
            echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
            echo ""
            echo "All KV namespaces already exist. What would you like to do?"
            echo ""
            echo "  1) Use all existing namespaces (update wrangler.toml only)"
            echo "  2) Delete and recreate all namespaces (WARNING: all data will be lost)"
            echo "  3) Choose individually for each namespace (interactive mode)"
            echo "  4) Cancel"
            echo ""
            read -p "Enter your choice (1/2/3/4): " -r bulk_choice
            echo ""

            case $bulk_choice in
                1)
                    echo "✅ Using all existing namespaces"
                    echo ""
                    BULK_MODE="use_existing"
                    ;;
                2)
                    echo "⚠️  WARNING: This will DELETE ALL DATA in all namespaces!"
                    echo ""
                    read -p "Are you sure? Type 'YES' to confirm: " -r
                    if [ "$REPLY" != "YES" ]; then
                        echo "❌ Cancelled"
                        exit 1
                    fi
                    echo ""
                    echo "🗑️  Deleting and recreating all namespaces..."
                    echo ""
                    BULK_MODE="recreate_all"
                    ;;
                3)
                    echo "📋 Interactive mode - you'll be asked for each namespace"
                    echo ""
                    BULK_MODE="interactive"
                    ;;
                4)
                    echo "❌ Setup cancelled"
                    exit 1
                    ;;
                *)
                    echo "❌ Invalid choice. Aborting."
                    exit 1
                    ;;
            esac
        else
            echo "ℹ️  Some namespaces don't exist yet:"
            for missing in "${missing_namespaces[@]}"; do
                echo "  • $missing"
            done
            echo ""
            echo "These will be created automatically."
            echo "For existing namespaces, you'll be asked what to do."
            echo ""
            BULK_MODE="interactive"
        fi
    fi
else
    BULK_MODE="reset"
fi

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
            # Fallback: awk-based parsing for preview namespace
            id=$(echo "$list_output" | awk -v ns="$name" '
                /"id"/ {
                    match($0, /"id"[[:space:]]*:[[:space:]]*"([a-f0-9]{32})"/, arr)
                    if (arr[1]) current_id = arr[1]
                }
                /"title"/ {
                    if (tolower($0) ~ tolower(ns "_preview")) {
                        print current_id
                        exit
                    }
                }
            ')
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

        # Handle based on bulk mode
        if [ "$BULK_MODE" = "use_existing" ]; then
            echo "  ✓ [BULK MODE] Using existing namespace with ID: $id" >&2
            echo "$id"
            return 0
        elif [ "$BULK_MODE" = "recreate_all" ] || [ "$RESET_MODE" = true ]; then
            echo "  🗑️  [BULK MODE] Deleting existing namespace: $id" >&2
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
            echo "  ⏳ Waiting 5 seconds for deletion to propagate..." >&2
            sleep 5
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
                    echo "  ⏳ Waiting 5 seconds for deletion to propagate..." >&2
                    sleep 5
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
                    # Fallback: awk-based parsing for preview namespace
                    id=$(echo "$list_output" | awk -v ns="$name" '
                        /"id"/ {
                            match($0, /"id"[[:space:]]*:[[:space:]]*"([a-f0-9]{32})"/, arr)
                            if (arr[1]) current_id = arr[1]
                        }
                        /"title"/ {
                            if (tolower($0) ~ tolower(ns "_preview")) {
                                print current_id
                                exit
                            }
                        }
                    ')
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
echo "Creating production namespaces for environment: $DEPLOY_ENV..."

CLIENTS_CACHE_ID=$(create_kv_namespace "${DEPLOY_ENV}-CLIENTS_CACHE")
echo "✅ ${DEPLOY_ENV}-CLIENTS_CACHE: $CLIENTS_CACHE_ID"

INITIAL_ACCESS_TOKENS_ID=$(create_kv_namespace "${DEPLOY_ENV}-INITIAL_ACCESS_TOKENS")
echo "✅ ${DEPLOY_ENV}-INITIAL_ACCESS_TOKENS: $INITIAL_ACCESS_TOKENS_ID"

SETTINGS_ID=$(create_kv_namespace "${DEPLOY_ENV}-SETTINGS")
echo "✅ ${DEPLOY_ENV}-SETTINGS: $SETTINGS_ID"

REBAC_CACHE_ID=$(create_kv_namespace "${DEPLOY_ENV}-REBAC_CACHE")
echo "✅ ${DEPLOY_ENV}-REBAC_CACHE: $REBAC_CACHE_ID"

echo ""
echo "Creating preview namespaces (for development/testing)..."

# Create preview namespaces
PREVIEW_CLIENTS_CACHE_ID=$(create_kv_namespace "${DEPLOY_ENV}-CLIENTS_CACHE" "--preview")
echo "✅ ${DEPLOY_ENV}-CLIENTS_CACHE (preview): $PREVIEW_CLIENTS_CACHE_ID"

PREVIEW_INITIAL_ACCESS_TOKENS_ID=$(create_kv_namespace "${DEPLOY_ENV}-INITIAL_ACCESS_TOKENS" "--preview")
echo "✅ ${DEPLOY_ENV}-INITIAL_ACCESS_TOKENS (preview): $PREVIEW_INITIAL_ACCESS_TOKENS_ID"

PREVIEW_SETTINGS_ID=$(create_kv_namespace "${DEPLOY_ENV}-SETTINGS" "--preview")
echo "✅ ${DEPLOY_ENV}-SETTINGS (preview): $PREVIEW_SETTINGS_ID"

PREVIEW_REBAC_CACHE_ID=$(create_kv_namespace "${DEPLOY_ENV}-REBAC_CACHE" "--preview")
echo "✅ ${DEPLOY_ENV}-REBAC_CACHE (preview): $PREVIEW_REBAC_CACHE_ID"

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
        echo "    💡 Hint: Run './scripts/setup-dev.sh' first to generate wrangler.toml files"
        return 1
    fi

    # Check if IDs are provided
    if [ -z "$id" ] || [ -z "$preview_id" ]; then
        echo "    ⚠️  Warning: Empty ID provided for $binding (id: '$id', preview_id: '$preview_id')"
        return 1
    fi

    # Check if the binding exists in the file
    if ! grep -q "binding = \"$binding\"" "$file"; then
        echo "    ⚠️  Warning: Binding '$binding' not found in $file"
        echo "    💡 Hint: The wrangler.toml file may need to be regenerated with './scripts/setup-dev.sh'"
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
echo "📝 Updating packages/op-auth/wrangler.${DEPLOY_ENV}.toml..."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
update_wrangler_toml "packages/op-auth/wrangler.${DEPLOY_ENV}.toml" "CLIENTS_CACHE" "$CLIENTS_CACHE_ID" "$PREVIEW_CLIENTS_CACHE_ID"
echo "✅ op-auth updated"

# Update op-management wrangler.toml
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📝 Updating packages/op-management/wrangler.${DEPLOY_ENV}.toml..."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
update_wrangler_toml "packages/op-management/wrangler.${DEPLOY_ENV}.toml" "CLIENTS_CACHE" "$CLIENTS_CACHE_ID" "$PREVIEW_CLIENTS_CACHE_ID"
update_wrangler_toml "packages/op-management/wrangler.${DEPLOY_ENV}.toml" "INITIAL_ACCESS_TOKENS" "$INITIAL_ACCESS_TOKENS_ID" "$PREVIEW_INITIAL_ACCESS_TOKENS_ID"
update_wrangler_toml "packages/op-management/wrangler.${DEPLOY_ENV}.toml" "SETTINGS" "$SETTINGS_ID" "$PREVIEW_SETTINGS_ID"
echo "✅ op-management updated"

# Update policy-service wrangler.toml (ReBAC)
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📝 Updating packages/policy-service/wrangler.${DEPLOY_ENV}.toml..."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
update_wrangler_toml "packages/policy-service/wrangler.${DEPLOY_ENV}.toml" "REBAC_CACHE" "$REBAC_CACHE_ID" "$PREVIEW_REBAC_CACHE_ID"
echo "✅ policy-service updated"

# Update op-token wrangler.toml
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📝 Updating packages/op-token/wrangler.${DEPLOY_ENV}.toml..."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
update_wrangler_toml "packages/op-token/wrangler.${DEPLOY_ENV}.toml" "CLIENTS_CACHE" "$CLIENTS_CACHE_ID" "$PREVIEW_CLIENTS_CACHE_ID"
echo "✅ op-token updated"

# Update op-userinfo wrangler.toml
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📝 Updating packages/op-userinfo/wrangler.${DEPLOY_ENV}.toml..."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
update_wrangler_toml "packages/op-userinfo/wrangler.${DEPLOY_ENV}.toml" "CLIENTS_CACHE" "$CLIENTS_CACHE_ID" "$PREVIEW_CLIENTS_CACHE_ID"
echo "✅ op-userinfo updated"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🎉 Setup complete for environment: $DEPLOY_ENV"
echo ""
echo "Created KV namespaces (production / preview):"
echo "  • ${DEPLOY_ENV}-CLIENTS_CACHE: $CLIENTS_CACHE_ID / $PREVIEW_CLIENTS_CACHE_ID"
echo "  • ${DEPLOY_ENV}-INITIAL_ACCESS_TOKENS: $INITIAL_ACCESS_TOKENS_ID / $PREVIEW_INITIAL_ACCESS_TOKENS_ID"
echo "  • ${DEPLOY_ENV}-SETTINGS: $SETTINGS_ID / $PREVIEW_SETTINGS_ID"
echo "  • ${DEPLOY_ENV}-REBAC_CACHE: $REBAC_CACHE_ID / $PREVIEW_REBAC_CACHE_ID"
echo ""
echo "All wrangler.${DEPLOY_ENV}.toml files have been updated with the correct namespace IDs."
echo ""
echo "📁 Updated files:"
echo "  • packages/op-auth/wrangler.${DEPLOY_ENV}.toml"
echo "  • packages/op-management/wrangler.${DEPLOY_ENV}.toml"
echo "  • packages/op-token/wrangler.${DEPLOY_ENV}.toml"
echo "  • packages/op-userinfo/wrangler.${DEPLOY_ENV}.toml"
echo "  • packages/policy-service/wrangler.${DEPLOY_ENV}.toml"
echo ""
echo "⚠️  Important: After creating or updating KV namespaces, wait 10-30 seconds"
echo "   before deploying to allow Cloudflare to propagate the changes."
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🎯 Initializing default settings..."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Initialize default settings in SETTINGS KV
if [ -f "./scripts/setup-default-settings.sh" ]; then
    if ./scripts/setup-default-settings.sh --env="$DEPLOY_ENV"; then
        echo ""
        echo "✅ Default settings initialized successfully"
    else
        echo ""
        echo "⚠️  Warning: Failed to initialize default settings"
        echo "   You can run it manually later with:"
        echo "   ./scripts/setup-default-settings.sh --env=$DEPLOY_ENV"
    fi
else
    echo "⚠️  Warning: setup-default-settings.sh not found"
    echo "   Skipping default settings initialization"
fi

echo ""
echo "Next steps:"
echo "  1. Run './scripts/setup-secrets.sh --env=$DEPLOY_ENV' to upload secrets"
echo "  2. Run './scripts/setup-d1.sh --env=$DEPLOY_ENV' to set up the database (if needed)"
echo "  3. Run 'pnpm run deploy -- --env=$DEPLOY_ENV' to deploy to $DEPLOY_ENV environment"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
