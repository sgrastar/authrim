#!/bin/bash
#
# Authrim Admin D1 Database Setup Script
# This script creates DB_ADMIN database and updates wrangler.toml files with bindings
#
# This is separate from the main D1 database (DB) which stores EndUser data.
# DB_ADMIN stores Admin-specific data:
# - admin_users / admin_sessions / admin_passkeys
# - admin_roles / admin_role_assignments
# - admin_audit_log
# - admin_ip_allowlist / admin_login_attempts
# - admin_attributes / admin_attribute_values (ABAC)
# - admin_relationships / admin_policies (ReBAC)
#
# Usage:
#   ./setup-admin-db.sh --env=dev           - Set up Admin D1 database for dev environment
#   ./setup-admin-db.sh --env=prod --reset  - Reset mode (deletes and recreates database)
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
RESET_MODE=false
DEPLOY_ENV=""
SKIP_MIGRATIONS=false
BINDING_ONLY=false

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
        --skip-migrations)
            SKIP_MIGRATIONS=true
            shift
            ;;
        --binding-only)
            BINDING_ONLY=true
            shift
            ;;
        *)
            echo -e "${RED}❌ Unknown parameter: $1${NC}"
            echo ""
            echo "Usage: $0 --env=<environment> [options]"
            echo ""
            echo "Options:"
            echo "  --env=<name>       Environment name (required, e.g., dev, staging, prod)"
            echo "  --reset            Delete and recreate database (WARNING: deletes all data)"
            echo "  --skip-migrations  Skip running migrations after database creation"
            echo "  --binding-only     Only update wrangler.toml bindings (database must exist)"
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
    echo -e "${RED}❌ Error: --env parameter is required${NC}"
    echo ""
    echo "Usage: $0 --env=<environment> [options]"
    echo ""
    echo "Examples:"
    echo "  $0 --env=dev"
    echo "  $0 --env=staging"
    echo "  $0 --env=prod"
    exit 1
fi

echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}⚡️ Authrim Admin D1 Database Setup${NC}"
echo -e "${BLUE}   Environment: ${DEPLOY_ENV}${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# Check if wrangler is installed
if ! command -v wrangler &> /dev/null; then
    echo -e "${RED}❌ Error: wrangler is not installed${NC}"
    echo "Please install it with: npm install -g wrangler"
    exit 1
fi

# Check if user is logged in
if ! wrangler whoami &> /dev/null; then
    echo -e "${RED}❌ Error: Not logged in to Cloudflare${NC}"
    echo "Please run: wrangler login"
    exit 1
fi

echo -e "${BLUE}📦 Admin D1 Database Setup for Environment: ${DEPLOY_ENV}${NC}"
echo ""
echo "This script will create or update the Admin D1 database."
echo "This database is separate from the EndUser database (DB)."
echo ""
echo -e "${YELLOW}Database contents:${NC}"
echo "  • admin_users - Admin user accounts"
echo "  • admin_roles - Admin role definitions"
echo "  • admin_role_assignments - Role assignments"
echo "  • admin_sessions - Admin login sessions"
echo "  • admin_passkeys - WebAuthn credentials"
echo "  • admin_audit_log - Admin operation audit trail"
echo "  • admin_ip_allowlist - IP-based access control"
echo ""

# Determine database name with environment prefix
DB_NAME="${DEPLOY_ENV}-authrim-admin-db"
echo -e "Database name: ${GREEN}${DB_NAME}${NC}"
echo ""

# Always use --remote flag (not using local D1 database)
REMOTE_FLAG="--remote"

# Check if database already exists
DB_EXISTS=false
if wrangler d1 info "$DB_NAME" &> /dev/null; then
    DB_EXISTS=true
fi

