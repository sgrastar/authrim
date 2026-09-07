import {
  isValidPersistedUserId,
  validateAccountDirectoryPublication,
  type AccountDirectoryPublication,
  type DatabaseAdapter,
} from '@authrim/ar-lib-core';

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u;
const REQUEST_HASH = /^[a-f0-9]{64}$/u;

export type AccountCreationOperationStatus =
  | 'preparing'
  | 'reserved'
  | 'writing'
  | 'directory_pending'
  | 'succeeded'
  | 'blocked'
  | 'canceled';

export interface AccountCreationOperation {
  operationId: string;
  tenantId: string;
  actorId: string;
  idempotencyKey: string;
  allocationIdempotencyKey: string;
  requestHash: string;
  userId: string;
  accountId: string;
  status: AccountCreationOperationStatus;
  publication: AccountDirectoryPublication | null;
  lastErrorCode?: string | null;
}

interface AccountCreationOperationRow {
  operation_id: string;
  tenant_id: string;
  actor_id: string;
  idempotency_key: string;
  allocation_idempotency_key: string;
  request_hash: string;
  user_id: string;
  account_id: string;
  status: string;
  publication_json: string | null;
  last_error_code?: string | null;
}

export interface AcquireAccountCreationOperationInput {
  tenantId: string;
  actorId: string;
  idempotencyKey: string;
  requestHash: string;
  candidateOperationId: string;
  candidateUserId: string;
  now: number;
}

function id(value: unknown, code: string): string {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new Error(code);
  return value;
}

function validatedUserId(value: unknown): string {
  if (!isValidPersistedUserId(value)) {
    throw new Error('account_creation_user_id_invalid');
  }
  return value;
}

