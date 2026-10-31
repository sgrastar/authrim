import {
  ensureDatabaseAdapter,
  resolveTenantAssignedDatabaseSourcesFromRegistry,
  type DatabaseAdapter,
  type Env,
} from '@authrim/ar-lib-core';

/** Scheduled operations must locate the account's Core shard, not assume the tenant default. */
export async function resolveReplacementWebhookCore(
  env: Env,
  tenantId: string,
  userId: string
): Promise<DatabaseAdapter> {
  const stores = await resolveTenantAssignedDatabaseSourcesFromRegistry(env, {
    tenantId,
    role: 'tenant_core',
    maxStores: 32,
    concurrency: 4,
  });
  let found: DatabaseAdapter | undefined;
  for (const store of stores) {
    const adapter = ensureDatabaseAdapter(store.source, 'account-email-webhook-core');
    const account = await adapter.queryOne<{ id: string }>(
      'SELECT id FROM identity_accounts WHERE tenant_id = ? AND legacy_user_id = ?',
      [tenantId, userId],
      { consistencyClass: 'primary_required' }
    );
    if (!account) continue;
    if (found) throw new Error('account_email_webhook_ambiguous_account');
    found = adapter;
  }
  if (!found) throw new Error('account_email_webhook_account_unavailable');
  return found;
}

/** Statements run in the same PII batch that commits identifier replacement completion. */
export async function replacementWebhookStatements(input: {
  core: DatabaseAdapter;
  operationId: string;
  tenantId: string;
  userId: string;
  before: string;
  after: string;
  now: number;
}) {
  const account = await input.core.queryOne<{ id: string; registration_state: string }>(
    `SELECT id, registration_state FROM identity_accounts
     WHERE tenant_id = ? AND legacy_user_id = ? AND account_type = 'user'
       AND lifecycle_state NOT IN ('deleted', 'deleting') AND directory_publication_state = 'active'`,
    [input.tenantId, input.userId],
    { consistencyClass: 'primary_required' }
  );
  if (!account) return [];
  const id = `evt_email_change:${input.operationId}`;
  return [
    {
      sql: `INSERT INTO account_webhook_snapshots
       (id, tenant_id, user_id, account_id, event_type, registration_state,
        email_before_json, email_after_json, created_at, expires_at)
       SELECT ?, ?, ?, ?, 'account.email.changed', ?, ?, ?, ?, ?
       WHERE EXISTS (SELECT 1 FROM identity_identifier_replacement_operations
         WHERE operation_id = ? AND tenant_id = ? AND account_id = ? AND state = 'completed')
       ON CONFLICT(id) DO NOTHING`,
      params: [
        id,
        input.tenantId,
        input.userId,
        account.id,
        account.registration_state,
        JSON.stringify(input.before),
        JSON.stringify(input.after),
        input.now,
        input.now + 7 * 86400_000,
        input.operationId,
        input.tenantId,
        input.userId,
      ],
    },
    {
      sql: `INSERT INTO account_webhook_outbox
       (id, tenant_id, user_id, event_type, registration_state, changed_field, occurred_at)
       SELECT id, tenant_id, user_id, event_type, registration_state, 'email', created_at
       FROM account_webhook_snapshots WHERE id = ? AND tenant_id = ?
       ON CONFLICT(id) DO NOTHING`,
      params: [id, input.tenantId],
    },
  ];
}