if [ "$RESET_MODE" = true ]; then
    if [ "$DB_EXISTS" = true ]; then
        echo ""
        echo -e "${RED}⚠️  RESET MODE: Database Deletion Confirmation${NC}"
        echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
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
        echo -e "${RED}⚠️  WARNING: This will delete ALL Admin data including:${NC}"
        echo "  • All Admin user accounts"
        echo "  • All Admin sessions"
        echo "  • All Admin audit logs"
        echo "  • All IP allowlist entries"
        echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
        echo ""
        read -p "Are you sure you want to continue? Type 'YES' to confirm: " -r
        echo ""

        if [ "$REPLY" != "YES" ]; then
            echo -e "${RED}❌ Reset cancelled${NC}"
            exit 1
        fi

        echo -e "${YELLOW}🗑️  Deleting database: $DB_NAME${NC}"
        wrangler d1 delete "$DB_NAME" --skip-confirmation
        echo -e "${GREEN}✅ Database deleted${NC}"
        echo ""
        DB_EXISTS=false
    else
        echo ""
        echo -e "${YELLOW}ℹ️  RESET MODE: Database does not exist${NC}"
        echo "Database '$DB_NAME' does not exist. It will be created."
        echo ""
    fi
fi

# Create database if it doesn't exist (and not binding-only mode)
if [ "$BINDING_ONLY" = false ]; then
    if [ "$DB_EXISTS" = false ]; then
        echo -e "${BLUE}📝 Creating Admin D1 database: $DB_NAME${NC}"
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
            echo -e "${RED}❌ Error: Could not extract database ID${NC}"
            echo "Please create database manually and update wrangler.toml files"
            exit 1
        fi

        echo ""
        echo -e "${GREEN}✅ Database created successfully!${NC}"
        echo "   Database ID: $DB_ID"
    else
        echo -e "${GREEN}✅ Database already exists: $DB_NAME${NC}"

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

        if [ -z "$DB_ID" ]; then
            echo -e "${YELLOW}⚠️  Warning: Could not extract database ID from existing database${NC}"
            echo "Please update wrangler.toml files manually"
            read -p "Continue anyway? (y/N): " -n 1 -r
            echo
            if [[ ! $REPLY =~ ^[Yy]$ ]]; then
                echo -e "${RED}❌ Setup cancelled${NC}"
                exit 1
            fi
        else
            echo "   Database ID: $DB_ID"
        fi
    fi
else
    # Binding-only mode: get existing database ID
    if [ "$DB_EXISTS" = false ]; then
        echo -e "${RED}❌ Error: Database does not exist (--binding-only mode)${NC}"
        echo "Create the database first: $0 --env=$DEPLOY_ENV"
        exit 1
    fi

    echo -e "${GREEN}✅ Database exists: $DB_NAME${NC}"

    # Get existing database ID
    DB_LIST_JSON=$(wrangler d1 list --json 2>/dev/null)
    if [ -n "$DB_LIST_JSON" ]; then
        DB_ID=$(echo "$DB_LIST_JSON" | grep -A 1 "\"name\": \"$DB_NAME\"" | grep -oE '"uuid": "([a-f0-9-]{36})"' | grep -oE '[a-f0-9-]{36}')
    fi

    if [ -z "$DB_ID" ]; then
        DB_INFO=$(wrangler d1 info "$DB_NAME" 2>&1)
        DB_ID=$(echo "$DB_INFO" | grep -oE '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}' | head -1)
    fi

    if [ -z "$DB_ID" ]; then
        echo -e "${RED}❌ Error: Could not extract database ID${NC}"
        exit 1
    fi

    echo "   Database ID: $DB_ID"
fi