function validStatus(value: string): value is AccountCreationOperationStatus {
  return [
    'preparing',
    'reserved',
    'writing',
    'directory_pending',
    'succeeded',
    'blocked',
    'canceled',
  ].includes(value);
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function canonicalJson(value: unknown, ancestors: Set<object>): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('account_creation_request_value_invalid');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new Error('account_creation_request_value_invalid');
    ancestors.add(value);
    const encoded = `[${value.map((item) => canonicalJson(item, ancestors)).join(',')}]`;
    ancestors.delete(value);
    return encoded;
  }
  if (typeof value === 'object') {
    if (ancestors.has(value)) throw new Error('account_creation_request_value_invalid');
    ancestors.add(value);
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key], ancestors)}`);
    ancestors.delete(value);
    return `{${entries.join(',')}}`;
  }
  throw new Error('account_creation_request_value_invalid');
}

export async function hashAccountCreationRequest(value: unknown): Promise<string> {
  return sha256(canonicalJson(value, new Set()));
}

async function parseRow(row: AccountCreationOperationRow): Promise<AccountCreationOperation> {
  if (!validStatus(row.status)) throw new Error('account_creation_operation_state_invalid');
  const operationId = id(row.operation_id, 'account_creation_operation_id_invalid');
  const tenantId = id(row.tenant_id, 'account_creation_tenant_id_invalid');
  const actorId = id(row.actor_id, 'account_creation_actor_id_invalid');
  const userId = validatedUserId(row.user_id);
  const accountId = id(row.account_id, 'account_creation_account_id_invalid');
  if (
    row.idempotency_key.length < 8 ||
    row.idempotency_key.length > 128 ||
    // eslint-disable-next-line no-control-regex -- reject all ASCII control bytes in persisted keys
    /[\x00-\x1f\x7f]/u.test(row.idempotency_key) ||
    !/^account-create:[a-f0-9]{64}$/u.test(row.allocation_idempotency_key) ||
    !REQUEST_HASH.test(row.request_hash) ||
    accountId !== `account:${userId}`
  ) {
    throw new Error('account_creation_operation_record_invalid');
  }
  let publication: AccountDirectoryPublication | null = null;
  if (row.publication_json !== null) {
    try {
      publication = await validateAccountDirectoryPublication(
        JSON.parse(row.publication_json) as AccountDirectoryPublication
      );
    } catch {
      throw new Error('account_creation_operation_publication_invalid');
    }
    if (
      publication.operationId !== operationId ||
      publication.tenantId !== tenantId ||
      publication.accountId !== accountId ||
      publication.idempotencyKey !== row.allocation_idempotency_key
    ) {
      throw new Error('account_creation_operation_publication_mismatch');
    }
  }
  return {
    operationId,
    tenantId,
    actorId,
    idempotencyKey: row.idempotency_key,
    allocationIdempotencyKey: id(
      row.allocation_idempotency_key,
      'account_creation_allocation_idempotency_key_invalid'
    ),
    requestHash: row.request_hash,
    userId,
    accountId,
    status: row.status,
    publication,
    lastErrorCode: row.last_error_code ?? null,
  };
}

export class AccountCreationOperationRepository {
  constructor(private readonly adapter: DatabaseAdapter) {}

  private async findRow(
    tenantId: string,
    operationId: string
  ): Promise<AccountCreationOperationRow | null> {
    return this.adapter.queryOne<AccountCreationOperationRow>(
      `SELECT operation_id, tenant_id, actor_id, idempotency_key,
              allocation_idempotency_key, request_hash, user_id, account_id,
              status, publication_json, last_error_code
         FROM account_creation_operations
        WHERE operation_id = ? AND tenant_id = ?`,
      [operationId, tenantId],
      { consistencyClass: 'primary_required' }
    );
  }

  async findForActor(input: {
    tenantId: string;
    actorId: string;
    operationId: string;
  }): Promise<AccountCreationOperation | null> {
    const tenantId = id(input.tenantId, 'account_creation_tenant_id_invalid');
    const actorId = id(input.actorId, 'account_creation_actor_id_invalid');
    const operationId = id(input.operationId, 'account_creation_operation_id_invalid');
    const row = await this.findRow(tenantId, operationId);
    if (!row || row.actor_id !== actorId) return null;
    return parseRow(row);
  }

  async findForPublication(
    value: AccountDirectoryPublication
  ): Promise<AccountCreationOperation | null> {
    const publication = await validateAccountDirectoryPublication(value);
    const row = await this.findRow(publication.tenantId, publication.operationId);
    if (!row) return null;
    const operation = await parseRow(row);
    if (
      !operation.publication ||
      operation.accountId !== publication.accountId ||
      operation.allocationIdempotencyKey !== publication.idempotencyKey ||
      JSON.stringify(operation.publication) !== JSON.stringify(publication)
    ) {
      throw new Error('account_creation_operation_publication_mismatch');
    }
    return operation;
  }

  async recordDirectoryOutcome(input: {
    publication: AccountDirectoryPublication;
    outcome: 'succeeded' | 'blocked';
    now: number;
    errorCode?: string | null;
    lifecycleEventAdapter?: DatabaseAdapter;
  }): Promise<AccountCreationOperation> {
    const publication = await validateAccountDirectoryPublication(input.publication);
    if (
      !Number.isSafeInteger(input.now) ||
      input.now < 1 ||
      (input.errorCode !== undefined &&
        input.errorCode !== null &&
        !/^[a-z0-9][a-z0-9_:-]{0,127}$/u.test(input.errorCode))
    ) {
      throw new Error('account_creation_operation_outcome_invalid');
    }
    const operation = await this.findForPublication(publication);
    if (!operation) throw new Error('account_creation_operation_not_found');
    if (operation.status === input.outcome && input.outcome === 'blocked') return operation;
    if (
      operation.status === 'canceled' ||
      (operation.status === 'succeeded' && input.outcome === 'blocked')
    ) {
      throw new Error('account_creation_operation_outcome_conflict');
    }
    if (input.outcome === 'blocked') {
      return this.transition(
        operation,
        input.outcome,
        input.now,
        input.errorCode ?? 'directory_routing_blocked'
      );
    }

    const eventId = `account-event:${await sha256(
      `${operation.tenantId}\0${operation.operationId}\0account.created`
    )}`;
    const payload = JSON.stringify({
      tenantId: operation.tenantId,
      accountId: operation.accountId,
      userId: operation.userId,
      eventType: 'account.created',
      eventVersion: 1,
    });
    const transition = await this.adapter.execute(
      `UPDATE account_creation_operations
          SET status = 'succeeded', last_error_code = NULL,
              completed_at = COALESCE(completed_at, ?), updated_at = ?
        WHERE operation_id = ? AND tenant_id = ? AND account_id = ?
          AND status IN ('writing', 'directory_pending', 'succeeded')`,
      [input.now, input.now, operation.operationId, operation.tenantId, operation.accountId]
    );
    if (!transition.success) throw new Error('account_creation_operation_transition_failed');
    const row = await this.findRow(operation.tenantId, operation.operationId);
    if (!row) throw new Error('account_creation_operation_transition_failed');
    const reflected = await parseRow(row);
    if (reflected.status !== 'succeeded') {
      throw new Error('account_creation_operation_transition_conflict');
    }
    const lifecycleEventAdapter = input.lifecycleEventAdapter ?? this.adapter;
    const inserted = await lifecycleEventAdapter.execute(
      `INSERT OR IGNORE INTO account_lifecycle_event_outbox (
         event_id, tenant_id, account_id, operation_id, event_type,
         event_version, payload_json, status, attempt_count, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'account.created', 1, ?, 'pending', 0, ?, ?)`,
      [
        eventId,
        operation.tenantId,
        operation.accountId,
        operation.operationId,
        payload,
        input.now,
        input.now,
      ]
    );
    if (!inserted.success) throw new Error('account_creation_completion_event_write_failed');
    const event = await lifecycleEventAdapter.queryOne<{ payload_json: string }>(
      `SELECT payload_json FROM account_lifecycle_event_outbox
        WHERE event_id = ? AND tenant_id = ? AND operation_id = ?`,
      [eventId, operation.tenantId, operation.operationId],
      { consistencyClass: 'primary_required' }
    );
    if (!event || event.payload_json !== payload) {
      throw new Error('account_creation_completion_event_conflict');
    }
    return reflected;
  }

  async blockDirectoryPublicationConflict(input: {
    publication: AccountDirectoryPublication;
    now: number;
    errorCode: string;
  }): Promise<AccountCreationOperation | null> {
    const publication = await validateAccountDirectoryPublication(input.publication);
    const row = await this.findRow(publication.tenantId, publication.operationId);
    if (!row) return null;
    const operation = await parseRow(row);
    if (
      operation.accountId !== publication.accountId ||
      operation.allocationIdempotencyKey !== publication.idempotencyKey
    ) {
      throw new Error('account_creation_operation_identity_mismatch');
    }
    if (operation.status === 'blocked' || operation.status === 'canceled') return operation;
    if (operation.status === 'succeeded') {
      throw new Error('account_creation_operation_outcome_conflict');
    }
    return this.transition(operation, 'blocked', input.now, input.errorCode);
  }

  async blockDirectoryFailureByAccount(input: {
    tenantId: string;
    accountId: string;
    now: number;
    errorCode: string;
  }): Promise<AccountCreationOperation | null> {
    const tenantId = id(input.tenantId, 'account_creation_tenant_id_invalid');
    const accountId = id(input.accountId, 'account_creation_account_id_invalid');
    const row = await this.adapter.queryOne<AccountCreationOperationRow>(
      `SELECT operation_id, tenant_id, actor_id, idempotency_key,
              allocation_idempotency_key, request_hash, user_id, account_id,
              status, publication_json, last_error_code
         FROM account_creation_operations
        WHERE tenant_id = ? AND account_id = ?`,
      [tenantId, accountId]
    );
    if (!row) return null;
    const operation = await parseRow(row);
    if (operation.status === 'blocked' || operation.status === 'canceled') return operation;
    if (operation.status === 'succeeded') {
      throw new Error('account_creation_operation_outcome_conflict');
    }
    return this.transition(operation, 'blocked', input.now, input.errorCode);
  }

  async acquire(input: AcquireAccountCreationOperationInput): Promise<AccountCreationOperation> {
    const tenantId = id(input.tenantId, 'account_creation_tenant_id_invalid');
    const actorId = id(input.actorId, 'account_creation_actor_id_invalid');
    const operationId = id(input.candidateOperationId, 'account_creation_operation_id_invalid');
    const userId = validatedUserId(input.candidateUserId);
    const accountId = id(`account:${userId}`, 'account_creation_account_id_invalid');
    if (
      typeof input.idempotencyKey !== 'string' ||
      input.idempotencyKey.length < 8 ||
      input.idempotencyKey.length > 128 ||
      // eslint-disable-next-line no-control-regex -- reject all ASCII control bytes at the boundary
      /[\x00-\x1f\x7f]/u.test(input.idempotencyKey) ||
      !REQUEST_HASH.test(input.requestHash) ||
      !Number.isSafeInteger(input.now) ||
      input.now < 1
    ) {
      throw new Error('account_creation_operation_input_invalid');
    }
    const allocationIdempotencyKey = `account-create:${await sha256(
      `${tenantId}\0${actorId}\0${input.idempotencyKey}`
    )}`;
    await this.adapter.execute(
      `INSERT OR IGNORE INTO account_creation_operations (
           operation_id, tenant_id, actor_id, idempotency_key,
           allocation_idempotency_key, request_hash, user_id, account_id,
           status, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'preparing', ?, ?)`,
      [
        operationId,
        tenantId,
        actorId,
        input.idempotencyKey,
        allocationIdempotencyKey,
        input.requestHash,
        userId,
        accountId,
        input.now,
        input.now,
      ]
    );
    const row = await this.adapter.queryOne<AccountCreationOperationRow>(
      `SELECT operation_id, tenant_id, actor_id, idempotency_key,
                allocation_idempotency_key, request_hash, user_id, account_id,
                status, publication_json, last_error_code
           FROM account_creation_operations
          WHERE tenant_id = ? AND actor_id = ? AND idempotency_key = ?`,
      [tenantId, actorId, input.idempotencyKey],
      { consistencyClass: 'primary_required' }
    );
    if (!row) throw new Error('account_creation_operation_acquire_failed');
    if (
      row.tenant_id !== tenantId ||
      row.actor_id !== actorId ||
      row.idempotency_key !== input.idempotencyKey ||
      row.request_hash !== input.requestHash ||
      row.allocation_idempotency_key !== allocationIdempotencyKey
    ) {
      throw new Error('account_creation_operation_idempotency_conflict');
    }
    return parseRow(row);
  }

  async recordPublication(
    operation: AccountCreationOperation,
    value: AccountDirectoryPublication,
    now: number
  ): Promise<AccountCreationOperation> {
    const publication = await validateAccountDirectoryPublication(value);
    if (
      publication.operationId !== operation.operationId ||
      publication.tenantId !== operation.tenantId ||
      publication.accountId !== operation.accountId ||
      publication.idempotencyKey !== operation.allocationIdempotencyKey ||
      !Number.isSafeInteger(now) ||
      now < 1
    ) {
      throw new Error('account_creation_operation_publication_mismatch');
    }
    const serialized = JSON.stringify(publication);
    await this.adapter.execute(
      `UPDATE account_creation_operations
          SET publication_json = ?, last_error_code = NULL, updated_at = ?
        WHERE operation_id = ? AND tenant_id = ? AND publication_json IS NULL
          AND status = 'preparing'`,
      [serialized, now, operation.operationId, operation.tenantId]
    );
    const row = await this.findRow(operation.tenantId, operation.operationId);
    if (!row || row.publication_json !== serialized) {
      throw new Error('account_creation_operation_publication_conflict');
    }
    return parseRow(row);
  }

  async recordPreparationFailure(
    operation: AccountCreationOperation,
    errorCode: string,
    now: number
  ): Promise<AccountCreationOperation> {
    if (
      operation.status !== 'preparing' ||
      !/^[a-z0-9][a-z0-9_:-]{0,127}$/u.test(errorCode) ||
      !Number.isSafeInteger(now) ||
      now < 1
    ) {
      throw new Error('account_creation_operation_preparation_failure_invalid');
    }
    await this.adapter.execute(
      `UPDATE account_creation_operations
          SET last_error_code = ?, updated_at = ?
        WHERE operation_id = ? AND tenant_id = ?
          AND status = 'preparing' AND publication_json IS NULL`,
      [errorCode, now, operation.operationId, operation.tenantId]
    );
    const row = await this.findRow(operation.tenantId, operation.operationId);
    if (!row) throw new Error('account_creation_operation_preparation_failure_record_failed');
    return parseRow(row);
  }

  async transition(
    operation: AccountCreationOperation,
    targetStatus: AccountCreationOperationStatus,
    now: number,
    errorCode: string | null = null
  ): Promise<AccountCreationOperation> {
    if (
      !Number.isSafeInteger(now) ||
      now < 1 ||
      (errorCode !== null && !/^[a-z0-9][a-z0-9_:-]{0,127}$/u.test(errorCode))
    ) {
      throw new Error('account_creation_operation_transition_invalid');
    }
    await this.adapter.execute(
      `UPDATE account_creation_operations
          SET status = ?, last_error_code = ?,
              completed_at = CASE WHEN ? = 'succeeded' THEN COALESCE(completed_at, ?) ELSE completed_at END,
              updated_at = ?
        WHERE operation_id = ? AND tenant_id = ? AND status = ?`,
      [
        targetStatus,
        errorCode,
        targetStatus,
        now,
        now,
        operation.operationId,
        operation.tenantId,
        operation.status,
      ]
    );
    const row = await this.findRow(operation.tenantId, operation.operationId);
    if (!row) throw new Error('account_creation_operation_transition_failed');
    const reflected = await parseRow(row);
    const acceptedAdvancement: Partial<
      Record<AccountCreationOperationStatus, readonly AccountCreationOperationStatus[]>
    > = {
      reserved: ['reserved', 'writing', 'directory_pending', 'succeeded'],
      writing: ['writing', 'directory_pending', 'succeeded'],
      directory_pending: ['directory_pending', 'succeeded'],
      succeeded: ['succeeded'],
      blocked: ['blocked'],
      canceled: ['canceled'],
    };
    if (!(acceptedAdvancement[targetStatus] ?? [targetStatus]).includes(reflected.status)) {
      throw new Error('account_creation_operation_transition_conflict');
    }
    return reflected;
  }
}
