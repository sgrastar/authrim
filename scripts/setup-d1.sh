#!/bin/bash
#
# Authrim D1 Database Setup Script
# This script creates all required D1 databases and updates wrangler.toml files with bindings
#
# Databases created:
#   - {env}-authrim-core-db   (binding: DB)       - Core OAuth/OIDC data
#   - {env}-authrim-pii-db    (binding: DB_PII)   - Personal Identifiable Information
#   - {env}-authrim-admin-db  (binding: DB_ADMIN) - Admin/Audit data
#
# Must match packages/setup/src/core/naming.ts D1_DATABASES
#
# Usage:
#   ./setup-d1.sh --env=dev           - Set up D1 databases for dev environment
#   ./setup-d1.sh --env=prod --reset  - Reset mode (deletes and recreates all databases)
#

set -e

# Source common utilities
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "${SCRIPT_DIR}/lib/authrim-paths.sh" ]; then
  source "${SCRIPT_DIR}/lib/authrim-paths.sh"
fi

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
            echo "  --reset         Delete and recreate all databases (WARNING: deletes all data)"
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

# Validate environment name (security: prevent path traversal)
if type validate_env_name &>/dev/null; then
    validate_env_name "$DEPLOY_ENV" || exit 1
elif [[ "$DEPLOY_ENV" =~ \.\. ]] || [[ "$DEPLOY_ENV" =~ / ]] || [[ "$DEPLOY_ENV" =~ \\ ]]; then
    echo "❌ Error: Invalid environment name '${DEPLOY_ENV}': path traversal characters not allowed"
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

# Define all required D1 databases
# Must match packages/setup/src/core/naming.ts D1_DATABASES
declare -A D1_DATABASES=(
    ["DB"]="${DEPLOY_ENV}-authrim-core-db"
    ["DB_PII"]="${DEPLOY_ENV}-authrim-pii-db"
    ["DB_ADMIN"]="${DEPLOY_ENV}-authrim-admin-db"
)

# Store database IDs
declare -A DB_IDS

echo "📦 D1 Database Setup for Environment: $DEPLOY_ENV"
echo ""
echo "This script will create or update the following D1 databases:"
echo "  • ${D1_DATABASES[DB]} (binding: DB) - Core OAuth/OIDC data"
echo "  • ${D1_DATABASES[DB_PII]} (binding: DB_PII) - Personal Identifiable Information"
echo "  • ${D1_DATABASES[DB_ADMIN]} (binding: DB_ADMIN) - Admin/Audit data"
echo ""

# Always use --remote flag (not using local D1 database)
REMOTE_FLAG="--remote"

if [ "$RESET_MODE" = true ]; then
    if [[ "$DEPLOY_ENV" =~ ^(prod|production)$ ]] && [ "${AUTHRIM_ALLOW_PROD_RESET:-}" != "YES" ]; then
        echo "❌ Refusing to reset production D1 databases without AUTHRIM_ALLOW_PROD_RESET=YES"
        exit 1
    fi

    echo "⚠️  RESET MODE ENABLED"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "The following databases will be DELETED and recreated:"
    for binding in "${!D1_DATABASES[@]}"; do
        echo "  • ${D1_DATABASES[$binding]}"
    done
    echo ""
    echo "⚠️  WARNING: This will delete ALL data in these databases!"
    echo ""
    read -p "Are you sure you want to continue? Type 'YES' to confirm: " -r
    if [ "$REPLY" != "YES" ]; then
        echo "❌ Reset cancelled"
        exit 1
    fi
    echo ""
fi

# Function to extract database ID from wrangler output or list
get_db_id() {
    local db_name=$1
    local db_id=""

    # Try JSON format first (most reliable)
    local db_list_json=$(wrangler d1 list --json 2>/dev/null)
    if [ -n "$db_list_json" ]; then
        if command -v jq &> /dev/null; then
            db_id=$(echo "$db_list_json" | jq -r ".[] | select(.name == \"$db_name\") | .uuid" 2>/dev/null | head -1)
        else
            db_id=$(echo "$db_list_json" | grep -A 1 "\"name\": \"$db_name\"" | grep -oE '"uuid": "([a-f0-9-]{36})"' | grep -oE '[a-f0-9-]{36}')
        fi
    fi

    # Fallback to d1 info
    if [ -z "$db_id" ]; then
        local db_info=$(wrangler d1 info "$db_name" 2>&1)
        db_id=$(echo "$db_info" | grep -oE '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}' | head -1)
    fi

    echo "$db_id"
}

