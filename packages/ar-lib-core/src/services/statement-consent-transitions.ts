import type { PreparedStatement } from '../db/adapter';
import type { StatementConsentAtomicCapability } from '../db/statement-consent-atomic';
import type { ConsentItemAction, ConsentRecordStatus } from '../types/consent-statements';

/** Account-local atomic transitions admitted by a trusted metadata definition snapshot. */
export interface StatementConsentRawRecord {
  id: string;
  tenant_id: string;
  user_id: string;
  statement_id: string;
  version_id: string;
  version: string;
  status: ConsentRecordStatus;
  granted_at: number | null;
  withdrawn_at: number | null;
  expires_at: number | null;
  client_id: string | null;
  ip_address_hash: string | null;
  user_agent: string | null;
  receipt_id: string | null;
  created_at: number;
  updated_at: number;
  retain_until: number | null;
  consent_settings_snapshot_at: number | null;
  record_retention_days_snapshot: number | null;
  reconsent_interval_days_snapshot: number | null;
  content_hash: string | null;
}

export interface StatementConsentRawHistory {
  id: string;
  tenant_id: string;
  user_id: string;
  statement_id: string;
  action: ConsentItemAction;
  version_before: string | null;
  version_after: string | null;
  status_before: string | null;
  status_after: string | null;
  ip_address_hash: string | null;
  user_agent: string | null;
  client_id: string | null;
  metadata_json: string | null;
  created_at: number;
  version_id_before: string | null;
  version_id_after: string | null;
  granted_at: number | null;
  withdrawn_at: number | null;
  expires_at: number | null;
  retain_until: number | null;
  consent_settings_snapshot_at: number | null;
  record_retention_days_snapshot: number | null;
  reconsent_interval_days_snapshot: number | null;
  content_hash_after: string | null;
}

export const STATEMENT_CONSENT_RECORD_COLUMNS = [
  'id',
  'tenant_id',
  'user_id',
  'statement_id',
  'version_id',
  'version',
  'status',
  'granted_at',
  'withdrawn_at',
  'expires_at',
  'client_id',
  'ip_address_hash',
  'user_agent',
  'receipt_id',
  'created_at',
  'updated_at',
  'retain_until',
  'consent_settings_snapshot_at',
  'record_retention_days_snapshot',
  'reconsent_interval_days_snapshot',
  'content_hash',
] as const satisfies readonly (keyof StatementConsentRawRecord)[];

export const STATEMENT_CONSENT_HISTORY_COLUMNS = [
  'id',
  'tenant_id',
  'user_id',
  'statement_id',
  'action',
  'version_before',
  'version_after',
  'status_before',
  'status_after',
  'ip_address_hash',
  'user_agent',
  'client_id',
  'metadata_json',
  'created_at',
  'version_id_before',
  'version_id_after',
  'granted_at',
  'withdrawn_at',
  'expires_at',
  'retain_until',
  'consent_settings_snapshot_at',
  'record_retention_days_snapshot',
  'reconsent_interval_days_snapshot',
  'content_hash_after',
] as const satisfies readonly (keyof StatementConsentRawHistory)[];

const RECORD_PROJECTION = STATEMENT_CONSENT_RECORD_COLUMNS.filter(
  (column) => column !== 'ip_address_hash' && column !== 'user_agent'
);
const HISTORY_PROJECTION = STATEMENT_CONSENT_HISTORY_COLUMNS.filter(
  (column) => column !== 'ip_address_hash' && column !== 'user_agent' && column !== 'metadata_json'
);
const MAX_BYTES = 32_768;
const MAX_SAFE = Number.MAX_SAFE_INTEGER;

export interface StatementConsentDefinitionSnapshot {
  tenant_id: string;
  statement_id: string;
  version_id: string;
  version: string;
  content_hash: string | null;
  definition_generation: number;
  is_active: number;
  version_status: string;
}

