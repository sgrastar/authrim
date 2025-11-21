#!/bin/bash
#
# Authrim Complete Deletion Script
# This script safely deletes ALL Cloudflare resources for the Authrim project
#
# This is a master script that orchestrates the deletion of:
#   - Workers (and associated Durable Objects)
#   - KV Namespaces
#   - D1 Databases
#
# Usage:
#   ./delete-all.sh                 - Interactive mode (prompts for environment and confirmation)
#   ./delete-all.sh dev             - Delete all dev resources with confirmation
#   ./delete-all.sh prod            - Delete all prod resources with confirmation
#   ./delete-all.sh --dry-run       - Dry run mode (shows what would be deleted)
#   ./delete-all.sh dev --force     - Force deletion without confirmation (USE WITH EXTREME CAUTION)
#

set -e

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
MAGENTA='\033[0;35m'
NC='\033[0m' # No Color

# Get the directory where this script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

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

echo ""
echo -e "${MAGENTA}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${MAGENTA}⚡️  Authrim Complete Resource Deletion${NC}"
echo -e "${MAGENTA}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

if [ "$DRY_RUN" = true ]; then
    echo -e "${YELLOW}🔍 DRY RUN MODE - No actual deletions will occur${NC}"
    echo ""
fi

# If environment not specified, prompt for it
if [ -z "$ENV" ]; then
    echo "This script will delete ALL Authrim resources for a specific environment."
    echo ""
    echo -e "${YELLOW}⚠️  Environment Explanation:${NC}"
    echo ""
    echo "  • dev      : Development environment (local testing, wrangler dev)"
    echo "  • prod     : Production environment (live deployment, *.workers.dev)"
    echo "  • staging  : Staging environment (pre-production testing)"
    echo ""
    echo "ℹ️  Note: Most users only use 'dev' for local development."
    echo "         'prod' and 'staging' are for deployed workers."
    echo ""
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
    echo "Select environment to delete:"
    echo "  1) dev      (Development - Local testing)"
    echo "  2) prod     (Production - Live deployment)"
    echo "  3) staging  (Staging - Pre-production)"
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

echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${YELLOW}⚠️  DELETION PLAN${NC}"
echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo "Environment: $ENV"
echo ""
echo "The following resources will be deleted in this order:"
echo ""
echo "  1. 🔧 Cloudflare Workers (and Durable Objects)"
echo "     • authrim-shared"
echo "     • authrim-op-auth"
echo "     • authrim-op-discovery"
echo "     • authrim-op-management"
echo "     • authrim-op-token"
echo "     • authrim-op-userinfo"
echo "     • authrim-router"
echo ""
echo "  2. 📦 KV Namespaces (production and preview)"
echo "     • AUTH_CODES"
echo "     • STATE_STORE"
echo "     • NONCE_STORE"
echo "     • CLIENTS"
echo "     • RATE_LIMIT"
echo "     • REFRESH_TOKENS"
echo "     • REVOKED_TOKENS"
echo "     • INITIAL_ACCESS_TOKENS"
echo ""
echo "  3. 🗄️  D1 Database"
echo "     • authrim-${ENV}"
echo ""
echo -e "${RED}⚠️  WARNING: This action CANNOT be undone!${NC}"
echo -e "${RED}⚠️  ALL data will be permanently deleted!${NC}"
echo ""

if [ "$DRY_RUN" = true ]; then
    echo -e "${YELLOW}🔍 DRY RUN MODE - Showing what would be deleted...${NC}"
    echo ""

    # Run dry-run for each deletion script
    echo -e "${BLUE}━━━ Workers (Dry Run) ━━━${NC}"
    if [ -f "$SCRIPT_DIR/delete-workers.sh" ]; then
        bash "$SCRIPT_DIR/delete-workers.sh" --dry-run --all
    else
        echo -e "${YELLOW}⚠️  delete-workers.sh not found${NC}"
    fi
    echo ""

    echo -e "${BLUE}━━━ KV Namespaces (Dry Run) ━━━${NC}"
    if [ -f "$SCRIPT_DIR/delete-kv.sh" ]; then
        bash "$SCRIPT_DIR/delete-kv.sh" --dry-run
    else
        echo -e "${YELLOW}⚠️  delete-kv.sh not found${NC}"
    fi
    echo ""

    echo -e "${BLUE}━━━ D1 Database (Dry Run) ━━━${NC}"
    if [ -f "$SCRIPT_DIR/delete-d1.sh" ]; then
        bash "$SCRIPT_DIR/delete-d1.sh" "$ENV" --dry-run
    else
        echo -e "${YELLOW}⚠️  delete-d1.sh not found${NC}"
    fi
    echo ""

    echo -e "${YELLOW}🔍 DRY RUN COMPLETE - No actual deletions occurred${NC}"
    exit 0
fi

