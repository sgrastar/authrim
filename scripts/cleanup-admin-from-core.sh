#!/bin/bash
#
# Authrim Admin Cleanup Script
# This script removes Admin user data from D1_CORE and D1_PII databases.
#
# Part of Admin/EndUser Separation (Phase 7)
# Admin users are now stored in DB_ADMIN, so legacy admin data in D1_CORE/D1_PII
# should be cleaned up.
#
# IMPORTANT: Run this script ONLY after:
#   1. DB_ADMIN is fully operational
#   2. All Admin users have been migrated/recreated in DB_ADMIN
#   3. Admin authentication is working via DB_ADMIN
#
# Usage:
#   ./cleanup-admin-from-core.sh --env=dev --dry-run    - Preview what will be deleted
#   ./cleanup-admin-from-core.sh --env=prod             - Actually delete admin data
#   ./cleanup-admin-from-core.sh --env=dev --core-only  - Only clean D1_CORE
#   ./cleanup-admin-from-core.sh --env=dev --pii-only   - Only clean D1_PII
#

set -e

# Color codes
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
GRAY='\033[0;90m'
NC='\033[0m'

# Parse command line arguments
DRY_RUN=false
DEPLOY_ENV=""
CORE_ONLY=false
PII_ONLY=false
FORCE=false

while [[ $# -gt 0 ]]; do
    case $1 in
        --env=*)
            DEPLOY_ENV="${1#*=}"
            shift
            ;;
        --dry-run)
            DRY_RUN=true
            shift
            ;;
        --core-only)
            CORE_ONLY=true
            shift
            ;;
        --pii-only)
            PII_ONLY=true
            shift
            ;;
        --force)
            FORCE=true
            shift
            ;;
        -h|--help)
            echo "Usage: $0 --env=<dev|staging|prod> [options]"
            echo ""
            echo "Options:"
            echo "  --env=<env>    Target environment (required)"
            echo "  --dry-run      Preview what will be deleted without making changes"
            echo "  --core-only    Only clean D1_CORE database"
            echo "  --pii-only     Only clean D1_PII database"
            echo "  --force        Skip confirmation prompts"
            echo "  -h, --help     Show this help message"
            exit 0
            ;;
        *)
            echo -e "${RED}Unknown option: $1${NC}"
            exit 1
            ;;
    esac
done

# Validate environment
if [ -z "$DEPLOY_ENV" ]; then
    echo -e "${RED}Error: --env is required${NC}"
    echo "Usage: $0 --env=<dev|staging|prod> [--dry-run]"
    exit 1
fi

# Set database names based on environment
case $DEPLOY_ENV in
    dev|development)
        DB_CORE_NAME="authrim-dev"
        DB_PII_NAME="authrim-pii-dev"
        ;;
    staging)
        DB_CORE_NAME="authrim-staging"
        DB_PII_NAME="authrim-pii-staging"
        ;;
    prod|production)
        DB_CORE_NAME="authrim"
        DB_PII_NAME="authrim-pii"
        ;;
    *)
        echo -e "${RED}Unknown environment: $DEPLOY_ENV${NC}"
        exit 1
        ;;
esac

echo -e "${BLUE}============================================${NC}"
echo -e "${BLUE}  Authrim Admin Cleanup Script${NC}"
echo -e "${BLUE}============================================${NC}"
echo ""
echo -e "Environment:    ${GREEN}$DEPLOY_ENV${NC}"
echo -e "D1_CORE:        ${GREEN}$DB_CORE_NAME${NC}"
echo -e "D1_PII:         ${GREEN}$DB_PII_NAME${NC}"
echo -e "Dry Run:        ${YELLOW}$DRY_RUN${NC}"
echo ""

# Function to run wrangler command
run_d1_query() {
    local db_name=$1
    local query=$2
    local output_format=${3:-json}

    if [ "$output_format" = "json" ]; then
        wrangler d1 execute "$db_name" --remote --command="$query" --json 2>/dev/null
    else
        wrangler d1 execute "$db_name" --remote --command="$query" 2>/dev/null
    fi
}