export interface StatementConsentTransition {
  /** Read from metadata at submission time, never accepted from an HTTP body. */
  definition: StatementConsentDefinitionSnapshot;
  operationId: string;
  actor: { id: string; type: string };
  /** Obtained from trusted resolution, never from the consent HTTP body. */
  owner: {
    tenantId: string;
    userId: string;
    accountId: string;
    statementId: string;
    physicalId: string;
    restoreEpoch: string;
  };
  expected: {
    revision: number;
    withdrawalGeneration: number;
    definitionGeneration: number;
    closedGeneration: number;
  };
  action: 'grant' | 'deny' | 'withdraw';
  issuedAt: number;
  expiresAt: number;
  effectAt: number;
  before: StatementConsentRawRecord | null;
  after: StatementConsentRawRecord;
  history: StatementConsentRawHistory | null;
  noop: boolean;
}

export type StatementConsentOperationResult =
  | { outcome: 'rejected' }
  | {
      outcome: 'applied' | 'noop';
      revision: number;
      withdrawalGeneration: number;
    };

interface OperationRow {
  tenant_id: string;
  operation_id: string;
  payload_sha256: string;
  status: 'executing' | 'applied' | 'rejected';
  is_terminal: number;
  is_noop: number;
  expected_revision: number;
  expected_withdrawal_generation: number;
  action: 'grant' | 'deny' | 'withdraw';
  physical_id: string;
  restore_epoch: string;
}

function invalid(): never {
  throw new Error('statement_consent_transition_invalid');
}

function safe(value: number, upper = MAX_SAFE): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > upper) invalid();
}

function text(value: string): void {
  if (!value || value.length > 512 || value.includes('\0')) invalid();
}

/** The receipt key is tenant+op; existing history has a global PK. Preserve both contracts. */
export function statementConsentHistoryId(tenantId: string, operationId: string): string {
  text(tenantId);
  if (!/^[a-f0-9]{64}$/.test(operationId)) invalid();
  // Fixed-length op followed by the entire tenant string is unambiguous, including ':' in IDs.
  return `sc_${operationId}:${tenantId}`;
}

function project<T extends object>(value: T, columns: readonly (keyof T)[]): string {
  const result = Object.fromEntries(columns.map((column) => [column, value[column]]));
  return JSON.stringify(result);
}

function checkRecord(record: StatementConsentRawRecord): void {
  for (const column of ['id', 'tenant_id', 'user_id', 'statement_id', 'version_id'] as const) {
    text(record[column]);
  }
  if (!/^\d{8}$/.test(record.version)) invalid();
  if (!['granted', 'denied', 'withdrawn', 'expired'].includes(record.status)) invalid();
  for (const column of ['created_at', 'updated_at'] as const) safe(record[column]);
  for (const column of [
    'granted_at',
    'withdrawn_at',
    'expires_at',
    'retain_until',
    'consent_settings_snapshot_at',
    'record_retention_days_snapshot',
    'reconsent_interval_days_snapshot',
  ] as const) {
    const value = record[column];
    if (value !== null) safe(value);
  }
}

