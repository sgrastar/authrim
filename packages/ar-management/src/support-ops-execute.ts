import {
  SUBJECT_UPDATED_AT_FORWARD_SQL,
  SUPPORT_OPS_ACCOUNT_METADATA_SQL,
  type DatabaseAdapter,
} from '@authrim/ar-lib-core';

const RECEIPT_DOMAIN = 'authrim/support-ops-account-result/v1';
export const SUPPORT_OPS_ACCOUNT_RESULT_ACK_TTL_MS = 86_400_000;
export const SUPPORT_OPS_ACCOUNT_RESULT_PERMIT_MS = 20_000;
const MAX_TIMESTAMP = Number.MAX_SAFE_INTEGER - SUPPORT_OPS_ACCOUNT_RESULT_ACK_TTL_MS;
// Evaluate the permit when the atomic statement executes, not when the Worker sends it.
const DATABASE_NOW_MS =
  "(CAST(strftime('%s','now') AS INTEGER)*1000 + CAST(substr(strftime('%f','now'),4,3) AS INTEGER))";

export interface SupportOpsAccountMutation {
  tenantId: string;
  actionId: string;
  accountId: string;
  userId: string;
  operationId: string;
  sourceVersionMs: number;
  actorId: string;
}
interface ReceiptRow {
  receipt_id: string;
  tenant_id: string;
  action_id: string;
  account_id: string;
  legacy_user_id: string;
  operation_id: string;
  source_version_ms: number;
  actor_id: string;
  request_hash: string;
  succeeded: number;
  applied: number;
}
function timestamp(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_TIMESTAMP)
    throw new Error('support_ops_account_receipt_time_invalid');
}
function supported(db: DatabaseAdapter): void {
  // Only these adapters promise an atomic batch of the SQLite statements below.
  if (!['d1', 'sqlite'].includes(db.getType()))
    throw new Error('support_ops_receipt_adapter_unsupported');
}
function tuple(input: SupportOpsAccountMutation): readonly (string | number)[] {
  const ids = [
    input.tenantId,
    input.actionId,
    input.accountId,
    input.userId,
    input.operationId,
    input.actorId,
  ];
  if (
    ids.some(
      (id) =>
        typeof id !== 'string' ||
        id.length < 1 ||
        id.length > 512 ||
        Array.from(id).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
    ) ||
    !Number.isSafeInteger(input.sourceVersionMs) ||
    input.sourceVersionMs < 1
  )
    throw new Error('support_ops_account_receipt_input_invalid');
  return [
    RECEIPT_DOMAIN,
    input.tenantId,
    input.actionId,
    input.accountId,
    input.userId,
    input.operationId,
    input.sourceVersionMs,
    input.actorId,
    'suspend',
  ];
}
async function receiptKey(input: SupportOpsAccountMutation): Promise<string> {
  const hash = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(tuple(input)))
  );
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
/** Check the dedicated schema before a DO mutation. No tenant inventory row is required. */
export async function assertSupportOpsAccountReceiptStore(db: DatabaseAdapter): Promise<void> {
  supported(db);
  await db.queryOne(
    `SELECT receipt_id, tenant_id, action_id, account_id, legacy_user_id,
    operation_id, source_version_ms, actor_id, request_hash, attempt_token, succeeded, applied,
    created_at_ms, acknowledged_at_ms, delete_after_ms
    FROM support_ops_account_result_receipts LIMIT 1`,
    [],
    { consistencyClass: 'primary_required' }
  );
}
/** No HTTP idempotency namespace, raw result API, or optimistic rowsAffected inference is used. */
export async function readSupportOpsAccountResult(
  db: DatabaseAdapter,
  input: SupportOpsAccountMutation
): Promise<0 | 1 | null> {
  supported(db);
  const key = await receiptKey(input);
  const row = await db.queryOne<ReceiptRow>(
    `SELECT receipt_id, tenant_id, action_id, account_id,
    legacy_user_id, operation_id, source_version_ms, actor_id, request_hash, succeeded, applied
    FROM support_ops_account_result_receipts WHERE receipt_id = ?`,
    [key],
    { consistencyClass: 'primary_required' }
  );
  if (!row) return null;
  if (
    row.receipt_id !== key ||
    row.request_hash !== key ||
    row.tenant_id !== input.tenantId ||
    row.action_id !== input.actionId ||
    row.account_id !== input.accountId ||
    row.legacy_user_id !== input.userId ||
    row.operation_id !== input.operationId ||
    row.source_version_ms !== input.sourceVersionMs ||
    row.actor_id !== input.actorId ||
    (row.succeeded !== 0 && row.succeeded !== 1) ||
    row.applied !== 1
  )
    throw new Error('support_ops_account_receipt_conflict');
  return row.succeeded;
}
/** Account, subject and exact outcome commit atomically. Replays do not apply the mutation again.
 * permitUntilMs is fixed at this invocation's start, before any Admin heartbeat/await. It must not
 * be renewed by a delayed runner. A missing result after permit expiry is an unknown result/error.
 */