# Function to count admin users in D1_CORE
count_admin_users() {
    echo -e "${GRAY}Counting admin users in D1_CORE...${NC}"
    local result
    result=$(run_d1_query "$DB_CORE_NAME" "SELECT COUNT(*) as count FROM users_core WHERE user_type = 'admin'")

    if [ -z "$result" ]; then
        echo -e "${RED}Failed to query D1_CORE${NC}"
        return 1
    fi

    # Parse JSON result
    local count
    count=$(echo "$result" | grep -o '"count":[0-9]*' | head -1 | grep -o '[0-9]*')

    if [ -z "$count" ]; then
        count=0
    fi

    echo "$count"
}

# Function to get admin user IDs
get_admin_user_ids() {
    echo -e "${GRAY}Fetching admin user IDs from D1_CORE...${NC}" >&2
    local result
    result=$(run_d1_query "$DB_CORE_NAME" "SELECT id FROM users_core WHERE user_type = 'admin'")

    # Parse JSON result to extract IDs
    echo "$result" | grep -o '"id":"[^"]*"' | sed 's/"id":"//g' | sed 's/"//g'
}

# Function to count PII records for given user IDs
count_pii_records() {
    local ids=$1

    if [ -z "$ids" ]; then
        echo "0"
        return
    fi

    # Convert IDs to SQL IN clause
    local id_list
    id_list=$(echo "$ids" | while read -r id; do echo "'$id'"; done | paste -sd,)

    if [ -z "$id_list" ]; then
        echo "0"
        return
    fi

    local result
    result=$(run_d1_query "$DB_PII_NAME" "SELECT COUNT(*) as count FROM users_pii WHERE id IN ($id_list)")

    local count
    count=$(echo "$result" | grep -o '"count":[0-9]*' | head -1 | grep -o '[0-9]*')

    if [ -z "$count" ]; then
        count=0
    fi

    echo "$count"
}

# ============================================================================
# Step 1: Count admin users
# ============================================================================

echo -e "${BLUE}Step 1: Analyzing admin user data...${NC}"

ADMIN_COUNT=$(count_admin_users)

echo -e "  Admin users in D1_CORE:  ${YELLOW}$ADMIN_COUNT${NC}"

if [ "$ADMIN_COUNT" = "0" ]; then
    echo -e "${GREEN}No admin users found in D1_CORE. Cleanup not needed.${NC}"
    exit 0
fi

# Get admin user IDs for PII cleanup
ADMIN_IDS=$(get_admin_user_ids)
ADMIN_ID_COUNT=$(echo "$ADMIN_IDS" | grep -c . || echo "0")

echo -e "  Admin user IDs found:    ${YELLOW}$ADMIN_ID_COUNT${NC}"

# Count PII records
if [ "$PII_ONLY" = "false" ] || [ "$CORE_ONLY" = "false" ]; then
    PII_COUNT=$(count_pii_records "$ADMIN_IDS")
    echo -e "  PII records to clean:    ${YELLOW}$PII_COUNT${NC}"
fi

echo ""

# ============================================================================
# Step 2: Confirmation
# ============================================================================

if [ "$DRY_RUN" = "true" ]; then
    echo -e "${YELLOW}=== DRY RUN MODE ===${NC}"
    echo -e "The following operations would be performed:"
    echo ""

    if [ "$PII_ONLY" = "false" ]; then
        echo -e "  ${BLUE}D1_CORE:${NC}"
        echo -e "    - DELETE $ADMIN_COUNT users from users_core WHERE user_type = 'admin'"
        echo -e "    - CASCADE delete from role_assignments"
    fi

    if [ "$CORE_ONLY" = "false" ]; then
        echo -e "  ${BLUE}D1_PII:${NC}"
        echo -e "    - DELETE $PII_COUNT records from users_pii"
        echo -e "    - DELETE related records from linked_identities"
        echo -e "    - DELETE related records from subject_identifiers"
    fi

    echo ""
    echo -e "${YELLOW}Admin user IDs to be deleted:${NC}"
    echo "$ADMIN_IDS" | head -20
    if [ "$ADMIN_ID_COUNT" -gt 20 ]; then
        echo "... and $((ADMIN_ID_COUNT - 20)) more"
    fi

    echo ""
    echo -e "${GREEN}Dry run complete. No changes were made.${NC}"
    echo -e "Run without --dry-run to actually delete the data."
    exit 0
