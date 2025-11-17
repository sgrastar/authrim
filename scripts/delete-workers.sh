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

# Get Cloudflare account ID from wrangler
# Parse the table format output from wrangler whoami
WHOAMI_OUTPUT=$(npx wrangler whoami 2>&1)

# Try multiple methods to extract Account ID
# Method 1: Parse table format (works with wrangler 3.x+)
ACCOUNT_ID=$(echo "$WHOAMI_OUTPUT" | grep -oE '[a-f0-9]{32}' | head -1)

# Method 2: If method 1 fails, try legacy format
if [ -z "$ACCOUNT_ID" ]; then
    ACCOUNT_ID=$(echo "$WHOAMI_OUTPUT" | grep -oE "Account ID: [a-f0-9]+" | grep -oE "[a-f0-9]{32}" | head -1)
fi

if [ -z "$ACCOUNT_ID" ]; then
    echo -e "${RED}❌ Error: Could not determine Cloudflare Account ID${NC}"
    echo ""
    echo "Debug information:"
    echo "$WHOAMI_OUTPUT"
    echo ""
    echo "Please ensure you are logged in with: npx wrangler login"
    exit 1
fi

echo -e "${BLUE}📊 Checking for deployed Workers...${NC}"
echo "Account ID: $ACCOUNT_ID"
echo ""

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

echo -e "${BLUE}🔍 Checking which Enrai workers are deployed...${NC}"
echo ""

# Function to check if a worker exists
check_worker_exists() {
    local worker_name="$1"
    # Try to get worker info using wrangler (will fail silently if not found)
    if npx wrangler deployments list --name "$worker_name" 2>&1 | grep -qiE "(deployment|version|created)"; then
        return 0  # Worker exists
    else
        return 1  # Worker doesn't exist
    fi
}

# Build list of workers based on mode
if [ -n "$SPECIFIC_WORKER" ]; then
    # Check if specific worker exists
    echo "Checking: $SPECIFIC_WORKER..."
    if check_worker_exists "$SPECIFIC_WORKER"; then
        WORKERS_TO_DELETE+=("$SPECIFIC_WORKER")
        echo -e "${GREEN}  ✓ Found: $SPECIFIC_WORKER${NC}"
    else
        echo -e "${YELLOW}⚠️  Worker not found: $SPECIFIC_WORKER${NC}"
        exit 0
    fi
elif [ "$DELETE_ALL" = true ]; then
    # Add all Enrai workers (we'll check if they exist during deletion)
    echo "Preparing to delete all Enrai workers..."
    echo ""
    WORKERS_TO_DELETE=("${ENRAI_WORKER_NAMES[@]}")
    echo -e "${BLUE}ℹ️  Will attempt to delete ${#WORKERS_TO_DELETE[@]} workers${NC}"
    echo -e "${YELLOW}   (Workers that don't exist will be skipped)${NC}"
else
    # Interactive mode - let user select workers
    echo "Checking for deployed Enrai workers..."
    echo ""

    worker_index=1
    declare -a AVAILABLE_WORKERS=()

    for worker_name in "${ENRAI_WORKER_NAMES[@]}"; do
        echo -n "  Checking $worker_name... "
        if check_worker_exists "$worker_name"; then
            AVAILABLE_WORKERS+=("$worker_name")
            echo -e "${GREEN}✓${NC}"
        else
            echo -e "${YELLOW}not deployed${NC}"
        fi
    done

    echo ""

    if [ ${#AVAILABLE_WORKERS[@]} -eq 0 ]; then
        echo -e "${YELLOW}ℹ️  No Enrai workers found${NC}"
        exit 0
    fi

    echo "Available Enrai workers:"
    echo ""
    for i in "${!AVAILABLE_WORKERS[@]}"; do
        echo "  $((i+1))) ${AVAILABLE_WORKERS[$i]}"
    done

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

    # Delete the worker using wrangler delete command with --name option
    DELETE_OUTPUT=$(npx wrangler delete --name "$worker" --force 2>&1)
    DELETE_EXIT_CODE=$?

    # Display the output
    echo "$DELETE_OUTPUT"

    # Check if deletion was successful (exit code 0 or output contains success message)
    if [ $DELETE_EXIT_CODE -eq 0 ] || echo "$DELETE_OUTPUT" | grep -qiE "(deleted|success|removed)"; then
        echo -e "${GREEN}  ✅ Successfully deleted: $worker${NC}"
        ((DELETED_COUNT++))
    else
        echo -e "${RED}  ❌ Failed to delete: $worker${NC}"
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
    echo "  2. Ensure you are logged in: npx wrangler login"
    echo "  3. Try deleting from the Cloudflare dashboard if the issue persists"
    echo "     Dashboard: https://dash.cloudflare.com/"
fi
echo ""
echo "Note: Associated Durable Objects are also deleted when workers are deleted"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