# Final confirmation (skip if --force is used)
if [ "$FORCE" = false ]; then
    echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""

    if [ "$ENV" = "prod" ]; then
        echo -e "${RED}⚠️  YOU ARE ABOUT TO DELETE ALL PRODUCTION RESOURCES!${NC}"
        echo -e "${RED}⚠️  THIS WILL COMPLETELY DESTROY YOUR PRODUCTION ENVIRONMENT!${NC}"
        echo ""
        read -p "Type 'DELETE PRODUCTION' to confirm, or anything else to cancel: " -r
        echo ""
        if [ "$REPLY" != "DELETE PRODUCTION" ]; then
            echo -e "${BLUE}❌ Deletion cancelled${NC}"
            exit 0
        fi
    else
        echo -e "${YELLOW}⚠️  You are about to delete all $ENV resources!${NC}"
        echo ""
        read -p "Type 'DELETE ALL' to confirm, or anything else to cancel: " -r
        echo ""
        if [ "$REPLY" != "DELETE ALL" ]; then
            echo -e "${BLUE}❌ Deletion cancelled${NC}"
            exit 0
        fi
    fi

    # Double confirmation for production
    if [ "$ENV" = "prod" ]; then
        echo ""
        echo -e "${RED}⚠️  FINAL WARNING FOR PRODUCTION!${NC}"
        echo ""
        read -p "Are you absolutely sure? Type 'YES' to proceed: " -r
        echo ""
        if [ "$REPLY" != "YES" ]; then
            echo -e "${BLUE}❌ Deletion cancelled${NC}"
            exit 0
        fi
    fi
fi

echo ""
echo -e "${MAGENTA}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${MAGENTA}🗑️  Starting Deletion Process${NC}"
echo -e "${MAGENTA}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

OVERALL_SUCCESS=true

# Step 1: Delete Workers (this also deletes Durable Objects)
echo ""
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}Step 1/3: Deleting Workers and Durable Objects${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

if [ -f "$SCRIPT_DIR/delete-workers.sh" ]; then
    if bash "$SCRIPT_DIR/delete-workers.sh" --all --force; then
        echo -e "${GREEN}✅ Workers deleted successfully${NC}"
    else
        echo -e "${RED}❌ Failed to delete some or all workers${NC}"
        OVERALL_SUCCESS=false
    fi
else
    echo -e "${RED}❌ Error: delete-workers.sh not found in $SCRIPT_DIR${NC}"
    OVERALL_SUCCESS=false
fi

# Wait a bit for Cloudflare to propagate the changes
echo ""
echo -e "${YELLOW}⏳ Waiting 10 seconds for Cloudflare to propagate changes...${NC}"
sleep 10

# Step 2: Delete KV Namespaces
echo ""
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}Step 2/3: Deleting KV Namespaces${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

if [ -f "$SCRIPT_DIR/delete-kv.sh" ]; then
    if bash "$SCRIPT_DIR/delete-kv.sh" --force; then
        echo -e "${GREEN}✅ KV namespaces deleted successfully${NC}"
    else
        echo -e "${RED}❌ Failed to delete some or all KV namespaces${NC}"
        OVERALL_SUCCESS=false
    fi
else
    echo -e "${RED}❌ Error: delete-kv.sh not found in $SCRIPT_DIR${NC}"
    OVERALL_SUCCESS=false
fi

# Step 3: Delete D1 Database
echo ""
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}Step 3/3: Deleting D1 Database${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

if [ -f "$SCRIPT_DIR/delete-d1.sh" ]; then
    if bash "$SCRIPT_DIR/delete-d1.sh" "$ENV" --force; then
        echo -e "${GREEN}✅ D1 database deleted successfully${NC}"
    else
        echo -e "${RED}❌ Failed to delete D1 database${NC}"
        OVERALL_SUCCESS=false
    fi
else
    echo -e "${RED}❌ Error: delete-d1.sh not found in $SCRIPT_DIR${NC}"
    OVERALL_SUCCESS=false
fi

# Final summary
echo ""
echo -e "${MAGENTA}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${MAGENTA}📊 Deletion Process Complete${NC}"
echo -e "${MAGENTA}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

if [ "$OVERALL_SUCCESS" = true ]; then
    echo -e "${GREEN}✅ All resources for environment '$ENV' have been deleted successfully!${NC}"
    echo ""
    echo "To redeploy from scratch:"
    echo "  1. Run setup scripts:"
    echo "     ./scripts/setup-dev.sh"
    echo "     ./scripts/setup-kv.sh"
    echo "     ./scripts/setup-d1.sh"
    echo "     ./scripts/setup-durable-objects.sh"
    echo "  2. Deploy workers:"
    echo "     pnpm run deploy:retry"
else
    echo -e "${YELLOW}⚠️  Deletion process completed with some errors${NC}"
    echo ""
    echo "Please review the error messages above and:"
    echo "  1. Check which resources failed to delete"
    echo "  2. Try running individual deletion scripts for those resources"
    echo "  3. Verify resources in the Cloudflare dashboard"
fi

echo ""
echo -e "${MAGENTA}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