fi

# Confirmation prompt
if [ "$FORCE" = "false" ]; then
    echo -e "${RED}WARNING: This operation will permanently delete admin user data.${NC}"
    echo ""
    echo -e "  D1_CORE: $ADMIN_COUNT users"
    echo -e "  D1_PII:  $PII_COUNT records"
    echo ""
    read -p "Are you sure you want to proceed? (yes/no): " confirm

    if [ "$confirm" != "yes" ]; then
        echo -e "${YELLOW}Cleanup cancelled.${NC}"
        exit 0
    fi
fi

# ============================================================================
# Step 3: Execute D1_CORE cleanup
# ============================================================================

if [ "$PII_ONLY" = "false" ]; then
    echo -e "${BLUE}Step 2: Cleaning up D1_CORE...${NC}"

    # Apply migration
    echo -e "  Applying migration 046_cleanup_admin_from_core.sql..."

    wrangler d1 execute "$DB_CORE_NAME" --remote --file="migrations/046_cleanup_admin_from_core.sql"

    # Verify cleanup
    REMAINING=$(count_admin_users)

    if [ "$REMAINING" = "0" ]; then
        echo -e "  ${GREEN}✓ D1_CORE cleanup complete. Admin users removed: $ADMIN_COUNT${NC}"
    else
        echo -e "  ${RED}✗ Cleanup incomplete. $REMAINING admin users remaining.${NC}"
        exit 1
    fi
fi

# ============================================================================
# Step 4: Execute D1_PII cleanup
# ============================================================================

if [ "$CORE_ONLY" = "false" ] && [ -n "$ADMIN_IDS" ]; then
    echo -e "${BLUE}Step 3: Cleaning up D1_PII...${NC}"

    # Convert IDs to SQL IN clause
    ID_LIST=$(echo "$ADMIN_IDS" | while read -r id; do echo "'$id'"; done | paste -sd,)

    if [ -n "$ID_LIST" ]; then
        # Delete from users_pii
        echo -e "  Deleting from users_pii..."
        run_d1_query "$DB_PII_NAME" "DELETE FROM users_pii WHERE id IN ($ID_LIST)" "text"

        # Delete from linked_identities
        echo -e "  Deleting from linked_identities..."
        run_d1_query "$DB_PII_NAME" "DELETE FROM linked_identities WHERE user_id IN ($ID_LIST)" "text"

        # Delete from subject_identifiers
        echo -e "  Deleting from subject_identifiers..."
        run_d1_query "$DB_PII_NAME" "DELETE FROM subject_identifiers WHERE user_id IN ($ID_LIST)" "text"

        echo -e "  ${GREEN}✓ D1_PII cleanup complete.${NC}"
    else
        echo -e "  ${YELLOW}No admin user IDs to clean from D1_PII${NC}"
    fi
fi

# ============================================================================
# Summary
# ============================================================================

echo ""
echo -e "${GREEN}============================================${NC}"
echo -e "${GREEN}  Cleanup Complete!${NC}"
echo -e "${GREEN}============================================${NC}"
echo ""
echo -e "Summary:"
if [ "$PII_ONLY" = "false" ]; then
    echo -e "  D1_CORE: Removed $ADMIN_COUNT admin users"
fi
if [ "$CORE_ONLY" = "false" ]; then
    echo -e "  D1_PII:  Removed $PII_COUNT PII records"
fi
echo ""
echo -e "Admin users are now fully separated into DB_ADMIN."
echo -e "The user_type='admin' value in D1_CORE is deprecated."
