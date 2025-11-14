#!/bin/bash
#
# Enrai KV Namespace Deletion Script
# This script safely deletes KV namespaces for the Enrai project
#
# Usage:
#   ./delete-kv.sh                 - Interactive mode (prompts for confirmation)
#   ./delete-kv.sh --dry-run       - Dry run mode (shows what would be deleted)
#   ./delete-kv.sh --force         - Force deletion without confirmation (USE WITH CAUTION)
#

set -e

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Parse command line arguments
DRY_RUN=false
FORCE=false
for arg in "$@"; do
    case $arg in
        --dry-run)
            DRY_RUN=true
            shift
            ;;
        --force)
            FORCE=true
            shift
            ;;
        *)
            echo -e "${RED}❌ Unknown option: $arg${NC}"
            echo "Usage: $0 [--dry-run] [--force]"
            exit 1
            ;;
    esac
done

echo -e "${BLUE}⚡️ Enrai KV Namespace Deletion${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

if [ "$DRY_RUN" = true ]; then
    echo -e "${YELLOW}🔍 DRY RUN MODE - No actual deletions will occur${NC}"
    echo ""
fi

# Check if npx is available
if ! command -v npx &> /dev/null; then
    echo -e "${RED}❌ Error: npx is not installed${NC}"
    echo "Please install Node.js and npm"
    exit 1
fi

# Check if user is logged in to Cloudflare
if ! npx wrangler whoami &> /dev/null; then
    echo -e "${RED}❌ Error: Not logged in to Cloudflare${NC}"
    echo "Please run: npx wrangler login"
    exit 1
fi

echo -e "${BLUE}📊 Fetching list of KV namespaces...${NC}"
echo ""

# Get list of all KV namespaces in JSON format
KV_LIST_JSON=$(npx wrangler kv namespace list 2>&1)

if [ $? -ne 0 ]; then
    echo -e "${RED}❌ Error: Failed to fetch KV namespace list${NC}"
    echo "$KV_LIST_JSON"
    exit 1
fi

# Define the KV namespace names we expect to find for Enrai
ENRAI_KV_NAMES=(
    "AUTH_CODES"
    "STATE_STORE"
    "NONCE_STORE"
    "CLIENTS"
    "RATE_LIMIT"
    "REFRESH_TOKENS"
    "REVOKED_TOKENS"
    "INITIAL_ACCESS_TOKENS"
)

# Arrays to store namespaces to delete
declare -a NAMESPACES_TO_DELETE_IDS=()
declare -a NAMESPACES_TO_DELETE_TITLES=()

echo -e "${BLUE}🔍 Searching for Enrai KV namespaces...${NC}"
echo ""

# Function to extract namespace ID by title
get_namespace_id_by_title() {
    local title=$1
    local list_output=$2

    # Try using jq if available for robust JSON parsing
    if command -v jq &> /dev/null; then
        echo "$list_output" | jq -r ".[] | select(.title == \"$title\") | .id" 2>/dev/null | head -1
    else
        # Fallback to grep-based parsing
        echo "$list_output" | grep -A 2 "\"title\"[[:space:]]*:[[:space:]]*\"$title\"" | grep "\"id\"" | grep -o '"[a-f0-9]\{32\}"' | tr -d '"' | head -1
    fi
}

