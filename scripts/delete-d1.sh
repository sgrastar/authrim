#!/bin/bash
#
# Enrai D1 Database Deletion Script
# This script safely deletes D1 databases for the Enrai project
#
# Usage:
#   ./delete-d1.sh                 - Interactive mode (prompts for environment and confirmation)
#   ./delete-d1.sh dev             - Delete dev database with confirmation
#   ./delete-d1.sh prod            - Delete prod database with confirmation
#   ./delete-d1.sh --dry-run       - Dry run mode (shows what would be deleted)
#   ./delete-d1.sh dev --force     - Force deletion without confirmation (USE WITH CAUTION)
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
ENV=""

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
        dev|prod|staging)
            ENV=$arg
            shift
            ;;
        *)
            if [ -n "$arg" ]; then
                echo -e "${RED}❌ Unknown option: $arg${NC}"
                echo "Usage: $0 [dev|prod|staging] [--dry-run] [--force]"
                exit 1
            fi
            ;;
    esac
done

echo -e "${BLUE}⚡️ Enrai D1 Database Deletion${NC}"
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

# If environment not specified, prompt for it
if [ -z "$ENV" ]; then
    echo "Select environment to delete:"
    echo "  1) dev"
    echo "  2) prod"
    echo "  3) staging"
    echo "  4) Cancel"
    echo ""
    read -p "Enter your choice (1-4): " -r choice

    case $choice in
        1)
            ENV="dev"
            ;;
        2)
            ENV="prod"
            ;;
        3)
            ENV="staging"
            ;;
        4|*)
            echo -e "${BLUE}❌ Cancelled${NC}"
            exit 0
            ;;
    esac
    echo ""
fi

DB_NAME="enrai-${ENV}"

echo -e "${BLUE}📊 Checking for D1 database: $DB_NAME${NC}"
echo ""

# Check if database exists
DB_EXISTS=false
DB_INFO=""
if npx wrangler d1 info "$DB_NAME" &> /dev/null; then
    DB_EXISTS=true
    DB_INFO=$(npx wrangler d1 info "$DB_NAME" 2>&1)
fi

if [ "$DB_EXISTS" = false ]; then
    echo -e "${YELLOW}ℹ️  Database not found: $DB_NAME${NC}"
    echo ""
    echo "If you expected to find this database, please check:"
    echo "  1. You are logged in to the correct Cloudflare account"
    echo "  2. The database was created using the setup scripts"
    echo "  3. The database name is correct (enrai-${ENV})"
    echo ""
    exit 0
fi

# Try to extract database ID
DB_LIST_JSON=$(npx wrangler d1 list --json 2>/dev/null || echo "")
DB_ID=""

if [ -n "$DB_LIST_JSON" ]; then
    if command -v jq &> /dev/null; then
        DB_ID=$(echo "$DB_LIST_JSON" | jq -r ".[] | select(.name == \"$DB_NAME\") | .uuid" 2>/dev/null | head -1)
    else
        DB_ID=$(echo "$DB_LIST_JSON" | grep -A 1 "\"name\": \"$DB_NAME\"" | grep -oE '"uuid": "([a-f0-9-]{36})"' | grep -oE '[a-f0-9-]{36}')
    fi
fi

# Fallback: extract from info output
if [ -z "$DB_ID" ]; then
    DB_ID=$(echo "$DB_INFO" | grep -oE '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}' | head -1)
fi

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${YELLOW}⚠️  DELETION SUMMARY${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "The following D1 database will be deleted:"
echo ""
echo -e "  ${RED}✗${NC} Database Name: $DB_NAME"
if [ -n "$DB_ID" ]; then
    echo "    Database ID: $DB_ID"
fi
echo "    Environment: $ENV"
echo ""
echo -e "${RED}⚠️  WARNING: This action cannot be undone!${NC}"
echo -e "${RED}⚠️  All data in this database will be permanently deleted!${NC}"

# Try to show table information
echo ""
echo -e "${BLUE}📊 Database contents:${NC}"
TABLES=$(npx wrangler d1 execute "$DB_NAME" --command="SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;" 2>/dev/null || echo "")
if [ -n "$TABLES" ]; then
    echo "$TABLES"
else
    echo "  (Unable to retrieve table information)"
fi
echo ""

if [ "$DRY_RUN" = true ]; then
    echo -e "${YELLOW}🔍 DRY RUN MODE - No actual deletions occurred${NC}"
    exit 0
fi

# Confirmation prompt (skip if --force is used)
if [ "$FORCE" = false ]; then
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    if [ "$ENV" = "prod" ]; then
        echo -e "${RED}⚠️  YOU ARE ABOUT TO DELETE THE PRODUCTION DATABASE!${NC}"
        echo ""
        read -p "Type 'DELETE PRODUCTION' to confirm, or anything else to cancel: " -r
        echo ""
        if [ "$REPLY" != "DELETE PRODUCTION" ]; then
            echo -e "${BLUE}❌ Deletion cancelled${NC}"
            exit 0
        fi
    else
        read -p "Type 'DELETE' to confirm deletion, or anything else to cancel: " -r
        echo ""
        if [ "$REPLY" != "DELETE" ]; then
            echo -e "${BLUE}❌ Deletion cancelled${NC}"
            exit 0
        fi
    fi
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${BLUE}🗑️  Deleting D1 database...${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Delete the database using wrangler
if npx wrangler d1 delete "$DB_NAME" --skip-confirmation; then
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo -e "${GREEN}✅ Database deleted successfully!${NC}"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo "Database deleted: $DB_NAME"
    echo ""
    echo "Next steps:"
    echo "  1. Remove D1 bindings from wrangler.toml files if needed"
    echo "  2. To recreate the database, run: ./scripts/setup-d1.sh"
    echo ""
else
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo -e "${RED}❌ Failed to delete database${NC}"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo "Possible reasons:"
    echo "  1. The database is currently being used by deployed workers"
    echo "  2. You don't have permission to delete this database"
    echo "  3. Network or API error"
    echo ""
    echo "Try:"
    echo "  1. Delete or undeploy workers using this database first"
    echo "  2. Check your Cloudflare account permissions"
    echo "  3. Wait a few minutes and try again"
    echo ""
    exit 1
fi

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