echo ""
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}📝 Updating wrangler.toml files with DB_ADMIN binding${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# Function to add DB_ADMIN binding to wrangler.toml
add_db_admin_binding() {
    local file=$1
    local package_name=$(basename $(dirname "$file"))

    # Skip packages that don't need DB_ADMIN binding
    case "$package_name" in
        router|ui|ar-admin-ui|ar-login-ui)
            echo -e "  ${GRAY}⊗ Skipping $package_name (no DB_ADMIN binding needed)${NC}"
            return
            ;;
    esac

    echo "  • Updating $package_name..."

    # Check if DB_ADMIN binding already exists
    if grep -q 'binding = "DB_ADMIN"' "$file"; then
        # Update existing binding
        if [[ "$OSTYPE" == "darwin"* ]]; then
            # macOS - update database_name and database_id for DB_ADMIN section
            awk -v db_name="$DB_NAME" -v db_id="$DB_ID" '
                /binding = "DB_ADMIN"/ {
                    in_db_admin = 1
                }
                in_db_admin && /database_name = / {
                    print "database_name = \"" db_name "\""
                    next
                }
                in_db_admin && /database_id = / {
                    print "database_id = \"" db_id "\""
                    in_db_admin = 0
                    next
                }
                { print }
            ' "$file" > "$file.tmp" && mv "$file.tmp" "$file"
        else
            # Linux
            sed -i '/binding = "DB_ADMIN"/,/database_id = / {
                s/database_name = .*/database_name = "'"$DB_NAME"'"/
                s/database_id = .*/database_id = "'"$DB_ID"'"/
            }' "$file"
        fi
        echo -e "    ${GREEN}✓ Updated existing binding${NC}"
    else
        # Check if any d1_databases section exists
        if grep -q "^\[\[d1_databases\]\]" "$file"; then
            # Add new DB_ADMIN binding after last d1_databases section
            if [[ "$OSTYPE" == "darwin"* ]]; then
                # macOS - find last database_id line and add after it
                awk -v db_name="$DB_NAME" -v db_id="$DB_ID" '
                    /database_id = / {
                        last_db_line = NR
                        last_db_content = $0
                    }
                    NR == last_db_line {
                        print
                        print ""
                        print "# Admin D1 Database (Admin/EndUser Separation)"
                        print "[[d1_databases]]"
                        print "binding = \"DB_ADMIN\""
                        print "database_name = \"" db_name "\""
                        print "database_id = \"" db_id "\""
                        last_db_line = -1
                        next
                    }
                    { print }
                    END {
                        if (last_db_line > 0) {
                            print ""
                            print "# Admin D1 Database (Admin/EndUser Separation)"
                            print "[[d1_databases]]"
                            print "binding = \"DB_ADMIN\""
                            print "database_name = \"" db_name "\""
                            print "database_id = \"" db_id "\""
                        }
                    }
                ' "$file" > "$file.tmp" && mv "$file.tmp" "$file"
            else
                # Linux - append after last database_id line
                tac "$file" | awk -v db_name="$DB_NAME" -v db_id="$DB_ID" '
                    !done && /database_id = / {
                        print
                        print ""
                        print "database_id = \"" db_id "\""
                        print "database_name = \"" db_name "\""
                        print "binding = \"DB_ADMIN\""
                        print "[[d1_databases]]"
                        print "# Admin D1 Database (Admin/EndUser Separation)"
                        done = 1
                        next
                    }
                    { print }
                ' | tac > "$file.tmp" && mv "$file.tmp" "$file"
            fi
        else
            # No d1_databases section exists - append to end
            echo "" >> "$file"
            echo "# Admin D1 Database (Admin/EndUser Separation)" >> "$file"
            echo "[[d1_databases]]" >> "$file"
            echo "binding = \"DB_ADMIN\"" >> "$file"
            echo "database_name = \"$DB_NAME\"" >> "$file"
            echo "database_id = \"$DB_ID\"" >> "$file"
        fi
        echo -e "    ${GREEN}✓ Added new binding${NC}"
    fi
}

