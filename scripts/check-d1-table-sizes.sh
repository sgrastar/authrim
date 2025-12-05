#!/bin/bash
# D1データベースのテーブルごとのレコード数を確認するスクリプト

DB_NAME="conformance-authrim-users-db"
DB_ID="12276b64-f7a8-4501-8b2b-dba03778459e"

echo "=========================================="
echo "D1 データベーステーブルサイズ確認"
echo "=========================================="
echo "データベース: $DB_NAME"
echo "データベースID: $DB_ID"
echo ""

# テーブルリスト
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

echo "テーブル数: ${#TABLES[@]}"
echo ""
echo "各テーブルのレコード数を確認中..."
echo ""

TOTAL_RECORDS=0

for table in "${TABLES[@]}"; do
    echo -n "  $table: "

    # テーブルの行数を取得
    RESULT=$(wrangler d1 execute $DB_NAME --remote --command "SELECT COUNT(*) as count FROM $table;" 2>&1)

    if echo "$RESULT" | grep -q "error\|ERROR\|Error"; then
        echo "⚠️  エラー"
    else
        # COUNT(*)の結果を抽出
        COUNT=$(echo "$RESULT" | grep -A 1 "count" | tail -n 1 | tr -d ' ')
        if [ -z "$COUNT" ]; then
            COUNT="0"
        fi
        echo "$COUNT レコード"
        TOTAL_RECORDS=$((TOTAL_RECORDS + COUNT))
    fi
done

echo ""
echo "=========================================="
echo "合計レコード数: $TOTAL_RECORDS"
echo "=========================================="