function validate(input: StatementConsentTransition): void {
  if (!/^[a-f0-9]{64}$/.test(input.operationId)) invalid();
  text(input.actor.id);
  text(input.actor.type);
  if (input.actor.type.length > 128) invalid();
  for (const value of Object.values(input.owner)) text(value);
  safe(input.expected.revision, MAX_SAFE - 1);
  safe(input.expected.withdrawalGeneration, MAX_SAFE - 1);
  safe(input.expected.definitionGeneration);
  safe(input.expected.closedGeneration);
  for (const value of [input.issuedAt, input.expiresAt, input.effectAt]) safe(value);
  if (
    input.expiresAt < input.issuedAt ||
    input.effectAt < input.issuedAt ||
    input.effectAt > input.expiresAt
  )
    invalid();
  safe(input.definition.definition_generation);
  if (![0, 1].includes(input.definition.is_active)) invalid();
  for (const key of [
    'tenant_id',
    'statement_id',
    'version_id',
    'version',
    'version_status',
  ] as const)
    text(input.definition[key]);
  for (const hash of [
    input.definition.content_hash,
    input.after.content_hash,
    input.before?.content_hash ?? null,
    input.history?.content_hash_after ?? null,
  ]) {
    if (hash !== null && (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash))) invalid();
  }
  if (input.history && input.history.content_hash_after !== input.after.content_hash) invalid();
  checkRecord(input.after);
  if (input.before) checkRecord(input.before);
  const ownerMatches = (row: StatementConsentRawRecord | StatementConsentRawHistory) =>
    row.tenant_id === input.owner.tenantId &&
    row.user_id === input.owner.userId &&
    row.statement_id === input.owner.statementId;
  if (!ownerMatches(input.after) || (input.before && !ownerMatches(input.before))) invalid();
  if (
    input.before &&
    (input.after.id !== input.before.id ||
      input.after.created_at !== input.before.created_at ||
      input.after.updated_at < input.before.updated_at)
  )
    invalid();
  if (input.noop) {
    if (
      input.action !== 'grant' ||
      !input.before ||
      input.history ||
      JSON.stringify(STATEMENT_CONSENT_RECORD_COLUMNS.map((column) => input.before?.[column])) !==
        JSON.stringify(STATEMENT_CONSENT_RECORD_COLUMNS.map((column) => input.after[column])) ||
      input.after.status !== 'granted'
    )
      invalid();
  } else {
    const history = input.history;
    if (
      !history ||
      !ownerMatches(history) ||
      history.id !== statementConsentHistoryId(input.owner.tenantId, input.operationId) ||
      history.status_before !== (input.before?.status ?? null) ||
      history.status_after !== input.after.status ||
      history.version_id_before !== (input.before?.version_id ?? null) ||
      history.version_before !== (input.before?.version ?? null) ||
      history.version_id_after !== input.after.version_id ||
      history.version_after !== input.after.version
    )
      invalid();
    safe(history.created_at);
    for (const column of [
      'granted_at',
      'withdrawn_at',
      'expires_at',
      'retain_until',
      'consent_settings_snapshot_at',
      'record_retention_days_snapshot',
      'reconsent_interval_days_snapshot',
    ] as const) {
      const value = history[column];
      if (value !== null) safe(value);
      if (history[column] !== input.after[column]) invalid();
    }
    if (
      (input.action === 'grant' &&
        (input.after.status !== 'granted' ||
          !['granted', 'version_upgraded'].includes(history.action))) ||
      (input.action === 'withdraw' &&
        (input.after.status !== 'withdrawn' || history.action !== 'withdrawn')) ||
      (input.action === 'deny' &&
        (!['denied', 'withdrawn'].includes(input.after.status) ||
          !['denied', 'withdrawn'].includes(history.action)))
    )
      invalid();
  }
  if (new TextEncoder().encode(JSON.stringify(input)).byteLength > MAX_BYTES) invalid();
}

async function digest(value: string): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  );
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function sqlJson(
  dialect: StatementConsentAtomicCapability['dialect'],
  alias: string,
  columns: readonly string[]
): string {
  const fn = dialect === 'postgres' ? 'jsonb_build_object' : 'json_object';
  return `${fn}(${columns.map((column) => `'${column}', ${alias}.${column}`).join(', ')})`;
}

