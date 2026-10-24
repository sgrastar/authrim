import type { DatabaseAdapter, PreparedStatement } from '../db/adapter';

/** HTTP idempotency IDs contain tenant, actor, method and path; they cannot have this shape. */
export const IDENTITY_MAPPING_CLIENT_HISTORY_RECEIPT_PREFIX =
  '__authrim_internal_identity_mapping_history_v1__:';
export const IDENTITY_MAPPING_CLIENT_HISTORY_RECEIPT_METHOD = 'INTERNAL_IDENTITY_MAPPING_HISTORY';
export const UNACKNOWLEDGED_EXPIRES_AT = Number.MAX_SAFE_INTEGER;
export const ACK_TTL_SECONDS = 86_400;

export interface IdentityMappingClientHistoryReceipt {
  version: 1;
  historyId: string;
  tenantId: string;
  clientId: string;
  beforeJson: string;
  afterJson: string;
  actorId: string;
  actorType: string;
  via: 'client' | 'restore';
  bulkId: string | null;
  createdAt: number;
  expectedUpdatedAt: number;
  sourceVersion: string;
}

export type IdentityMappingClientHistoryReceiptInput = Omit<
  IdentityMappingClientHistoryReceipt,
  'version' | 'sourceVersion' | 'expectedUpdatedAt'
>;

function receiptId(historyId: string): string {
  if (!/^[a-zA-Z0-9_-]{8,128}$/.test(historyId)) throw new Error('history_receipt_id_invalid');
  return `${IDENTITY_MAPPING_CLIENT_HISTORY_RECEIPT_PREFIX}${historyId}`;
}

async function digest(body: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function validate(receipt: IdentityMappingClientHistoryReceipt): void {
  receiptId(receipt.historyId);
  if (
    receipt.version !== 1 ||
    typeof receipt.tenantId !== 'string' ||
    !receipt.tenantId ||
    typeof receipt.clientId !== 'string' ||
    !receipt.clientId ||
    typeof receipt.actorId !== 'string' ||
    !receipt.actorId ||
    typeof receipt.actorType !== 'string' ||
    !receipt.actorType ||
    !['client', 'restore'].includes(receipt.via) ||
    (receipt.bulkId !== null && typeof receipt.bulkId !== 'string') ||
    !Number.isSafeInteger(receipt.createdAt) ||
    receipt.createdAt < 1 ||
    !Number.isSafeInteger(receipt.expectedUpdatedAt) ||
    receipt.expectedUpdatedAt < 0 ||
    !/^\d+$/.test(receipt.sourceVersion) ||
    !Number.isSafeInteger(Number(receipt.sourceVersion)) ||
    Number(receipt.sourceVersion) <= receipt.expectedUpdatedAt
  )
    throw new Error('history_receipt_invalid');
  for (const json of [receipt.beforeJson, receipt.afterJson]) {
    if (typeof json !== 'string' || json.length > 8192) throw new Error('history_receipt_invalid');
    const value: unknown = JSON.parse(json);
    if (value !== null && (typeof value !== 'object' || Array.isArray(value))) {
      throw new Error('history_receipt_invalid');
    }
  }
}

/** Precedes the same-version UPDATE in one atomic SQLite/D1 batch; no connection-local state. */
export async function identityMappingClientHistoryReceiptStatement(
  input: IdentityMappingClientHistoryReceiptInput,
  expectedUpdatedAt: number,
  updatedAt: number
): Promise<PreparedStatement> {
  const receipt: IdentityMappingClientHistoryReceipt = {
    ...input,
    version: 1,
    expectedUpdatedAt,
    sourceVersion: String(updatedAt),
  };
  validate(receipt);
  const body = JSON.stringify(receipt);
  return {
    sql: `INSERT INTO idempotency_keys
      (id, tenant_id, actor_id, method, path, resource_id, idempotency_key, body_hash,
       response_status, response_body, created_at, expires_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, 200, ?, ?, ? FROM oauth_clients
        WHERE tenant_id = ? AND client_id = ? AND updated_at = ?`,
    params: [
      receiptId(input.historyId),
      input.tenantId,
      input.actorId,
      IDENTITY_MAPPING_CLIENT_HISTORY_RECEIPT_METHOD,
      'internal/identity-mapping-level-history',
      input.clientId,
      input.historyId,
      await digest(body),
      body,
      Math.floor(input.createdAt / 1000),
      UNACKNOWLEDGED_EXPIRES_AT,
      input.tenantId,
      input.clientId,
      expectedUpdatedAt,
    ],
  };
}

export function identityMappingClientHistoryReceiptId(historyId: string): string {
  return receiptId(historyId);
}

interface ReceiptRow {
  id: string;
  tenant_id: string;
  method: string;
  resource_id: string;
  idempotency_key: string;
  body_hash: string;
  response_body: string;
  response_status: number;
}

async function parse(row: ReceiptRow): Promise<IdentityMappingClientHistoryReceipt> {
  const parsed: unknown = JSON.parse(row.response_body);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('history_receipt_invalid');
  }
  const receipt = parsed as IdentityMappingClientHistoryReceipt;
  validate(receipt);
  if (
    row.id !== receiptId(receipt.historyId) ||
    row.tenant_id !== receipt.tenantId ||
    row.method !== IDENTITY_MAPPING_CLIENT_HISTORY_RECEIPT_METHOD ||
    row.resource_id !== receipt.clientId ||
    row.idempotency_key !== receipt.historyId ||
    row.response_status !== 200 ||
    row.body_hash !== (await digest(row.response_body))
  )
    throw new Error('history_receipt_invalid');
  return receipt;
}

