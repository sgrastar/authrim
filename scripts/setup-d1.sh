#!/bin/bash
#
# Authrim D1 Database Setup Script
# This script creates D1 database and updates wrangler.toml files with bindings
#
# Usage:
#   ./setup-d1.sh --env=dev           - Set up D1 database for dev environment
#   ./setup-d1.sh --env=prod --reset  - Reset mode (deletes and recreates database)
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
            echo "  --reset         Delete and recreate database (WARNING: deletes all data)"
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

echo "⚡️ Authrim D1 Database Setup - Environment: $DEPLOY_ENV"
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

echo "📦 D1 Database Setup for Environment: $DEPLOY_ENV"
echo ""
echo "This script will create or update D1 database for your Authrim deployment."
echo ""

# Determine database name with environment prefix
read -p "Database name [${DEPLOY_ENV}-authrim-users-db]: " DB_NAME_INPUT
DB_NAME=${DB_NAME_INPUT:-${DEPLOY_ENV}-authrim-users-db}

# Always use --remote flag (not using local D1 database)
REMOTE_FLAG="--remote"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Database: $DB_NAME"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Check if database already exists
DB_EXISTS=false
if wrangler d1 info "$DB_NAME" &> /dev/null; then
    DB_EXISTS=true
fi

if [ "$RESET_MODE" = true ]; then
    if [ "$DB_EXISTS" = true ]; then
        echo ""
        echo "⚠️  RESET MODE: Database Deletion Confirmation"
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        echo "The following database will be DELETED:"
        echo ""
        echo "  Database Name: $DB_NAME"

        # Show database info if available
        DB_INFO=$(wrangler d1 info "$DB_NAME" 2>&1 | head -10)
        if [ $? -eq 0 ]; then
            echo ""
            echo "$DB_INFO"
        fi

        echo ""
        echo "⚠️  WARNING: This will delete ALL data in the database!"
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        echo ""
        read -p "Are you sure you want to continue? Type 'YES' to confirm: " -r
        echo ""

        if [ "$REPLY" != "YES" ]; then
            echo "❌ Reset cancelled"
            exit 1
        fi

        echo "🗑️  Deleting database: $DB_NAME"
        wrangler d1 delete "$DB_NAME" --skip-confirmation
        echo "✅ Database deleted"
        echo ""
        DB_EXISTS=false
    else
        echo ""
        echo "ℹ️  RESET MODE: Database does not exist"
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        echo "Database '$DB_NAME' does not exist. It will be created."
        echo ""
    fi
fi

# Create database if it doesn't exist
if [ "$DB_EXISTS" = false ]; then
    echo "📝 Creating D1 database: $DB_NAME"
    CREATE_OUTPUT=$(wrangler d1 create "$DB_NAME" 2>&1)
    echo "$CREATE_OUTPUT"

    # Try to extract database ID from create output (supports both old and new wrangler formats)
    DB_ID=$(echo "$CREATE_OUTPUT" | grep -oE '("database_id":|"uuid":|database_id =) ?"?([a-f0-9-]{36})"?' | grep -oE '[a-f0-9-]{36}')

    # If extraction failed, try getting it from the list command
    if [ -z "$DB_ID" ]; then
        DB_LIST_JSON=$(wrangler d1 list --json 2>/dev/null)
        if [ -n "$DB_LIST_JSON" ]; then
            DB_ID=$(echo "$DB_LIST_JSON" | grep -A 1 "\"name\": \"$DB_NAME\"" | grep -oE '"uuid": "([a-f0-9-]{36})"' | grep -oE '[a-f0-9-]{36}')
        fi
    fi

    # Last resort: extract any UUID pattern from create output
    if [ -z "$DB_ID" ]; then
        DB_ID=$(echo "$CREATE_OUTPUT" | grep -oE '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}' | head -1)
    fi

    if [ -z "$DB_ID" ]; then
        echo "❌ Error: Could not extract database ID"
        echo "Please create database manually and update wrangler.toml files"
        exit 1
    fi

    echo ""
    echo "✅ Database created successfully!"
    echo "   Database ID: $DB_ID"
