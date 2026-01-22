/**
 * Client Secret Migration Script
 *
 * This script migrates existing plain text client secrets to SHA-256 hashes.
 * Run this after applying migration 043_client_secret_hash.sql
 *
 * Usage:
 *   # For local development (D1 local)
 *   pnpm exec wrangler d1 execute authrim-db --local --file=./scripts/migrate-client-secrets-query.sql
 *
 *   # For remote D1 (production/staging)
 *   pnpm exec tsx scripts/migrate-client-secrets.ts --env production
 *
 * Note: This script uses the Web Crypto API for SHA-256 hashing,
 * which is available in Node.js 18+ and Cloudflare Workers.
 */

import { D1Database } from '@cloudflare/workers-types';

interface OAuthClient {
  client_id: string;
  client_secret: string | null;
  client_secret_hash: string | null;
}

/**
 * Hash a client secret using SHA-256
 */
async function hashClientSecret(secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(secret);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Migrate client secrets from plain text to SHA-256 hash
 */
async function migrateClientSecrets(db: D1Database): Promise<void> {
  console.log('Starting client secret migration...');

  // Get all clients with plain text secrets that haven't been migrated yet
  const result = await db
    .prepare(
      `SELECT client_id, client_secret, client_secret_hash
       FROM oauth_clients
       WHERE client_secret IS NOT NULL
         AND client_secret_hash IS NULL`
    )
    .all<OAuthClient>();

  const clients = result.results || [];

  if (clients.length === 0) {
    console.log('No clients need migration. All secrets are already hashed.');
    return;
  }

  console.log(`Found ${clients.length} clients to migrate.`);

  let successCount = 0;
  let errorCount = 0;

  for (const client of clients) {
    try {
      if (!client.client_secret) {
        console.log(`Skipping ${client.client_id}: No secret to migrate`);
        continue;
      }

      // Hash the secret
      const hash = await hashClientSecret(client.client_secret);

      // Update the client with the hashed secret
      await db
        .prepare(
          `UPDATE oauth_clients
           SET client_secret_hash = ?,
               client_secret = NULL
           WHERE client_id = ?`
        )
        .bind(hash, client.client_id)
        .run();

      console.log(`Migrated client: ${client.client_id}`);
      successCount++;
    } catch (error) {
      console.error(`Failed to migrate client ${client.client_id}:`, error);
      errorCount++;
    }
  }

  console.log(`\nMigration complete!`);
  console.log(`  Success: ${successCount}`);
  console.log(`  Errors: ${errorCount}`);

  if (errorCount > 0) {
    console.error('\nSome clients failed to migrate. Please check the errors above.');
    process.exit(1);
  }
}

// CLI execution
async function main() {
  const args = process.argv.slice(2);
  const envFlag = args.indexOf('--env');
  const env = envFlag !== -1 ? args[envFlag + 1] : 'local';

  console.log(`Environment: ${env}`);
  console.log('');
  console.log('NOTE: This script is intended to be run via Wrangler or');
  console.log('      adapted for your deployment environment.');
  console.log('');
  console.log('For local D1:');
  console.log(
    '  pnpm exec wrangler d1 execute authrim-db --local --command="SELECT client_id FROM oauth_clients WHERE client_secret IS NOT NULL AND client_secret_hash IS NULL"'
  );
  console.log('');
  console.log('Then run the migration in a Worker or via the D1 console.');
}

main().catch(console.error);

/**
 * Export for use in Cloudflare Workers
 */
export { migrateClientSecrets, hashClientSecret };
