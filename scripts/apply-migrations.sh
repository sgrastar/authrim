#!/bin/bash
#
# Apply D1 Database Migrations
# Applies all SQL migration files to the specified environment's database
#
# Usage:
#   ./scripts/apply-migrations.sh --env=conformance
#   ./scripts/apply-migrations.sh --env=dev
#

set -e

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

# Parse arguments
ENV=""
for arg in "$@"; do
    if [[ $arg == --env=* ]]; then
        ENV="${arg#--env=}"
    fi
done

# Validate environment
if [ -z "$ENV" ]; then
    echo -e "${RED}❌ Error: --env parameter is required${NC}"
    echo ""
    echo "Usage: $0 --env=<environment>"
    echo ""
    echo "Examples:"
    echo "  $0 --env=conformance"
    echo "  $0 --env=dev"
    exit 1
fi

# Database name based on environment
DB_NAME="${ENV}-authrim-users-db"

echo -e "${BLUE}🔄 Applying migrations to: ${DB_NAME}${NC}"
echo ""

# Get list of migration files
MIGRATION_DIR="migrations"
MIGRATION_FILES=$(ls -1 ${MIGRATION_DIR}/*.sql 2>/dev/null | sort)

if [ -z "$MIGRATION_FILES" ]; then
    echo -e "${RED}❌ No migration files found in ${MIGRATION_DIR}/${NC}"
    exit 1
fi

# Count migrations
TOTAL_MIGRATIONS=$(echo "$MIGRATION_FILES" | wc -l)
CURRENT=0

echo -e "${BLUE}📦 Found ${TOTAL_MIGRATIONS} migration files${NC}"
echo ""

# Apply each migration
for migration_file in $MIGRATION_FILES; do
    CURRENT=$((CURRENT + 1))
    filename=$(basename "$migration_file")

    echo -e "${YELLOW}[${CURRENT}/${TOTAL_MIGRATIONS}] Applying: ${filename}${NC}"

    # Execute migration with timeout and capture output
    # Using timeout command to prevent hanging (max 60 seconds per migration)
    if command -v timeout &> /dev/null; then
        output=$(timeout 60 wrangler d1 execute "$DB_NAME" --remote --file="$migration_file" --yes 2>&1)
        exit_code=$?
        if [ $exit_code -eq 124 ]; then
            echo -e "  ${RED}✗${NC} Migration timed out after 60 seconds"
            exit 1
        fi
    else
        output=$(wrangler d1 execute "$DB_NAME" --remote --file="$migration_file" --yes 2>&1)
        exit_code=$?
    fi

    # Check if migration succeeded or had acceptable errors
    if [ $exit_code -eq 0 ]; then
        echo -e "  ${GREEN}✓${NC} Applied successfully"
    elif echo "$output" | grep -q "already exists"; then
        echo -e "  ${GREEN}✓${NC} Already applied (table/index exists)"
    elif echo "$output" | grep -q "UNIQUE constraint failed"; then
        echo -e "  ${GREEN}✓${NC} Already applied (data exists)"
    elif echo "$output" | grep -q "duplicate column name"; then
        echo -e "  ${GREEN}✓${NC} Already applied (column exists)"
    else
        echo -e "  ${RED}✗${NC} Failed to apply migration"
        echo "$output"
        exit 1
    fi

    # Small delay to avoid rate limits
    sleep 1
done

echo ""
echo -e "${GREEN}✅ All migrations applied successfully!${NC}"
echo ""

# Verify schema_migrations table
echo -e "${BLUE}📊 Checking migration status...${NC}"
wrangler d1 execute "$DB_NAME" --remote --command "SELECT COUNT(*) as applied_count FROM schema_migrations;" 2>/dev/null || echo "Note: schema_migrations table may not track all migrations yet"

echo ""
echo -e "${GREEN}✅ Migration process complete!${NC}"