else
    echo "✅ Database already exists: $DB_NAME"

    # Get existing database ID - try JSON format first (most reliable)
    DB_LIST_JSON=$(wrangler d1 list --json 2>/dev/null)
    if [ -n "$DB_LIST_JSON" ]; then
        # Try to extract uuid from JSON using grep (works without jq)
        DB_ID=$(echo "$DB_LIST_JSON" | grep -A 1 "\"name\": \"$DB_NAME\"" | grep -oE '"uuid": "([a-f0-9-]{36})"' | grep -oE '[a-f0-9-]{36}')
    fi

    # Fallback to d1 info table format if JSON parsing failed
    if [ -z "$DB_ID" ]; then
        DB_INFO=$(wrangler d1 info "$DB_NAME" 2>&1)
        # Extract UUID from table format (first line with UUID pattern after header)
        DB_ID=$(echo "$DB_INFO" | grep -oE '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}' | head -1)
    fi

    # Last fallback: try old regex patterns for legacy wrangler versions
    if [ -z "$DB_ID" ]; then
        DB_ID=$(echo "$DB_INFO" | grep -oE '(id:|"database_id":) ?"?([a-f0-9-]{36})"?' | grep -oE '[a-f0-9-]{36}' | head -1)
    fi

    if [ -z "$DB_ID" ]; then
        echo "⚠️  Warning: Could not extract database ID from existing database"
        echo "Please update wrangler.toml files manually"
        read -p "Continue anyway? (y/N): " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            echo "❌ Setup cancelled"
            exit 1
        fi
    else
        echo "   Database ID: $DB_ID"
    fi
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📝 Updating wrangler.toml files with D1 bindings"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Function to add D1 binding to wrangler.toml
add_d1_binding() {
    local file=$1
    local package_name=$(basename $(dirname "$file"))

    # Skip router - it doesn't need D1 binding
    if [ "$package_name" = "router" ]; then
        echo "  ⊗ Skipping router (no D1 binding needed)"
        return
    fi

    echo "  • Updating $package_name..."

    # Check if D1 binding already exists
    if grep -q "^\[\[d1_databases\]\]" "$file"; then
        # Update existing binding
        if [[ "$OSTYPE" == "darwin"* ]]; then
            # macOS
            sed -i '' "/^\[\[d1_databases\]\]/,/^database_id = / {
                s/^database_name = .*/database_name = \"$DB_NAME\"/
                s/^database_id = .*/database_id = \"$DB_ID\"/
            }" "$file"
        else
            # Linux
            sed -i "/^\[\[d1_databases\]\]/,/^database_id = / {
                s/^database_name = .*/database_name = \"$DB_NAME\"/
                s/^database_id = .*/database_id = \"$DB_ID\"/
            }" "$file"
        fi
    else
        # Add new D1 binding after KV namespaces section
        # Find the last KV namespace or vars section
        if grep -q "^\[\[kv_namespaces\]\]" "$file"; then
            # Add after last KV namespace
            if [[ "$OSTYPE" == "darwin"* ]]; then
                # macOS - need to handle multiline insertion differently
                awk -v db_name="$DB_NAME" -v db_id="$DB_ID" '
                    /^preview_id = / {
                        print
                        if (!d1_added) {
                            print ""
                            print "# D1 Database"
                            print "[[d1_databases]]"
                            print "binding = \"DB\""
                            print "database_name = \"" db_name "\""
                            print "database_id = \"" db_id "\""
                            d1_added = 1
                        }
                        next
                    }
                    { print }
                ' "$file" > "$file.tmp" && mv "$file.tmp" "$file"
            else
                # Linux
                sed -i "/^preview_id = /a\\
\\
# D1 Database\\
[[d1_databases]]\\
binding = \"DB\"\\
database_name = \"$DB_NAME\"\\
database_id = \"$DB_ID\"" "$file"
            fi
        elif grep -q "^\[vars\]" "$file"; then
            # Add before vars section
            if [[ "$OSTYPE" == "darwin"* ]]; then
                awk -v db_name="$DB_NAME" -v db_id="$DB_ID" '
                    /^\[vars\]/ {
                        print "# D1 Database"
                        print "[[d1_databases]]"
                        print "binding = \"DB\""
                        print "database_name = \"" db_name "\""
                        print "database_id = \"" db_id "\""
                        print ""
                    }
                    { print }
                ' "$file" > "$file.tmp" && mv "$file.tmp" "$file"
            else
                sed -i "/^\[vars\]/i\\
# D1 Database\\
[[d1_databases]]\\
binding = \"DB\"\\
database_name = \"$DB_NAME\"\\
database_id = \"$DB_ID\"\\
" "$file"
            fi
        else
            # Append to end of file
            echo "" >> "$file"
            echo "# D1 Database" >> "$file"
            echo "[[d1_databases]]" >> "$file"
            echo "binding = \"DB\"" >> "$file"
            echo "database_name = \"$DB_NAME\"" >> "$file"
            echo "database_id = \"$DB_ID\"" >> "$file"
        fi
    fi
}