# Search for both production and preview namespaces
for kv_name in "${ENRAI_KV_NAMES[@]}"; do
    # Check for production namespace
    prod_id=$(get_namespace_id_by_title "$kv_name" "$KV_LIST_JSON")
    if [ -n "$prod_id" ]; then
        NAMESPACES_TO_DELETE_IDS+=("$prod_id")
        NAMESPACES_TO_DELETE_TITLES+=("$kv_name (production)")
        echo -e "${GREEN}  ✓ Found: $kv_name (production) - ID: $prod_id${NC}"
    fi

    # Check for preview namespace (can have various suffixes)
    if command -v jq &> /dev/null; then
        preview_id=$(echo "$KV_LIST_JSON" | jq -r ".[] | select(.title | test(\"^${kv_name}_preview\"; \"i\")) | .id" 2>/dev/null | head -1)
    else
        preview_id=$(echo "$KV_LIST_JSON" | grep -i "\"title\".*$kv_name" | grep -i "preview" | grep -o '"[a-f0-9]\{32\}"' | tr -d '"' | head -1)
    fi

    if [ -n "$preview_id" ]; then
        NAMESPACES_TO_DELETE_IDS+=("$preview_id")
        NAMESPACES_TO_DELETE_TITLES+=("$kv_name (preview)")
        echo -e "${GREEN}  ✓ Found: $kv_name (preview) - ID: $preview_id${NC}"
    fi
done

echo ""

# Check if any namespaces were found
if [ ${#NAMESPACES_TO_DELETE_IDS[@]} -eq 0 ]; then
    echo -e "${YELLOW}ℹ️  No Enrai KV namespaces found to delete${NC}"
    echo ""
    echo "If you expected to find namespaces, please check:"
    echo "  1. You are logged in to the correct Cloudflare account"
    echo "  2. The namespaces were created using the setup scripts"
    echo ""
    exit 0
fi

# Display summary
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${YELLOW}⚠️  DELETION SUMMARY${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "The following KV namespaces will be deleted:"
echo ""
for i in "${!NAMESPACES_TO_DELETE_IDS[@]}"; do
    echo -e "  ${RED}✗${NC} ${NAMESPACES_TO_DELETE_TITLES[$i]}"
    echo "    ID: ${NAMESPACES_TO_DELETE_IDS[$i]}"
done
echo ""
echo -e "${RED}⚠️  WARNING: This action cannot be undone!${NC}"
echo -e "${RED}⚠️  All data in these namespaces will be permanently deleted!${NC}"
echo ""

if [ "$DRY_RUN" = true ]; then
    echo -e "${YELLOW}🔍 DRY RUN MODE - No actual deletions occurred${NC}"
    exit 0
fi

# Confirmation prompt (skip if --force is used)
if [ "$FORCE" = false ]; then
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    read -p "Type 'DELETE' to confirm deletion, or anything else to cancel: " -r
    echo ""

    if [ "$REPLY" != "DELETE" ]; then
        echo -e "${BLUE}❌ Deletion cancelled${NC}"
        exit 0
    fi
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${BLUE}🗑️  Deleting KV namespaces...${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

DELETED_COUNT=0
FAILED_COUNT=0

for i in "${!NAMESPACES_TO_DELETE_IDS[@]}"; do
    namespace_id="${NAMESPACES_TO_DELETE_IDS[$i]}"
    namespace_title="${NAMESPACES_TO_DELETE_TITLES[$i]}"

    echo -e "${BLUE}🗑️  Deleting: $namespace_title${NC}"

    # Delete the namespace using wrangler
    if npx wrangler kv namespace delete --namespace-id="$namespace_id" --skip-confirmation 2>&1; then
        echo -e "${GREEN}  ✅ Successfully deleted: $namespace_title${NC}"
        ((DELETED_COUNT++))
    else
        echo -e "${RED}  ❌ Failed to delete: $namespace_title${NC}"
        echo -e "${YELLOW}     This may be because the namespace is still bound to deployed workers${NC}"
        echo -e "${YELLOW}     Consider deleting the workers first or removing the bindings${NC}"
        ((FAILED_COUNT++))
    fi
    echo ""
done

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${BLUE}📊 Deletion Complete${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "Summary:"
echo -e "  ${GREEN}✅ Successfully deleted: $DELETED_COUNT namespaces${NC}"
if [ $FAILED_COUNT -gt 0 ]; then
    echo -e "  ${RED}❌ Failed to delete: $FAILED_COUNT namespaces${NC}"
    echo ""
    echo "Next steps:"
    echo "  1. Delete or undeploy workers that are using these namespaces"
    echo "  2. Run this script again to delete remaining namespaces"
fi
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
