import type { DatabaseAdapter, PreparedStatement } from '../db/adapter';

export const ACCOUNT_WEBHOOK_SNAPSHOT_RETENTION_MS = 7 * 86400_000;
export interface AccountWebhookSnapshotOwner {
  id: string;
  tenant_id: string;
  legacy_user_id: string | null;
  account_type: string;
  registration_state: 'guest' | 'registered';
  directory_publication_state: string;
  lifecycle_state: string;
}

/** Capture the database value inside the same PII batch that replaces it. */
export async function persistAccountEmailMutation(
  pii: DatabaseAdapter,
  account: AccountWebhookSnapshotOwner | null,
  after: unknown,
  mutation: PreparedStatement,
  onlyIfAbsent = false
): Promise<void> {
  if (
    !account ||
    account.account_type !== 'user' ||
    !account.legacy_user_id ||
    account.directory_publication_state !== 'active' ||
    ['deleted', 'deleting'].includes(account.lifecycle_state)
  ) {
    await pii.execute(mutation.sql, mutation.params);
    return;
  }
  if (after !== null && typeof after !== 'string')
    throw new Error('invalid_account_email_snapshot');
  const now = Date.now();
  const id = `evt_${crypto.randomUUID().replace(/-/g, '')}`;
  const afterJson = JSON.stringify(after);
  await pii.batch([
    {
      sql: `INSERT INTO account_webhook_snapshots
        (id, tenant_id, user_id, account_id, event_type, registration_state,
         email_before_json, email_after_json, created_at, expires_at)
        SELECT ?, ?, ?, ?, 'account.email.changed', ?, previous_email, ?, ?, ? FROM
        (SELECT COALESCE((SELECT CASE WHEN lifecycle_state = 'active' THEN CAST(value_json AS TEXT) ELSE 'null' END
          FROM identity_sensitive_values WHERE tenant_id = ? AND owner_type = 'runtime_user'
          AND owner_id = ? AND value_key = 'email'), 'null') AS previous_email) previous
        WHERE previous_email <> ? ${
          onlyIfAbsent
            ? `AND NOT EXISTS (
          SELECT 1 FROM identity_sensitive_values WHERE tenant_id = ? AND owner_type = 'runtime_user'
          AND owner_id = ? AND value_key = 'email' AND lifecycle_state = 'active')`
            : ''
        }`,
      params: [
        id,
        account.tenant_id,
        account.legacy_user_id,
        account.id,
        account.registration_state,
        afterJson,
        now,
        now + ACCOUNT_WEBHOOK_SNAPSHOT_RETENTION_MS,
        account.tenant_id,
        account.legacy_user_id,
        afterJson,
        ...(onlyIfAbsent ? [account.tenant_id, account.legacy_user_id] : []),
      ],
    },
    {
      sql: `INSERT INTO account_webhook_outbox
        (id, tenant_id, user_id, event_type, registration_state, changed_field, occurred_at)
        SELECT id, tenant_id, user_id, event_type, registration_state, 'email', created_at
        FROM account_webhook_snapshots WHERE id = ? AND tenant_id = ?`,
      params: [id, account.tenant_id],
    },
    mutation,
  ]);
}

/** Must run before Core deletion or PII cleanup. Retrying never replaces the captured value. */
export async function captureAccountDeletionSnapshot(
  pii: DatabaseAdapter,
  account: AccountWebhookSnapshotOwner
): Promise<void> {
  if (account.account_type !== 'user' || !account.legacy_user_id) return;
  const now = Date.now();
  await pii.execute(
    `INSERT INTO account_webhook_snapshots
      (id, tenant_id, user_id, account_id, event_type, registration_state,
       email_before_json, email_after_json, created_at, expires_at)
      SELECT ?, ?, ?, ?, 'account.deleted', ?,
        COALESCE((SELECT CAST(value_json AS TEXT) FROM identity_sensitive_values WHERE tenant_id = ?
          AND owner_type = 'runtime_user' AND owner_id = ? AND value_key = 'email'
          AND lifecycle_state = 'active'), 'null'),
        'null', ?, ?
      ON CONFLICT(id) DO NOTHING`,
    [
      `account-deletion:${account.tenant_id}:${account.legacy_user_id}`,
      account.tenant_id,
      account.legacy_user_id,
      account.id,
      account.registration_state,
      account.tenant_id,
      account.legacy_user_id,
      now,
      now + ACCOUNT_WEBHOOK_SNAPSHOT_RETENTION_MS,
    ]
  );
}
