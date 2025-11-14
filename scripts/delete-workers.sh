#!/bin/bash
#
# Enrai Workers Deletion Script
# This script safely deletes Cloudflare Workers for the Enrai project
#
# Usage:
#   ./delete-workers.sh                      - Interactive mode (prompts for workers and confirmation)
#   ./delete-workers.sh --dry-run            - Dry run mode (shows what would be deleted)
#   ./delete-workers.sh --force              - Force deletion without confirmation (USE WITH CAUTION)
#   ./delete-workers.sh --all                - Delete all Enrai workers
#   ./delete-workers.sh --worker enrai-auth  - Delete specific worker
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
DELETE_ALL=false
SPECIFIC_WORKER=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --dry-run)
            DRY_RUN=true
            shift
            ;;
        --force)
            FORCE=true
            shift
            ;;
        --all)
            DELETE_ALL=true
            shift
            ;;
        --worker)
            SPECIFIC_WORKER="$2"
            shift 2
            ;;
        *)
            echo -e "${RED}❌ Unknown option: $1${NC}"
            echo "Usage: $0 [--dry-run] [--force] [--all] [--worker WORKER_NAME]"
            exit 1
            ;;
    esac
done

echo -e "${BLUE}⚡️ Enrai Workers Deletion${NC}"
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

# Get Cloudflare account ID and API token from wrangler
ACCOUNT_ID=$(npx wrangler whoami 2>&1 | grep -oE "Account ID: [a-f0-9]+" | grep -oE "[a-f0-9]{32}" | head -1)

if [ -z "$ACCOUNT_ID" ]; then
    echo -e "${RED}❌ Error: Could not determine Cloudflare Account ID${NC}"
    echo "Please ensure you are logged in with: npx wrangler login"
    exit 1
fi

echo -e "${BLUE}📊 Fetching list of Workers...${NC}"
echo "Account ID: $ACCOUNT_ID"
echo ""

# Get API token from wrangler config
WRANGLER_CONFIG_DIR="${HOME}/.wrangler/config"
API_TOKEN=""

# Try to get token from wrangler config
if [ -f "$WRANGLER_CONFIG_DIR/default.toml" ]; then
    API_TOKEN=$(grep -oE 'api_token = "[^"]+"' "$WRANGLER_CONFIG_DIR/default.toml" | cut -d'"' -f2)
fi

# If we couldn't get the token from config, check environment
if [ -z "$API_TOKEN" ]; then
    if [ -n "$CLOUDFLARE_API_TOKEN" ]; then
        API_TOKEN="$CLOUDFLARE_API_TOKEN"
    elif [ -n "$CF_API_TOKEN" ]; then
        API_TOKEN="$CF_API_TOKEN"
    fi
fi

# If still no token, we need to inform the user
if [ -z "$API_TOKEN" ]; then
    echo -e "${RED}❌ Error: Could not find Cloudflare API token${NC}"
    echo ""
    echo "To use this script, you need to provide a Cloudflare API token."
    echo ""
    echo "Option 1: Set environment variable"
    echo "  export CLOUDFLARE_API_TOKEN=your_token_here"
    echo "  ./delete-workers.sh"
    echo ""
    echo "Option 2: Get token from Cloudflare dashboard"
    echo "  1. Go to: https://dash.cloudflare.com/profile/api-tokens"
    echo "  2. Create a token with 'Workers Scripts:Edit' permission"
    echo "  3. Set as environment variable: export CLOUDFLARE_API_TOKEN=your_token"
    echo ""
    exit 1
fi

# Fetch workers using Cloudflare API
WORKERS_JSON=$(curl -s -X GET "https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/workers/scripts" \
    -H "Authorization: Bearer ${API_TOKEN}" \
    -H "Content-Type: application/json")

# Check if API call was successful
if ! echo "$WORKERS_JSON" | grep -q '"success":true'; then
    echo -e "${RED}❌ Error: Failed to fetch workers list from Cloudflare API${NC}"
    echo ""
    echo "API Response:"
    echo "$WORKERS_JSON" | head -20
    echo ""
    echo "Please check:"
    echo "  1. Your API token has 'Workers Scripts:Read' permission"
    echo "  2. Your account ID is correct: $ACCOUNT_ID"
    echo "  3. You have workers deployed in this account"
    echo ""
    exit 1
fi

# Define the worker names for Enrai project
ENRAI_WORKER_NAMES=(
    "enrai-shared"
    "enrai-op-auth"
    "enrai-op-discovery"
    "enrai-op-management"
    "enrai-op-token"
    "enrai-op-userinfo"
    "enrai-router"
)

# Arrays to store workers to delete
declare -a WORKERS_TO_DELETE=()

echo -e "${BLUE}🔍 Searching for Enrai workers...${NC}"
echo ""

# Extract worker names from JSON response
if [ -n "$SPECIFIC_WORKER" ]; then
    # Check if specific worker exists
    if echo "$WORKERS_JSON" | grep -q "\"id\":\"$SPECIFIC_WORKER\""; then
        WORKERS_TO_DELETE+=("$SPECIFIC_WORKER")
        echo -e "${GREEN}  ✓ Found: $SPECIFIC_WORKER${NC}"
    else
        echo -e "${YELLOW}⚠️  Worker not found: $SPECIFIC_WORKER${NC}"
        exit 0
    fi