# Update all package wrangler.{env}.toml files
for pkg_dir in packages/*/; do
    if [ -d "$pkg_dir" ]; then
        toml_file="${pkg_dir}wrangler.${DEPLOY_ENV}.toml"
        if [ -f "$toml_file" ]; then
            add_db_admin_binding "$toml_file"
        fi
    fi
done

echo ""
echo -e "${GREEN}✅ All wrangler.${DEPLOY_ENV}.toml files updated!${NC}"
echo ""

# Run migrations if not skipped
if [ "$SKIP_MIGRATIONS" = false ] && [ "$BINDING_ONLY" = false ]; then
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${BLUE}📊 Admin Database Migrations${NC}"
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""

    ADMIN_MIGRATION_DIR="migrations/admin"

    if [ ! -d "$ADMIN_MIGRATION_DIR" ]; then
        echo -e "${RED}❌ Migration directory not found: $ADMIN_MIGRATION_DIR${NC}"
        exit 1
    fi

    # Get list of migration files
    MIGRATION_FILES=$(ls -1 ${ADMIN_MIGRATION_DIR}/*.sql 2>/dev/null | sort)

    if [ -z "$MIGRATION_FILES" ]; then
        echo -e "${YELLOW}⚠️  No migration files found in ${ADMIN_MIGRATION_DIR}/${NC}"
    else
        TOTAL=$(echo "$MIGRATION_FILES" | wc -l | tr -d ' ')
        echo -e "${BLUE}📦 Found ${TOTAL} admin migration files${NC}"
        echo ""

        CURRENT=0
        for migration_file in $MIGRATION_FILES; do
            CURRENT=$((CURRENT + 1))
            filename=$(basename "$migration_file")

            printf "[%d/%d] Applying %-40s " "$CURRENT" "$TOTAL" "$filename"

            # Execute migration
            output=$(wrangler d1 execute "$DB_NAME" ${REMOTE_FLAG} --file="$migration_file" --yes 2>&1)
            exit_code=$?

            if [ $exit_code -eq 0 ]; then
                echo -e "${GREEN}✓ Applied${NC}"
            elif echo "$output" | grep -qE "already exists|UNIQUE constraint failed|duplicate column name"; then
                echo -e "${GREEN}✓ Already exists${NC}"
            else
                echo -e "${RED}✗ Failed${NC}"
                echo -e "${RED}$output${NC}"
            fi

            # Small delay to avoid rate limits
            sleep 0.5
        done

        echo ""
        echo -e "${GREEN}✅ All admin migrations applied!${NC}"
    fi
fi

echo ""
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}🎉 Admin D1 Setup Complete for Environment: ${DEPLOY_ENV}${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "${BLUE}📋 Database Information:${NC}"
echo "  • Environment: $DEPLOY_ENV"
echo "  • Database Name: $DB_NAME"
echo "  • Database ID: $DB_ID"
echo "  • Binding Name: DB_ADMIN"
echo ""
echo -e "${BLUE}📝 Updated Files:${NC}"
for pkg_dir in packages/*/; do
    if [ -d "$pkg_dir" ]; then
        package_name=$(basename "$pkg_dir")
        toml_file="${pkg_dir}wrangler.${DEPLOY_ENV}.toml"
        case "$package_name" in
            router|ui|ar-admin-ui|ar-login-ui)
                continue
                ;;
        esac
        if [ -f "$toml_file" ]; then
            echo "  • $package_name/wrangler.${DEPLOY_ENV}.toml"
        fi
    fi
done
echo ""
echo -e "${BLUE}📊 Verify tables:${NC}"
echo "  wrangler d1 execute $DB_NAME --remote --command=\"SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;\""
echo ""
echo -e "${BLUE}🔧 Useful commands:${NC}"
echo "  • List admin users:     wrangler d1 execute $DB_NAME --remote --command=\"SELECT * FROM admin_users;\""
echo "  • List admin roles:     wrangler d1 execute $DB_NAME --remote --command=\"SELECT * FROM admin_roles;\""
echo "  • View audit log:       wrangler d1 execute $DB_NAME --remote --command=\"SELECT * FROM admin_audit_log ORDER BY created_at DESC LIMIT 10;\""
echo ""
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