# Update all package wrangler.{env}.toml files
for pkg_dir in packages/*/; do
    if [ -d "$pkg_dir" ]; then
        toml_file="${pkg_dir}wrangler.${DEPLOY_ENV}.toml"
        if [ -f "$toml_file" ]; then
            add_d1_binding "$toml_file"
        else
            package_name=$(basename "$pkg_dir")
            if [ "$package_name" != "router" ] && [ "$package_name" != "ui" ]; then
                echo "  ⚠️  Warning: $toml_file not found. Run setup-wrangler.sh first."
            fi
        fi
    fi
done

echo ""
echo "✅ All wrangler.${DEPLOY_ENV}.toml files updated!"
echo ""

# Ask if user wants to run migrations
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📊 Database Migrations"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
read -p "Run database migrations now? (y/N): " -n 1 -r
echo

if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo ""
    echo "🚀 Running migrations..."
    echo ""

    # Run migrations using migrate.sh
    if [ -f "migrations/migrate.sh" ]; then
        bash migrations/migrate.sh "$DEPLOY_ENV" up
    else
        # Fallback: run migrations directly
        echo "📝 Applying 001_initial_schema.sql..."
        wrangler d1 execute "$DB_NAME" ${REMOTE_FLAG} --file=migrations/001_initial_schema.sql
        echo "✅ Schema migration complete"
        echo ""

        echo "📝 Applying 002_seed_default_data.sql..."
        echo "⚠️  Warning: This includes test data!"
        echo "Review migrations/002_seed_default_data.sql before running on production"
        read -p "Continue? (y/N): " -n 1 -r
        echo
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            wrangler d1 execute "$DB_NAME" ${REMOTE_FLAG} --file=migrations/002_seed_default_data.sql
            echo "✅ Seed data migration complete"
        else
            echo "⊗ Skipping seed data"
        fi
        echo ""
        echo "✅ All migrations applied!"
    fi

    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "📊 Database Status"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo "Tables created:"
    wrangler d1 execute "$DB_NAME" ${REMOTE_FLAG} --command="SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"
    echo ""
    echo "Record counts:"
    wrangler d1 execute "$DB_NAME" ${REMOTE_FLAG} --command="
        SELECT 'users' as table_name, COUNT(*) as count FROM users
        UNION ALL SELECT 'roles', COUNT(*) FROM roles
        UNION ALL SELECT 'oauth_clients', COUNT(*) FROM oauth_clients
        UNION ALL SELECT 'scope_mappings', COUNT(*) FROM scope_mappings
        UNION ALL SELECT 'branding_settings', COUNT(*) FROM branding_settings;
    "
else
    echo ""
    echo "⊗ Migrations skipped"
    echo ""
    echo "To run migrations later:"
    echo "  bash migrations/migrate.sh $DEPLOY_ENV up"
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🎉 D1 Setup Complete for Environment: $DEPLOY_ENV"
echo ""
echo "📋 Database Information:"
echo "  • Environment: $DEPLOY_ENV"
echo "  • Database Name: $DB_NAME"
echo "  • Database ID: $DB_ID"
echo "  • Binding Name: DB"
echo ""
echo "📝 Updated Files:"
for pkg_dir in packages/*/; do
    if [ -d "$pkg_dir" ]; then
        package_name=$(basename "$pkg_dir")
        toml_file="${pkg_dir}wrangler.${DEPLOY_ENV}.toml"
        if [ -f "$toml_file" ] && [ "$package_name" != "router" ] && [ "$package_name" != "ui" ]; then
            echo "  • $package_name/wrangler.${DEPLOY_ENV}.toml"
        fi
    fi
done
echo ""
echo "Next steps:"
echo "  1. Verify D1 binding in wrangler.${DEPLOY_ENV}.toml files"
echo "  2. Run 'pnpm run deploy -- --env=$DEPLOY_ENV' to deploy"
echo ""
echo "Useful commands:"
echo "  • List tables:    wrangler d1 execute $DB_NAME --remote --command=\"SELECT name FROM sqlite_master WHERE type='table';\""
echo "  • Query data:     wrangler d1 execute $DB_NAME --remote --command=\"SELECT * FROM users LIMIT 5;\""
echo "  • Run migrations: bash migrations/migrate.sh $DEPLOY_ENV up"
echo "  • Check status:   bash migrations/migrate.sh $DEPLOY_ENV status"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