function statementConsentDefinitionGuard(dialect: 'd1' | 'postgres', alias: string): string {
  const field = (source: string, key: string) =>
    dialect === 'postgres'
      ? `(${alias}.${source}::jsonb ->> '${key}')`
      : `json_extract(${alias}.${source}, '$.${key}')`;
  const d = (key: string) => field('definition_json', key);
  const after = (key: string) => field('after_json', key);
  return `${d('tenant_id')}=${alias}.tenant_id AND ${d('statement_id')}=${alias}.statement_id
    AND CAST(${d('definition_generation')} AS ${dialect === 'postgres' ? 'BIGINT' : 'INTEGER'})=${alias}.expected_definition_generation
    AND ${d('version_id')}=${after('version_id')} AND ${d('version')}=${after('version')}
    AND (${d('content_hash')} ${dialect === 'postgres' ? 'IS NOT DISTINCT FROM' : 'IS'} ${after('content_hash')})
    AND (${alias}.action<>'grant' OR (CAST(${d('is_active')} AS ${dialect === 'postgres' ? 'BIGINT' : 'INTEGER'})=1 AND ${d('version_status')}='active'))`;
}

/** Exported for real fault tests to remove a statement; not an externally supplied SQL list. */
export async function prepareStatementConsentTransition(
  capability: StatementConsentAtomicCapability,
  input: StatementConsentTransition,
  attemptId = crypto.randomUUID()
): Promise<{ payloadHash: string; statements: PreparedStatement[] }> {
  validate(input);
  const payloadHash = await digest(
    JSON.stringify([
      input.operationId,
      [input.actor.id, input.actor.type],
      [
        input.owner.tenantId,
        input.owner.userId,
        input.owner.accountId,
        input.owner.statementId,
        input.owner.physicalId,
        input.owner.restoreEpoch,
      ],
      [
        input.expected.revision,
        input.expected.withdrawalGeneration,
        input.expected.definitionGeneration,
        input.expected.closedGeneration,
      ],
      input.action,
      input.definition,
      input.issuedAt,
      input.expiresAt,
      input.effectAt,
      STATEMENT_CONSENT_RECORD_COLUMNS.map((column) => input.before?.[column] ?? null),
      STATEMENT_CONSENT_RECORD_COLUMNS.map((column) => input.after[column]),
      input.history
        ? STATEMENT_CONSENT_HISTORY_COLUMNS.map((column) => input.history?.[column])
        : null,
      input.noop,
    ])
  );
  const pg = capability.dialect === 'postgres';
  const now = pg
    ? 'CAST(FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000) AS BIGINT)'
    : "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";
  const before = input.before ? project(input.before, RECORD_PROJECTION) : null;
  const after = project(input.after, RECORD_PROJECTION);
  const history = input.history ? project(input.history, HISTORY_PROJECTION) : null;
  const json = (source: string) => (pg ? `(${source})::jsonb` : `json(${source})`);
  const projection = sqlJson(capability.dialect, 'r', RECORD_PROJECTION);
  const guard = `EXISTS (SELECT 1 FROM statement_consent_guards t JOIN statement_consent_guards s ON s.tenant_id=t.tenant_id
    WHERE t.tenant_id=p.tenant_id AND t.scope_kind='tenant' AND t.scope_key='' AND t.mode='enforced'
      AND s.scope_kind='statement' AND s.scope_key=p.statement_id AND (s.mode='enforced' OR (p.action<>'grant' AND s.mode='closed'))
      AND t.account_id=p.account_id AND s.account_id=p.account_id
      AND t.physical_id=p.physical_id AND s.physical_id=p.physical_id AND t.restore_epoch=p.restore_epoch AND s.restore_epoch=p.restore_epoch
      AND s.definition_generation=p.expected_definition_generation AND s.closed_generation=p.expected_closed_generation)
    AND EXISTS (SELECT 1 FROM statement_consent_key_states k WHERE k.tenant_id=p.tenant_id AND k.user_id=p.user_id AND k.statement_id=p.statement_id
      AND k.account_id=p.account_id AND k.physical_id=p.physical_id AND k.restore_epoch=p.restore_epoch
      AND k.revision=p.expected_revision AND k.withdrawal_generation=p.expected_withdrawal_generation)
    AND ${now} BETWEEN p.issued_at AND p.expires_at
    AND ((p.before_json IS NULL AND NOT EXISTS(SELECT 1 FROM user_consent_records r WHERE r.tenant_id=p.tenant_id AND r.user_id=p.user_id AND r.statement_id=p.statement_id))
      OR EXISTS(SELECT 1 FROM user_consent_records r WHERE r.tenant_id=p.tenant_id AND r.user_id=p.user_id AND r.statement_id=p.statement_id AND ${projection}=${json('p.before_json')}))
    AND ${statementConsentDefinitionGuard(capability.dialect, 'p')}
    AND (p.is_noop=1 OR NOT EXISTS(SELECT 1 FROM consent_item_history h WHERE h.id=?))`;
  const columns = [
    'tenant_id',
    'operation_id',
    'attempt_id',
    'payload_sha256',
    'actor_id',
    'actor_type',
    'action',
    'user_id',
    'account_id',
    'statement_id',
    'physical_id',
    'restore_epoch',
    'expected_revision',
    'expected_withdrawal_generation',
    'expected_definition_generation',
    'expected_closed_generation',
    'issued_at',
    'expires_at',
    'effect_at',
    'before_json',
    'after_json',
    'history_json',
    'definition_json',
    'is_noop',
  ];
  const values: unknown[] = [
    input.owner.tenantId,
    input.operationId,
    attemptId,
    payloadHash,
    input.actor.id,
    input.actor.type,
    input.action,
    input.owner.userId,
    input.owner.accountId,
    input.owner.statementId,
    input.owner.physicalId,
    input.owner.restoreEpoch,
    input.expected.revision,
    input.expected.withdrawalGeneration,
    input.expected.definitionGeneration,
    input.expected.closedGeneration,
    input.issuedAt,
    input.expiresAt,
    input.effectAt,
    before,
    after,
    history,
    JSON.stringify(input.definition),
    input.noop ? 1 : 0,
  ];
  const active = `EXISTS(SELECT 1 FROM statement_consent_operations o WHERE o.tenant_id=? AND o.operation_id=? AND o.attempt_id=? AND o.status='executing' AND o.admitted=1 AND o.is_noop=0)`;
  const token = [input.owner.tenantId, input.operationId, attemptId];
  const statements: PreparedStatement[] = [];
  if (pg) {
    statements.push({
      sql: `SELECT tenant_id FROM statement_consent_guards WHERE tenant_id=? AND scope_kind='tenant' AND scope_key='' FOR UPDATE`,
      params: [input.owner.tenantId],
    });
    statements.push({
      sql: `SELECT tenant_id FROM statement_consent_guards WHERE tenant_id=? AND scope_kind='statement' AND scope_key=? FOR UPDATE`,
      params: [input.owner.tenantId, input.owner.statementId],
    });
    statements.push({
      sql: `SELECT tenant_id FROM statement_consent_key_states WHERE tenant_id=? AND user_id=? AND statement_id=? FOR UPDATE`,
      params: [input.owner.tenantId, input.owner.userId, input.owner.statementId],
    });
  }
  const numeric = new Set([
    'expected_revision',
    'expected_withdrawal_generation',
    'expected_definition_generation',
    'expected_closed_generation',
    'issued_at',
    'expires_at',
    'effect_at',
    'is_noop',
  ]);
  statements.push({
    sql: `WITH p AS (SELECT ${columns.map((column) => `${pg ? `CAST(? AS ${numeric.has(column) ? 'BIGINT' : 'TEXT'})` : '?'} AS ${column}`).join(', ')})
      INSERT INTO statement_consent_operations (${columns.join(', ')},admitted)
      SELECT ${columns.map((column) => `p.${column}`).join(', ')}, CASE WHEN ${guard} THEN 1 ELSE 0 END FROM p
      WHERE NOT EXISTS(SELECT 1 FROM statement_consent_operations o WHERE o.tenant_id=p.tenant_id AND o.operation_id=p.operation_id)
      ON CONFLICT(tenant_id,operation_id) DO NOTHING`,
    params: [...values, input.history?.id ?? null],
  });
  statements.push({
    sql: `UPDATE statement_consent_key_states SET revision=revision+1,withdrawal_generation=withdrawal_generation+?,last_operation_id=?,updated_at=CASE WHEN updated_at>? THEN updated_at ELSE ? END
      WHERE tenant_id=? AND user_id=? AND statement_id=? AND revision=? AND withdrawal_generation=? AND ${active}`,
    params: [
      input.action === 'grant' ? 0 : 1,
      input.operationId,
      input.effectAt,
      input.effectAt,
      input.owner.tenantId,
      input.owner.userId,
      input.owner.statementId,
      input.expected.revision,
      input.expected.withdrawalGeneration,
      ...token,
    ],
  });
  const recordValues = STATEMENT_CONSENT_RECORD_COLUMNS.map((column) => input.after[column]);
  if (input.before === null) {
    statements.push({
      sql: `INSERT INTO user_consent_records (${STATEMENT_CONSENT_RECORD_COLUMNS.join(',')}) SELECT ${recordValues.map(() => '?').join(',')} WHERE ${active}`,
      params: [...recordValues, ...token],
    });
  } else {
    statements.push({
      sql: `UPDATE user_consent_records SET ${STATEMENT_CONSENT_RECORD_COLUMNS.map((column) => `${column}=?`).join(',')}
      WHERE id=? AND tenant_id=? AND user_id=? AND statement_id=? AND ${active}`,
      params: [
        ...recordValues,
        input.before.id,
        input.owner.tenantId,
        input.owner.userId,
        input.owner.statementId,
        ...token,
      ],
    });
  }
  if (input.history) {
    if (input.before) {
      const retain = [
        'retain_until',
        'consent_settings_snapshot_at',
        'record_retention_days_snapshot',
        'reconsent_interval_days_snapshot',
      ] as const;
      statements.push({
        sql: `UPDATE consent_item_history SET ${retain.map((column) => `${column}=?`).join(',')}
        WHERE tenant_id=? AND user_id=? AND statement_id=? AND (retain_until IS NULL OR retain_until<?) AND ${active}`,
        params: [
          ...retain.map((column) => input.after[column]),
          input.owner.tenantId,
          input.owner.userId,
          input.owner.statementId,
          input.after.retain_until,
          ...token,
        ],
      });
    }
    const historyValues = STATEMENT_CONSENT_HISTORY_COLUMNS.map(
      (column) => input.history?.[column]
    );
    statements.push({
      sql: `INSERT INTO consent_item_history (${STATEMENT_CONSENT_HISTORY_COLUMNS.join(',')}) SELECT ${historyValues.map(() => '?').join(',')} WHERE ${active}`,
      params: [...historyValues, ...token],
    });
  }
  statements.push({
    sql: `UPDATE statement_consent_operations SET status=CASE WHEN admitted=1 THEN 'applied' ELSE 'rejected' END,is_terminal=1 WHERE tenant_id=? AND operation_id=? AND attempt_id=? AND status='executing'`,
    params: token,
  });
  return { payloadHash, statements };
}