export async function readIdentityMappingClientHistoryReceipt(
  core: DatabaseAdapter,
  tenantId: string,
  historyId: string
): Promise<IdentityMappingClientHistoryReceipt | null> {
  const row = await core.queryOne<ReceiptRow>(
    'SELECT * FROM idempotency_keys WHERE tenant_id = ? AND id = ?',
    [tenantId, receiptId(historyId)],
    { consistencyClass: 'primary_required' }
  );
  return row ? parse(row) : null;
}

/** Call only after the corresponding committed Admin history has been read from its primary. */
export async function ackIdentityMappingClientHistoryReceipt(
  core: DatabaseAdapter,
  tenantId: string,
  historyId: string,
  nowMs = Date.now()
): Promise<void> {
  if (!(await readIdentityMappingClientHistoryReceipt(core, tenantId, historyId))) {
    throw new Error('history_receipt_missing');
  }
  await core.execute(
    `UPDATE idempotency_keys SET expires_at = ?
      WHERE tenant_id = ? AND id = ? AND method = ? AND expires_at = ?`,
    [
      Math.floor(nowMs / 1000) + ACK_TTL_SECONDS,
      tenantId,
      receiptId(historyId),
      IDENTITY_MAPPING_CLIENT_HISTORY_RECEIPT_METHOD,
      UNACKNOWLEDGED_EXPIRES_AT,
    ]
  );
}

export async function listIdentityMappingClientHistoryReceipts(
  core: DatabaseAdapter,
  tenantId: string,
  options: { afterId?: string; limit?: number } = {}
): Promise<{ receipts: IdentityMappingClientHistoryReceipt[]; nextAfterId: string | null }> {
  const limit = options.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200)
    throw new Error('history_receipt_limit');
  const rows = await core.query<ReceiptRow>(
    `SELECT * FROM idempotency_keys WHERE tenant_id = ? AND method = ? AND expires_at = ?
      AND id >= ? AND id < ? AND id > ? ORDER BY id LIMIT ?`,
    [
      tenantId,
      IDENTITY_MAPPING_CLIENT_HISTORY_RECEIPT_METHOD,
      UNACKNOWLEDGED_EXPIRES_AT,
      IDENTITY_MAPPING_CLIENT_HISTORY_RECEIPT_PREFIX,
      `${IDENTITY_MAPPING_CLIENT_HISTORY_RECEIPT_PREFIX}\uffff`,
      options.afterId ?? '',
      limit + 1,
    ],
    { consistencyClass: 'primary_required' }
  );
  return {
    receipts: await Promise.all(rows.slice(0, limit).map(parse)),
    nextAfterId: rows.length > limit ? rows[limit - 1].id : null,
  };
}