# Function to create or get database
create_or_get_database() {
    local binding=$1
    local db_name=$2

    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "📊 Setting up: $db_name (binding: $binding)"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

    # Check if database already exists
    local db_exists=false
    if wrangler d1 info "$db_name" &> /dev/null; then
        db_exists=true
    fi

    # Handle reset mode
    if [ "$RESET_MODE" = true ] && [ "$db_exists" = true ]; then
        echo "  🗑️  Deleting existing database..."
        if ! wrangler d1 delete "$db_name" --skip-confirmation; then
            echo "  ❌ Failed to delete database: $db_name"
            return 1
        fi
        echo "  ✅ Deleted"
        db_exists=false
        sleep 2  # Wait for deletion to propagate
    fi

    # Create database if needed
    if [ "$db_exists" = false ]; then
        echo "  📝 Creating database..."
        local create_output=$(wrangler d1 create "$db_name" 2>&1)

        # Extract ID from create output
        local db_id=$(echo "$create_output" | grep -oE '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}' | head -1)

        if [ -z "$db_id" ]; then
            # Try getting from list
            sleep 2
            db_id=$(get_db_id "$db_name")
        fi

        if [ -z "$db_id" ]; then
            echo "  ❌ Error: Could not extract database ID"
            return 1
        fi

        echo "  ✅ Created: $db_id"
        DB_IDS[$binding]=$db_id
    else
        echo "  ℹ️  Database already exists"
        local db_id=$(get_db_id "$db_name")

        if [ -z "$db_id" ]; then
            echo "  ⚠️  Warning: Could not extract database ID"
            return 1
        fi

        echo "  ✅ Found: $db_id"
        DB_IDS[$binding]=$db_id
    fi

    return 0
}

# Create all databases
echo ""
echo "Creating D1 databases..."

for binding in "DB" "DB_PII" "DB_ADMIN"; do
    db_name="${D1_DATABASES[$binding]}"
    if ! create_or_get_database "$binding" "$db_name"; then
        echo "❌ Failed to create/get database: $db_name"
        exit 1
    fi
done

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📝 Updating wrangler.toml files with D1 bindings"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Function to update D1 binding in wrangler.toml
update_d1_binding() {
    local file=$1
    local binding=$2
    local db_name=$3
    local db_id=$4

    if [ ! -f "$file" ]; then
        return 1
    fi

    # Check if this specific binding already exists
    if grep -q "binding = \"$binding\"" "$file"; then
        # Update existing binding using awk
        awk -v binding="$binding" -v db_name="$db_name" -v db_id="$db_id" '
        BEGIN { in_block = 0 }
        /^\[\[d1_databases\]\]/ { in_block = 0 }
        /binding = / {
            if ($0 ~ "\"" binding "\"") {
                in_block = 1
            }
        }
        in_block && /^database_name = / {
            print "database_name = \"" db_name "\""
            next
        }
        in_block && /^database_id = / {
            print "database_id = \"" db_id "\""
            in_block = 0
            next
        }
        { print }
        ' "$file" > "$file.tmp" && mv "$file.tmp" "$file"
    else
        # Add new D1 binding at the end of file
        echo "" >> "$file"
        echo "[[d1_databases]]" >> "$file"
        echo "binding = \"$binding\"" >> "$file"
        echo "database_name = \"$db_name\"" >> "$file"
        echo "database_id = \"$db_id\"" >> "$file"
    fi
}