function invalidReceipt(): never {
  throw new Error('statement_consent_receipt_invalid');
}

/** PostgreSQL int8 defaults to a decimal string. Never cast a DB row to a number-shaped type. */
function receiptInteger(value: unknown): number {
  let number: number;
  if (typeof value === 'number') {
    number = value;
  } else if (typeof value === 'string' && value.length <= 16 && /^(0|[1-9]\d*)$/.test(value)) {
    number = Number(value);
  } else {
    return invalidReceipt();
  }
  if (!Number.isSafeInteger(number) || number < 0 || Object.is(number, -0)) return invalidReceipt();
  return number;
}

function receiptText(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 512 ||
    value.includes('\0')
  ) {
    return invalidReceipt();
  }
  return value;
}

function receiptObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function decodeOperationRow(value: unknown): OperationRow {
  if (!receiptObject(value)) return invalidReceipt();
  const status = value.status;
  const action = value.action;
  if (status !== 'executing' && status !== 'applied' && status !== 'rejected')
    return invalidReceipt();
  if (action !== 'grant' && action !== 'deny' && action !== 'withdraw') return invalidReceipt();
  const terminal = receiptInteger(value.is_terminal);
  const noop = receiptInteger(value.is_noop);
  if (terminal > 1 || noop > 1 || (status === 'executing' ? terminal !== 0 : terminal !== 1)) {
    return invalidReceipt();
  }
  const operationId = receiptText(value.operation_id);
  const payloadHash = receiptText(value.payload_sha256);
  if (!/^[a-f0-9]{64}$/.test(operationId) || !/^[a-f0-9]{64}$/.test(payloadHash))
    return invalidReceipt();
  return {
    tenant_id: receiptText(value.tenant_id),
    operation_id: operationId,
    payload_sha256: payloadHash,
    status,
    is_terminal: terminal,
    is_noop: noop,
    expected_revision: receiptInteger(value.expected_revision),
    expected_withdrawal_generation: receiptInteger(value.expected_withdrawal_generation),
    action,
    physical_id: receiptText(value.physical_id),
    restore_epoch: receiptText(value.restore_epoch),
  };
}

