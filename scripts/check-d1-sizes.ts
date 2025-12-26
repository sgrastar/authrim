/**
 * Script to check record counts for each table in D1 database
 *
 * Usage:
 *   CF_API_TOKEN=xxx CF_ACCOUNT_ID=xxx CF_D1_DATABASE_ID=xxx npx tsx scripts/check-d1-sizes.ts
 *
 * Environment variables:
 *   CF_API_TOKEN      - Cloudflare API token (required)
 *   CF_ACCOUNT_ID     - Cloudflare Account ID (required)
 *   CF_D1_DATABASE_ID - D1 Database ID (required)
 *   CF_D1_DATABASE_NAME - D1 Database name (optional, for display only)
 */

const ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const DB_ID = process.env.CF_D1_DATABASE_ID;
const DB_NAME = process.env.CF_D1_DATABASE_NAME || 'D1 Database';

if (!ACCOUNT_ID) {
  console.error('Error: CF_ACCOUNT_ID environment variable is not set');
  process.exit(1);
}

if (!DB_ID) {
  console.error('Error: CF_D1_DATABASE_ID environment variable is not set');
  process.exit(1);
}

const TABLES = [
  'audit_log',
  'branding_settings',
  'ciba_requests',
  'device_codes',
  'identity_providers',
  'oauth_clients',
  'organizations',
  'passkeys',
  'password_reset_tokens',
  'relation_definitions',
  'relationship_closure',
  'relationships',
  'role_assignments',
  'roles',
  'scope_mappings',
  'sessions',
  'subject_identifiers',
  'subject_org_membership',
  'user_custom_fields',
  'user_roles',
  'users',
  'verified_attributes',
  'external_idp_auth_states',
  'linked_identities',
  'migration_metadata',
  'oauth_client_consents',
  'refresh_token_shard_configs',
  'schema_migrations',
  'upstream_providers',
  'user_token_families',
];

interface D1QueryResult {
  success: boolean;
  result: Array<{ results: Array<{ count: number }> }>;
  errors?: Array<{ message: string }>;
}

async function queryD1(sql: string): Promise<number | null> {
  const apiToken = process.env.CF_API_TOKEN;
  if (!apiToken) {
    console.error('Error: CF_API_TOKEN environment variable is not set');
    process.exit(1);
  }

  const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DB_ID}/query`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ sql }),
    });

    const data = (await response.json()) as D1QueryResult;

    if (!data.success) {
      console.error(`  Error: ${data.errors?.[0]?.message || 'Unknown error'}`);
      return null;
    }

    return data.result[0]?.results[0]?.count ?? 0;
  } catch (error) {
    console.error(`  Error: ${error}`);
    return null;
  }
}

async function main() {
  console.log('==========================================');
  console.log('D1 Database Table Size Check');
  console.log('==========================================');
  console.log(`Database: ${DB_NAME}`);
  console.log(`Database ID: ${DB_ID}`);
  console.log(`Account ID: ${ACCOUNT_ID}`);
  console.log('');
  console.log(`Table count: ${TABLES.length}`);
  console.log('');
  console.log('Checking record counts for each table...');
  console.log('');

  const results: Array<{ table: string; count: number | null }> = [];
  let totalRecords = 0;

  for (const table of TABLES) {
    process.stdout.write(`  ${table.padEnd(30)}: `);

    const count = await queryD1(`SELECT COUNT(*) as count FROM ${table}`);

    if (count === null) {
      console.log('⚠️  Error');
      results.push({ table, count: null });
    } else {
      console.log(`${count.toLocaleString()} records`);
      results.push({ table, count });
      totalRecords += count;
    }

    // Rate limiting mitigation: short delay
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  console.log('');
  console.log('==========================================');
  console.log('Summary');
  console.log('==========================================');
  console.log('');

  // Sort by record count
  const sortedResults = results
    .filter((r) => r.count !== null && r.count > 0)
    .sort((a, b) => (b.count ?? 0) - (a.count ?? 0));

  console.log('[Top 10 Tables by Record Count]');
  sortedResults.slice(0, 10).forEach((r, i) => {
    console.log(`  ${i + 1}. ${r.table.padEnd(30)}: ${r.count?.toLocaleString()} records`);
  });

  console.log('');
  console.log('[Empty Tables]');
  const emptyTables = results.filter((r) => r.count === 0);
  if (emptyTables.length > 0) {
    emptyTables.forEach((r) => {
      console.log(`  - ${r.table}`);
    });
  } else {
    console.log('  None');
  }

  console.log('');
  console.log('==========================================');
  console.log(`Total records: ${totalRecords.toLocaleString()}`);
  console.log(`Tables with data: ${sortedResults.length}/${TABLES.length}`);
  console.log('==========================================');
}

main().catch(console.error);
