#!/bin/bash
# Script to check record counts for each table in D1 database
#
# Usage:
#   CF_D1_DATABASE_NAME=xxx ./scripts/check-d1-table-sizes.sh
#
# Environment variables:
#   CF_D1_DATABASE_NAME - D1 Database name (required, used by wrangler)

if [ -z "$CF_D1_DATABASE_NAME" ]; then
    echo "Error: CF_D1_DATABASE_NAME environment variable is not set"
    echo "Usage: CF_D1_DATABASE_NAME=your-db-name ./scripts/check-d1-table-sizes.sh"
    exit 1
fi

DB_NAME="$CF_D1_DATABASE_NAME"

echo "=========================================="
echo "D1 Database Table Size Check"
echo "=========================================="
echo "Database: $DB_NAME"
echo ""

# Table list
TABLES=(
    "audit_log"
    "branding_settings"
    "ciba_requests"
    "device_codes"
    "identity_providers"
    "oauth_clients"
    "organizations"
    "passkeys"
    "password_reset_tokens"
    "relation_definitions"
    "relationship_closure"
    "relationships"
    "role_assignments"
    "roles"
    "scope_mappings"
    "sessions"
    "subject_identifiers"
    "subject_org_membership"
    "user_custom_fields"
    "user_roles"
    "users"
    "verified_attributes"
    "external_idp_auth_states"
    "linked_identities"
    "migration_metadata"
    "oauth_client_consents"
    "refresh_token_shard_configs"
    "schema_migrations"
    "upstream_providers"
    "user_token_families"
)

echo "Table count: ${#TABLES[@]}"
echo ""
echo "Checking record counts for each table..."
echo ""

TOTAL_RECORDS=0

for table in "${TABLES[@]}"; do
    echo -n "  $table: "

    # Get table row count
    RESULT=$(wrangler d1 execute $DB_NAME --remote --command "SELECT COUNT(*) as count FROM $table;" 2>&1)

    if echo "$RESULT" | grep -q "error\|ERROR\|Error"; then
        echo "⚠️  Error"
    else
        # Extract COUNT(*) result
        COUNT=$(echo "$RESULT" | grep -A 1 "count" | tail -n 1 | tr -d ' ')
        if [ -z "$COUNT" ]; then
            COUNT="0"
        fi
        echo "$COUNT records"
        TOTAL_RECORDS=$((TOTAL_RECORDS + COUNT))
    fi
done

echo ""
echo "=========================================="
echo "Total records: $TOTAL_RECORDS"
echo "=========================================="