function receiptAdd(value: number, increment: 0 | 1): number {
  if (increment === 1 && value === MAX_SAFE) return invalidReceipt();
  const sum = value + increment;
  if (!Number.isSafeInteger(sum) || sum < 0) return invalidReceipt();
  return sum;
}

function result(
  value: unknown,
  hash: string,
  input: StatementConsentTransition
): StatementConsentOperationResult {
  const row = decodeOperationRow(value);
  if (row.is_terminal !== 1 || row.status === 'executing')
    throw new Error('statement_consent_result_unknown');
  const applied = row.status === 'applied';
  const changed = applied && row.is_noop !== 1;
  const revision = receiptAdd(row.expected_revision, changed ? 1 : 0);
  const withdrawalGeneration = receiptAdd(
    row.expected_withdrawal_generation,
    changed && row.action !== 'grant' ? 1 : 0
  );
  if (
    row.tenant_id !== input.owner.tenantId ||
    row.operation_id !== input.operationId ||
    row.payload_sha256 !== hash ||
    row.physical_id !== input.owner.physicalId ||
    row.restore_epoch !== input.owner.restoreEpoch ||
    row.expected_revision !== input.expected.revision ||
    row.expected_withdrawal_generation !== input.expected.withdrawalGeneration ||
    row.action !== input.action ||
    row.is_noop !== (input.noop ? 1 : 0)
  ) {
    throw new Error('statement_consent_operation_conflict');
  }
  if (!applied) return { outcome: 'rejected' };
  return {
    outcome: row.is_noop === 1 ? 'noop' : 'applied',
    revision,
    withdrawalGeneration,
  };
}

export async function applyStatementConsentTransition(
  capability: StatementConsentAtomicCapability,
  input: StatementConsentTransition
): Promise<StatementConsentOperationResult> {
  const plan = await prepareStatementConsentTransition(capability, input);
  const read = () =>
    capability.readOperation(
      `SELECT tenant_id,operation_id,payload_sha256,status,is_terminal,is_noop,expected_revision,expected_withdrawal_generation,action,physical_id,restore_epoch
     FROM statement_consent_operations WHERE tenant_id=? AND operation_id=?`,
      [input.owner.tenantId, input.operationId]
    );
  const existing = await read();
  if (existing !== null) return result(existing, plan.payloadHash, input);
  try {
    await capability.executeStatementConsentBatch(plan.statements);
  } catch (error) {
    // Batch may have committed before transport failed. Only a primary receipt can recover it.
    const recovered = await read();
    if (recovered !== null) return result(recovered, plan.payloadHash, input);
    throw error;
  }
  const committed = await read();
  if (committed === null) throw new Error('statement_consent_result_unknown');
  return result(committed, plan.payloadHash, input);
}