elif [ "$DELETE_ALL" = true ]; then
    # Search for all Enrai workers
    for worker_name in "${ENRAI_WORKER_NAMES[@]}"; do
        if echo "$WORKERS_JSON" | grep -q "\"id\":\"$worker_name\""; then
            WORKERS_TO_DELETE+=("$worker_name")
            echo -e "${GREEN}  ✓ Found: $worker_name${NC}"
        fi
    done
else
    # Interactive mode - let user select workers
    echo "Available Enrai workers:"
    echo ""

    worker_index=1
    declare -a AVAILABLE_WORKERS=()

    for worker_name in "${ENRAI_WORKER_NAMES[@]}"; do
        if echo "$WORKERS_JSON" | grep -q "\"id\":\"$worker_name\""; then
            AVAILABLE_WORKERS+=("$worker_name")
            echo "  $worker_index) $worker_name"
            ((worker_index++))
        fi
    done

    if [ ${#AVAILABLE_WORKERS[@]} -eq 0 ]; then
        echo -e "${YELLOW}ℹ️  No Enrai workers found${NC}"
        exit 0
    fi

    echo "  A) Delete all Enrai workers"
    echo "  C) Cancel"
    echo ""
    read -p "Enter your choice (number, A, or C): " -r choice
    echo ""

    if [[ "$choice" =~ ^[Aa]$ ]]; then
        WORKERS_TO_DELETE=("${AVAILABLE_WORKERS[@]}")
    elif [[ "$choice" =~ ^[Cc]$ ]]; then
        echo -e "${BLUE}❌ Cancelled${NC}"
        exit 0
    elif [[ "$choice" =~ ^[0-9]+$ ]] && [ "$choice" -ge 1 ] && [ "$choice" -le ${#AVAILABLE_WORKERS[@]} ]; then
        WORKERS_TO_DELETE+=("${AVAILABLE_WORKERS[$((choice-1))]}")
    else
        echo -e "${RED}❌ Invalid choice${NC}"
        exit 1
    fi
fi

echo ""

# Check if any workers were found
if [ ${#WORKERS_TO_DELETE[@]} -eq 0 ]; then
    echo -e "${YELLOW}ℹ️  No Enrai workers found to delete${NC}"
    echo ""
    echo "If you expected to find workers, please check:"
    echo "  1. You are logged in to the correct Cloudflare account"
    echo "  2. The workers are deployed"
    echo "  3. The worker names match the expected pattern (enrai-*)"
    echo ""
    exit 0
fi

# Display summary
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${YELLOW}⚠️  DELETION SUMMARY${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "The following workers will be deleted:"
echo ""
for worker in "${WORKERS_TO_DELETE[@]}"; do
    echo -e "  ${RED}✗${NC} $worker"
done
echo ""
echo -e "${RED}⚠️  WARNING: This will delete the workers and their associated Durable Objects!${NC}"
echo -e "${RED}⚠️  This action cannot be undone!${NC}"
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
echo -e "${BLUE}🗑️  Deleting workers...${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

DELETED_COUNT=0
FAILED_COUNT=0

for worker in "${WORKERS_TO_DELETE[@]}"; do
    echo -e "${BLUE}🗑️  Deleting: $worker${NC}"

    # Delete the worker using Cloudflare API with force=true to delete associated Durable Objects
    DELETE_RESPONSE=$(curl -s -X DELETE \
        "https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/workers/scripts/${worker}?force=true" \
        -H "Authorization: Bearer ${API_TOKEN}" \
        -H "Content-Type: application/json")

    # Check if deletion was successful
    if echo "$DELETE_RESPONSE" | grep -q '"success":true'; then
        echo -e "${GREEN}  ✅ Successfully deleted: $worker${NC}"
        ((DELETED_COUNT++))
    else
        echo -e "${RED}  ❌ Failed to delete: $worker${NC}"

        # Try to extract error message
        ERROR_MSG=$(echo "$DELETE_RESPONSE" | grep -oE '"message":"[^"]*"' | head -1 | cut -d'"' -f4)
        if [ -n "$ERROR_MSG" ]; then
            echo -e "${YELLOW}     Error: $ERROR_MSG${NC}"
        fi

        ((FAILED_COUNT++))
    fi
    echo ""
done

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${BLUE}📊 Deletion Complete${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "Summary:"
echo -e "  ${GREEN}✅ Successfully deleted: $DELETED_COUNT workers${NC}"
if [ $FAILED_COUNT -gt 0 ]; then
    echo -e "  ${RED}❌ Failed to delete: $FAILED_COUNT workers${NC}"
    echo ""
    echo "Next steps:"
    echo "  1. Check the error messages above"
    echo "  2. Verify your API token has the correct permissions"
    echo "  3. Try deleting from the Cloudflare dashboard if the issue persists"
fi
echo ""
echo "Note: Associated Durable Objects were also deleted with the workers"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
