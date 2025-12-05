/**
 * D1データベースの各テーブルのレコード数を確認するスクリプト
 *
 * Usage:
 *   CF_API_TOKEN=xxx npx tsx scripts/check-d1-sizes.ts
 */

const ACCOUNT_ID = "98edc9b77724418e61ae577980a7369b";
const DB_ID = "12276b64-f7a8-4501-8b2b-dba03778459e";
const DB_NAME = "conformance-authrim-users-db";

const TABLES = [
  "audit_log",
  "branding_settings",
  "ciba_requests",
  "device_codes",
  "identity_providers",
  "oauth_clients",
  "organizations",
  "passkeys",
  "password_reset_tokens",
  "relation_definitions",
  "relationship_closure",
  "relationships",
  "role_assignments",
  "roles",
  "scope_mappings",
  "sessions",
  "subject_identifiers",
  "subject_org_membership",
  "user_custom_fields",
  "user_roles",
  "users",
  "verified_attributes",
  "external_idp_auth_states",
  "linked_identities",
  "migration_metadata",
  "oauth_client_consents",
  "refresh_token_shard_configs",
  "schema_migrations",
  "upstream_providers",
  "user_token_families",
];

interface D1QueryResult {
  success: boolean;
  result: Array<{ results: Array<{ count: number }> }>;
  errors?: Array<{ message: string }>;
}

async function queryD1(sql: string): Promise<number | null> {
  const apiToken = process.env.CF_API_TOKEN;
  if (!apiToken) {
    console.error("Error: CF_API_TOKEN environment variable is not set");
    process.exit(1);
  }

  const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DB_ID}/query`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ sql }),
    });

    const data = (await response.json()) as D1QueryResult;

    if (!data.success) {
      console.error(`  Error: ${data.errors?.[0]?.message || "Unknown error"}`);
      return null;
    }

    return data.result[0]?.results[0]?.count ?? 0;
  } catch (error) {
    console.error(`  Error: ${error}`);
    return null;
  }
}

async function main() {
  console.log("==========================================");
  console.log("D1 データベーステーブルサイズ確認");
  console.log("==========================================");
  console.log(`データベース: ${DB_NAME}`);
  console.log(`データベースID: ${DB_ID}`);
  console.log(`アカウントID: ${ACCOUNT_ID}`);
  console.log("");
  console.log(`テーブル数: ${TABLES.length}`);
  console.log("");
  console.log("各テーブルのレコード数を確認中...");
  console.log("");

  const results: Array<{ table: string; count: number | null }> = [];
  let totalRecords = 0;

  for (const table of TABLES) {
    process.stdout.write(`  ${table.padEnd(30)}: `);

    const count = await queryD1(`SELECT COUNT(*) as count FROM ${table}`);

    if (count === null) {
      console.log("⚠️  エラー");
      results.push({ table, count: null });
    } else {
      console.log(`${count.toLocaleString()} レコード`);
      results.push({ table, count });
      totalRecords += count;
    }

    // Rate limiting対策: 少し待機
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  console.log("");
  console.log("==========================================");
  console.log("集計結果");
  console.log("==========================================");
  console.log("");

  // レコード数でソート
  const sortedResults = results
    .filter((r) => r.count !== null && r.count > 0)
    .sort((a, b) => (b.count ?? 0) - (a.count ?? 0));

  console.log("【レコード数が多いテーブル Top 10】");
  sortedResults.slice(0, 10).forEach((r, i) => {
    console.log(`  ${i + 1}. ${r.table.padEnd(30)}: ${r.count?.toLocaleString()} レコード`);
  });

  console.log("");
  console.log("【空のテーブル】");
  const emptyTables = results.filter((r) => r.count === 0);
  if (emptyTables.length > 0) {
    emptyTables.forEach((r) => {
      console.log(`  - ${r.table}`);
    });
  } else {
    console.log("  なし");
  }

  console.log("");
  console.log("==========================================");
  console.log(`合計レコード数: ${totalRecords.toLocaleString()}`);
  console.log(`データが存在するテーブル数: ${sortedResults.length}/${TABLES.length}`);
  console.log("==========================================");
}

main().catch(console.error);
