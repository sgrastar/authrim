#!/bin/bash
#
# Apply D1 Database Migrations with History Tracking
# Applies all SQL migration files to the specified environment's database
# Tracks applied migrations in schema_migrations table
#
# Usage:
#   ./scripts/apply-migrations.sh --env=conformance
#   ./scripts/apply-migrations.sh --env=conformance --status
#   ./scripts/apply-migrations.sh --env=conformance --force
#

set -e

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
GRAY='\033[0;90m'
NC='\033[0m'

# Parse arguments
ENV=""
STATUS_ONLY=false
FORCE_MODE=false

for arg in "$@"; do
    case $arg in
        --env=*)
            ENV="${arg#--env=}"
            ;;
        --status)
            STATUS_ONLY=true
            ;;
        --force)
            FORCE_MODE=true
            ;;
    esac
done

# Validate environment
if [ -z "$ENV" ]; then
    echo -e "${RED}❌ Error: --env parameter is required${NC}"
    echo ""
    echo "Usage: $0 --env=<environment> [--status] [--force]"
    echo ""
    echo "Options:"
    echo "  --env=<name>    Environment name (required)"
    echo "  --status        Show migration status only (don't apply)"
    echo "  --force         Re-apply all migrations (ignore history)"
    echo ""
    echo "Examples:"
    echo "  $0 --env=conformance           # Apply pending migrations"
    echo "  $0 --env=conformance --status  # Show status only"
    echo "  $0 --env=conformance --force   # Force re-apply all"
    exit 1
fi

# Database name based on environment
DB_NAME="${ENV}-authrim-users-db"
MIGRATION_DIR="migrations"

echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}📊 D1 Migration Manager - ${ENV}${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# Function to calculate SHA-256 checksum
calculate_checksum() {
    local file=$1
    if command -v sha256sum &> /dev/null; then
        sha256sum "$file" | cut -d' ' -f1
    elif command -v shasum &> /dev/null; then
        shasum -a 256 "$file" | cut -d' ' -f1
    else
        # Fallback: use file size + modification time as pseudo-checksum
        stat -f "%z-%m" "$file" 2>/dev/null || stat -c "%s-%Y" "$file"
    fi
}

# Function to extract version and name from filename
parse_migration_file() {
    local filename=$1
    local basename=$(basename "$filename" .sql)

    # Extract version number (e.g., "001" -> 1)
    VERSION=$(echo "$basename" | grep -oE '^[0-9]+' | sed 's/^0*//' | head -1)
    if [ -z "$VERSION" ]; then
        VERSION=0
    fi

    # Extract name (e.g., "001_initial_schema" -> "initial_schema")
    NAME=$(echo "$basename" | sed 's/^[0-9]*_//')
}

# Function to check if migration is already applied
is_migration_applied() {
    local version=$1
    local result

    result=$(wrangler d1 execute "$DB_NAME" --remote --command \
        "SELECT version FROM schema_migrations WHERE version = $version LIMIT 1;" 2>&1)

    if echo "$result" | grep -q "\"version\": $version"; then
        return 0  # Applied
    else
        return 1  # Not applied
    fi
}

# Function to record migration in schema_migrations
record_migration() {
    local version=$1
    local name=$2
    local checksum=$3
    local execution_time=$4
    local applied_at=$(date +%s)

    wrangler d1 execute "$DB_NAME" --remote --command \
        "INSERT OR REPLACE INTO schema_migrations (version, name, applied_at, checksum, execution_time_ms)
         VALUES ($version, '$name', $applied_at, '$checksum', $execution_time);" --yes 2>/dev/null

    # Update migration_metadata
    wrangler d1 execute "$DB_NAME" --remote --command \
        "UPDATE migration_metadata SET current_version = $version, last_migration_at = $applied_at, environment = '$ENV' WHERE id = 'global';" --yes 2>/dev/null
}

# Function to show migration status
show_status() {
    echo -e "${BLUE}Migration History:${NC}"
    echo ""

    # Get applied migrations from database
    local applied_result
    applied_result=$(wrangler d1 execute "$DB_NAME" --remote --command \
        "SELECT version, name, applied_at, checksum FROM schema_migrations ORDER BY version;" 2>&1)

    # Get list of migration files
    local migration_files=$(ls -1 ${MIGRATION_DIR}/*.sql 2>/dev/null | sort)

    printf "%-6s %-35s %-12s %-20s\n" "Ver" "Name" "Status" "Applied At"
    printf "%-6s %-35s %-12s %-20s\n" "---" "-----------------------------------" "----------" "-------------------"

    for migration_file in $migration_files; do
        parse_migration_file "$migration_file"

        if echo "$applied_result" | grep -q "\"version\": $VERSION"; then
            # Extract applied_at timestamp
            local applied_ts=$(echo "$applied_result" | grep -A3 "\"version\": $VERSION" | grep "applied_at" | grep -oE '[0-9]+' | head -1)
            local applied_date=""
            if [ -n "$applied_ts" ]; then
                applied_date=$(date -r "$applied_ts" "+%Y-%m-%d %H:%M" 2>/dev/null || date -d "@$applied_ts" "+%Y-%m-%d %H:%M" 2>/dev/null || echo "unknown")
            fi
            printf "%-6s %-35s ${GREEN}%-12s${NC} %-20s\n" "$VERSION" "$NAME" "✓ Applied" "$applied_date"
        else
            printf "%-6s %-35s ${YELLOW}%-12s${NC} %-20s\n" "$VERSION" "$NAME" "○ Pending" "-"
        fi
    done

    echo ""

    # Show current version
    local current_version
    current_version=$(wrangler d1 execute "$DB_NAME" --remote --command \
        "SELECT current_version FROM migration_metadata WHERE id = 'global';" 2>&1 | grep -oE '"current_version": [0-9]+' | grep -oE '[0-9]+')

    echo -e "${BLUE}Current Version: ${NC}${current_version:-0}"
    echo ""
}

# Status only mode
if [ "$STATUS_ONLY" = true ]; then
    show_status
    exit 0
fi

# Get list of migration files
MIGRATION_FILES=$(ls -1 ${MIGRATION_DIR}/*.sql 2>/dev/null | sort)

if [ -z "$MIGRATION_FILES" ]; then
    echo -e "${RED}❌ No migration files found in ${MIGRATION_DIR}/${NC}"
    exit 1
fi

# Count migrations
TOTAL_MIGRATIONS=$(echo "$MIGRATION_FILES" | wc -l | tr -d ' ')
APPLIED=0
SKIPPED=0
FAILED=0

echo -e "${BLUE}📦 Found ${TOTAL_MIGRATIONS} migration files${NC}"
echo ""

# Apply each migration
CURRENT=0
for migration_file in $MIGRATION_FILES; do
    CURRENT=$((CURRENT + 1))
    parse_migration_file "$migration_file"
    CHECKSUM=$(calculate_checksum "$migration_file")

    printf "[%2d/%2d] %-40s " "$CURRENT" "$TOTAL_MIGRATIONS" "$NAME"

    # Check if already applied (unless force mode)
    if [ "$FORCE_MODE" = false ] && is_migration_applied "$VERSION"; then
        echo -e "${GRAY}⊗ Already applied${NC}"
        SKIPPED=$((SKIPPED + 1))
        continue
    fi

    # Execute migration
    START_TIME=$(date +%s%3N 2>/dev/null || echo "0")

    output=$(wrangler d1 execute "$DB_NAME" --remote --file="$migration_file" --yes 2>&1)
    exit_code=$?

    END_TIME=$(date +%s%3N 2>/dev/null || echo "0")
    EXECUTION_TIME=$((END_TIME - START_TIME))
    if [ "$EXECUTION_TIME" -lt 0 ]; then
        EXECUTION_TIME=0
    fi

    # Check result
    if [ $exit_code -eq 0 ]; then
        echo -e "${GREEN}✓ Applied (${EXECUTION_TIME}ms)${NC}"
        record_migration "$VERSION" "$NAME" "$CHECKSUM" "$EXECUTION_TIME"
        APPLIED=$((APPLIED + 1))
    elif echo "$output" | grep -qE "already exists|UNIQUE constraint failed|duplicate column name"; then
        echo -e "${GREEN}✓ Already exists${NC}"
        # Record as applied even if tables already exist
        record_migration "$VERSION" "$NAME" "$CHECKSUM" "$EXECUTION_TIME"
        APPLIED=$((APPLIED + 1))
    else
        echo -e "${RED}✗ Failed${NC}"
        echo -e "${RED}$output${NC}"
        FAILED=$((FAILED + 1))
        # Don't exit on failure - continue with other migrations
    fi

    # Small delay to avoid rate limits
    sleep 0.5
done

echo ""
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}📊 Migration Summary${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "  Applied:  ${GREEN}$APPLIED${NC}"
echo -e "  Skipped:  ${GRAY}$SKIPPED${NC}"
echo -e "  Failed:   ${RED}$FAILED${NC}"
echo ""

if [ "$FAILED" -gt 0 ]; then
    echo -e "${RED}⚠️  Some migrations failed. Check the output above.${NC}"
    exit 1
else
    echo -e "${GREEN}✅ All migrations processed successfully!${NC}"
fi

echo ""
echo -e "${GRAY}Tip: Run '$0 --env=$ENV --status' to view migration history${NC}"
echo ""