export async function suspendSupportOpsAccountOnce(
  db: DatabaseAdapter,
  input: SupportOpsAccountMutation,
  applyAllowed: boolean,
  nowMs: number,
  permitUntilMs: number
): Promise<0 | 1> {
  supported(db);
  timestamp(nowMs);
  timestamp(permitUntilMs);
  if (permitUntilMs < nowMs || permitUntilMs - nowMs > SUPPORT_OPS_ACCOUNT_RESULT_PERMIT_MS)
    throw new Error('support_ops_account_receipt_permit_invalid');
  const key = await receiptKey(input);
  const existing = await readSupportOpsAccountResult(db, input);
  if (existing !== null) return existing;
  const attempt = crypto.randomUUID();
  const metadata = SUPPORT_OPS_ACCOUNT_METADATA_SQL;
  const version = `COALESCE(CAST(json_extract(${metadata}, '$.lifecycle_version_ms') AS INTEGER), 0)`;
  const same = `${version} = ? AND json_extract(${metadata}, '$.lifecycle_operation_id') = ?`;
  const eligible = `deleted_at IS NULL AND ((lifecycle_state = 'active' AND ${version} < ?)
    OR (lifecycle_state = 'suspended' AND ${same}))`;
  const accountWhere = `tenant_id = ? AND id = ? AND legacy_user_id = ? AND ${eligible}`;
  const accountParams = [
    input.tenantId,
    input.accountId,
    input.userId,
    input.sourceVersionMs,
    input.sourceVersionMs,
    input.operationId,
  ];
  const owned = `EXISTS (SELECT 1 FROM support_ops_account_result_receipts
    WHERE receipt_id = ? AND attempt_token = ? AND succeeded = 1 AND applied = 0)`;
  const own = [key, attempt];
  const results = await db.batch([
    {
      sql: `INSERT INTO support_ops_account_result_receipts
      (receipt_id, tenant_id, action_id, account_id, legacy_user_id, operation_id,
       source_version_ms, actor_id, request_hash, attempt_token, succeeded, created_at_ms)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? = 1 AND EXISTS (
        SELECT 1 FROM identity_accounts WHERE ${accountWhere}
      ) THEN 1 ELSE 0 END, ? WHERE ${DATABASE_NOW_MS} <= ?
      ON CONFLICT(receipt_id) DO NOTHING`,
      params: [
        key,
        input.tenantId,
        input.actionId,
        input.accountId,
        input.userId,
        input.operationId,
        input.sourceVersionMs,
        input.actorId,
        key,
        attempt,
        applyAllowed ? 1 : 0,
        ...accountParams,
        nowMs,
        permitUntilMs,
      ],
    },
    {
      sql: `UPDATE identity_accounts SET lifecycle_state = 'suspended',
      metadata_json = json_set(${metadata}, '$.status', 'suspended', '$.suspended_at', ?,
        '$.lifecycle_version_ms', ?, '$.lifecycle_operation_id', ?),
      updated_at = CASE WHEN updated_at > ? THEN updated_at ELSE ? END
      WHERE ${accountWhere} AND ${owned}`,
      params: [
        Math.floor(input.sourceVersionMs / 1000),
        input.sourceVersionMs,
        input.operationId,
        nowMs,
        nowMs,
        ...accountParams,
        ...own,
      ],
    },
    {
      sql: `UPDATE identity_subjects SET lifecycle_state = 'suspended', ${SUBJECT_UPDATED_AT_FORWARD_SQL}
      WHERE tenant_id = ? AND id IN (SELECT primary_subject_id FROM identity_accounts
        WHERE tenant_id = ? AND id = ? AND legacy_user_id = ? AND ${same}) AND ${owned}`,
      params: [
        nowMs,
        nowMs,
        input.tenantId,
        input.tenantId,
        input.accountId,
        input.userId,
        input.sourceVersionMs,
        input.operationId,
        ...own,
      ],
    },
    // D1Adapter may retry the exact same batch after its response is lost. Seal this attempt
    // inside the atomic batch so even that internal retry cannot apply account/subject twice.
    {
      sql: `UPDATE support_ops_account_result_receipts SET applied = 1
      WHERE receipt_id = ? AND attempt_token = ? AND applied = 0`,
      params: own,
    },
  ]);
  if (results.some((result) => !result.success))
    throw new Error('support_ops_account_receipt_batch_failed');
  const stored = await readSupportOpsAccountResult(db, input);
  if (stored === null) throw new Error('support_ops_account_receipt_missing_or_permit_expired');
  return stored;
}
/** Only after Admin durably stores this result. Retry keeps the original ACK/TTL, not a sliding TTL. */
export async function acknowledgeSupportOpsAccountResult(
  db: DatabaseAdapter,
  input: SupportOpsAccountMutation,
  nowMs: number
): Promise<void> {
  supported(db);
  timestamp(nowMs);
  if ((await readSupportOpsAccountResult(db, input)) === null) return;
  await db.execute(
    `UPDATE support_ops_account_result_receipts
    SET acknowledged_at_ms = MAX(created_at_ms, ?),
      delete_after_ms = MAX(created_at_ms, ?) + ?
    WHERE receipt_id = ? AND acknowledged_at_ms IS NULL`,
    [nowMs, nowMs, SUPPORT_OPS_ACCOUNT_RESULT_ACK_TTL_MS, await receiptKey(input)]
  );
}
/** One bounded cleanup, after pending/active jobs have been serviced. UnACKed evidence is excluded. */
export async function cleanupSupportOpsAccountResultReceipts(
  db: DatabaseAdapter,
  nowMs: number,
  limit = 25
): Promise<number> {
  supported(db);
  timestamp(nowMs);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new Error('support_ops_account_receipt_cleanup_limit_invalid');
  const result = await db.execute(
    `DELETE FROM support_ops_account_result_receipts WHERE receipt_id IN (
    SELECT receipt_id FROM support_ops_account_result_receipts
    WHERE acknowledged_at_ms IS NOT NULL AND delete_after_ms <= ?
    ORDER BY delete_after_ms, receipt_id LIMIT ?)`,
    [nowMs, limit]
  );
  if (!result.success) throw new Error('support_ops_account_receipt_cleanup_failed');
  return result.rowsAffected;
}
