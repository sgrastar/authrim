/**
 * Statement consent across the tenant's two core databases
 *
 * The documents people agree to (`consent_statements`, `consent_statement_versions`,
 * `consent_statement_localizations`, and the requirement and override tables) are tenant
 * settings, kept in the tenant metadata database (`tenant_core/default`). The record of who
 * agreed (`user_consent_records`, `consent_item_history`) is account data, kept in the account's
 * own database (`tenant_core/users`, one of possibly several shards). The two may be different
 * databases, so code that touches both reads each side from its own store and joins them in the
 * application; no query joins them and no foreign key links them.
 *
 * In a single-database deployment both are the same database.
 */

import type { DatabaseAdapter } from '../db';

export interface StatementConsentStores {
  /** The tenant metadata database: statement, version, localization and requirement definitions. */
  metadata: DatabaseAdapter;
  /** The subject's account database: its consent records and consent history. */
  account: DatabaseAdapter;
}

/** The stores of a deployment that keeps metadata and accounts in one database. */
export function singleDatabaseStatementConsent(db: DatabaseAdapter): StatementConsentStores {
  return { metadata: db, account: db };
}