# Define which packages need which D1 bindings
# Based on packages/setup/src/core/wrangler.ts
# ar-router and ar-async don't need D1
declare -A PACKAGE_D1_BINDINGS=(
    ["ar-lib-core"]="DB DB_PII DB_ADMIN"
    ["ar-discovery"]="DB DB_PII DB_ADMIN"
    ["ar-auth"]="DB DB_PII DB_ADMIN"
    ["ar-token"]="DB DB_PII DB_ADMIN"
    ["ar-userinfo"]="DB DB_PII DB_ADMIN"
    ["ar-management"]="DB DB_PII DB_ADMIN"
    ["ar-policy"]="DB DB_PII DB_ADMIN"
    ["ar-saml"]="DB DB_PII DB_ADMIN"
    ["ar-bridge"]="DB DB_PII DB_ADMIN"
    ["ar-vc"]="DB DB_PII DB_ADMIN"
)

# Update all package wrangler.{env}.toml files
for pkg_dir in packages/*/; do
    if [ -d "$pkg_dir" ]; then
        package_name=$(basename "$pkg_dir")
        toml_file="${pkg_dir}wrangler.${DEPLOY_ENV}.toml"

        # Skip packages that don't need D1
        if [ -z "${PACKAGE_D1_BINDINGS[$package_name]}" ]; then
            continue
        fi

        if [ -f "$toml_file" ]; then
            echo "  • Updating $package_name..."
            for binding in ${PACKAGE_D1_BINDINGS[$package_name]}; do
                db_name="${D1_DATABASES[$binding]}"
                db_id="${DB_IDS[$binding]}"
                if [ -n "$db_id" ]; then
                    update_d1_binding "$toml_file" "$binding" "$db_name" "$db_id"
                fi
            done
        else
            echo "  ⚠️  Warning: $toml_file not found. Run setup-remote-wrangler.sh first."
        fi
    fi
done

echo ""
echo "✅ All wrangler.${DEPLOY_ENV}.toml files updated!"

# Initial migrations are intentionally not exposed as a per-database operation.
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📊 Database Migrations"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "⊗ Per-database initial migrations are disabled."
echo "  After this script records the resource lock, run the complete schema-first deployment:"
echo "  authrim-setup deploy --env=$DEPLOY_ENV"

# Save D1 IDs to lock.json
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📦 Saving D1 database IDs to lock.json..."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if type add_d1_to_lock &>/dev/null; then
    for binding in "DB" "DB_PII" "DB_ADMIN"; do
        db_name="${D1_DATABASES[$binding]}"
        db_id="${DB_IDS[$binding]}"
        if [ -n "$db_id" ]; then
            add_d1_to_lock "$DEPLOY_ENV" "$binding" "$db_name" "$db_id"
            echo "  ✓ $binding (${db_name})"
        fi
    done
    echo ""
    echo "✅ D1 IDs saved to $(get_lock_path "$DEPLOY_ENV")"
else
    echo "⚠️  Warning: authrim-paths.sh not loaded, skipping lock.json update"
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🎉 D1 Setup Complete for Environment: $DEPLOY_ENV"
echo ""
echo "📋 Created Databases:"
for binding in "DB" "DB_PII" "DB_ADMIN"; do
    db_name="${D1_DATABASES[$binding]}"
    db_id="${DB_IDS[$binding]}"
    echo "  • $binding: $db_name"
    echo "    ID: $db_id"
done
echo ""
echo "📝 Updated wrangler.toml files for:"
for package_name in "${!PACKAGE_D1_BINDINGS[@]}"; do
    toml_file="packages/${package_name}/wrangler.${DEPLOY_ENV}.toml"
    if [ -f "$toml_file" ]; then
        echo "  • $package_name"
    fi
done
echo ""
echo "Next steps:"
echo "  1. Verify D1 bindings in wrangler.${DEPLOY_ENV}.toml files"
echo "  2. Run 'authrim-setup deploy --env=$DEPLOY_ENV' for schema-first initial deployment"
echo ""
echo "Post-deployment maintenance commands:"
echo "  • Check a role:   bash scripts/apply-migrations.sh --env=$DEPLOY_ENV --role=core --status"
echo "  • List tables:    wrangler d1 execute ${D1_DATABASES[DB]} --remote --command=\"SELECT name FROM sqlite_master WHERE type='table';\""
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
