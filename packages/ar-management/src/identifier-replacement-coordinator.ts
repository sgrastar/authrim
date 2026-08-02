import type { D1Database, D1DatabaseSession } from '@cloudflare/workers-types';
import type { DatabaseAdapter } from '@authrim/ar-lib-core';

interface OperationRow {
  operation_id: string;
  tenant_id: string;
  account_id: string;
  state:
    | 'directory_pending'
    | 'authoritative_switch_pending'
    | 'authoritative_switched'
    | 'revocation_pending'
    | 'completed'
    | 'blocked_forward_repair'
    | 'canceled';
  initiating_session_ref: string | null;
}

interface HistoryRow {
  old_value_json: string | null;
  new_value_json: string | null;
}

interface ProjectionRow {
  identifier_side: 'old' | 'new';
  hmac_key_generation: number;
  normalization_version: number;
  virtual_bucket: number;
  blind_digest: string;
}

interface LookupIdentifierRow {
  route_schema_version: number;
  account_route_generation: number;
  required_binding_route_generation: number;
  residency_policy_id: string;
  route_projection_json: string;
  tenant_lifecycle_state: string;
  runtime_route_status: string;
  lifecycle_state: string;
}

interface ReservationRow {
  account_id: string;
  operation_id: string;
  reservation_state: string;
}

interface ReplacementGateRow {
  tenant_id: string;
  account_id: string;
  index_kind: string;
  normalization_version: number;
  hmac_key_generation: number;
  old_virtual_bucket: number;
  old_blind_digest: string;
  new_virtual_bucket: number;
  new_blind_digest: string;
  gate_state: string;
}

const PERMANENT_FAILURES = new Set([
  'identifier_replacement_projection_invalid',
  'identifier_replacement_history_erased',
  'identifier_replacement_history_missing',
  'identifier_replacement_old_value_invalid',
  'identifier_replacement_new_value_invalid',
  'identifier_replacement_old_route_invalid',
  'identifier_replacement_reservation_conflict',
  'identifier_replacement_gate_mismatch',
  'identifier_replacement_pending_route_mismatch',
  'identifier_replacement_authoritative_conflict',
  'identifier_replacement_directory_verification_failed',
  'identifier_replacement_authoritative_verification_failed',
  'identifier_replacement_release_verification_failed',
  'identifier_replacement_gate_completion_failed',
  'identifier_replacement_completion_conflict',
]);

export function isPermanentIdentifierReplacementFailure(error: unknown): boolean {
  return error instanceof Error && PERMANENT_FAILURES.has(error.message);
}

export interface IdentifierReplacementCoordinatorDependencies {
  pii: DatabaseAdapter;
  lookupForBucket(virtualBucket: number): Promise<D1Database>;
  revokeCredentials(input: {
    tenantId: string;
    accountId: string;
    initiatingSessionRef: string | null;
  }): Promise<void>;
  enqueueOldIdentifierNotification?(input: {
    operationId: string;
    tenantId: string;
    accountId: string;
    oldValue: string;
  }): Promise<void>;
  now?: () => number;
}

function primary(database: D1Database): D1DatabaseSession {
  if (typeof database.withSession !== 'function') {
    throw new Error('identifier_replacement_sessions_api_required');
  }
  return database.withSession('first-primary');
}

function parseValue(value: string | null, field: 'old' | 'new'): string {
  if (!value) throw new Error('identifier_replacement_history_erased');
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== 'string' || parsed.length < 3) throw new Error('invalid');
    return parsed;
  } catch {
    throw new Error(`identifier_replacement_${field}_value_invalid`);
  }
}

function pairProjections(rows: ProjectionRow[]): Array<{
  old: ProjectionRow;
  next: ProjectionRow;
}> {
  const oldRows = rows.filter((row) => row.identifier_side === 'old');
  const nextRows = rows.filter((row) => row.identifier_side === 'new');
  if (oldRows.length < 1 || oldRows.length > 2 || oldRows.length !== nextRows.length) {
    throw new Error('identifier_replacement_projection_invalid');
  }
  return oldRows.map((old) => {
    const next = nextRows.find(
      (candidate) => candidate.hmac_key_generation === old.hmac_key_generation
    );
    if (!next || next.normalization_version !== old.normalization_version) {
      throw new Error('identifier_replacement_projection_invalid');
    }
    return { old, next };
  });
}

export class IdentifierReplacementCoordinator {
  private readonly now: () => number;

  constructor(private readonly dependencies: IdentifierReplacementCoordinatorDependencies) {
    this.now = dependencies.now ?? (() => Math.floor(Date.now() / 1000));
  }

  async resume(input: {
    operationId: string;
    tenantId: string;
    accountId: string;
  }): Promise<{ state: OperationRow['state'] }> {
    let operation = await this.loadOperation(input);
    if (operation.state === 'completed' || operation.state === 'canceled') {
      return { state: operation.state };
    }
    if (operation.state === 'blocked_forward_repair') {
      throw new Error('identifier_replacement_blocked');
    }
    const history = await this.loadHistory(operation.operation_id);
    const oldValue = parseValue(history.old_value_json, 'old');
    const newValue = parseValue(history.new_value_json, 'new');
    const pairs = pairProjections(await this.loadProjections(operation.operation_id));

    if (operation.state === 'directory_pending') {
      await this.publishPending(operation, pairs);
      await this.updateOperationState(
        operation,
        'directory_pending',
        'authoritative_switch_pending'
      );
      operation = { ...operation, state: 'authoritative_switch_pending' };
    }

    if (operation.state === 'authoritative_switch_pending') {
      await this.switchAuthoritativeValue(operation, oldValue, newValue);
      operation = { ...operation, state: 'authoritative_switched' };
    }

    if (operation.state === 'authoritative_switched') {
      await this.convergeDirectory(operation, pairs);
      await this.verifyAuthoritativeValue(operation, newValue);
      await this.updateOperationState(operation, 'authoritative_switched', 'revocation_pending');
      operation = { ...operation, state: 'revocation_pending' };
    }

    if (operation.state === 'revocation_pending') {
      await this.dependencies.revokeCredentials({
        tenantId: operation.tenant_id,
        accountId: operation.account_id,
        initiatingSessionRef: operation.initiating_session_ref,
      });
      await this.dependencies.enqueueOldIdentifierNotification?.({
        operationId: operation.operation_id,
        tenantId: operation.tenant_id,
        accountId: operation.account_id,
        oldValue,
      });
      await this.complete(operation, pairs);
      operation = { ...operation, state: 'completed' };
    }

    return { state: operation.state };
  }

  private async loadOperation(input: {
    operationId: string;
    tenantId: string;
    accountId: string;
  }): Promise<OperationRow> {
    const row = await this.dependencies.pii.queryOne<OperationRow>(
      `SELECT operation_id, tenant_id, account_id, state, initiating_session_ref
         FROM identity_identifier_replacement_operations
        WHERE operation_id = ? AND tenant_id = ? AND account_id = ?`,
      [input.operationId, input.tenantId, input.accountId],
      { consistencyClass: 'primary_required' }
    );
    if (!row) throw new Error('identifier_replacement_not_found');
    return row;
  }

  private async loadHistory(operationId: string): Promise<HistoryRow> {
    const row = await this.dependencies.pii.queryOne<HistoryRow>(
      `SELECT old_value_json, new_value_json
         FROM identity_identifier_replacement_history
        WHERE operation_id = ?`,
      [operationId],
      { consistencyClass: 'primary_required' }
    );
    if (!row) throw new Error('identifier_replacement_history_missing');
    return row;
  }

  private async loadProjections(operationId: string): Promise<ProjectionRow[]> {
    return this.dependencies.pii.query<ProjectionRow>(
      `SELECT identifier_side, hmac_key_generation, normalization_version,
              virtual_bucket, blind_digest
         FROM identity_identifier_replacement_projections
        WHERE operation_id = ?
        ORDER BY identifier_side, hmac_key_generation DESC`,
      [operationId],
      { consistencyClass: 'primary_required' }
    );
  }

  private async publishPending(
    operation: OperationRow,
    pairs: Array<{ old: ProjectionRow; next: ProjectionRow }>
  ): Promise<void> {
    const now = this.now();
    for (const pair of pairs) {
      const oldLookup = primary(await this.dependencies.lookupForBucket(pair.old.virtual_bucket));
      const oldRow = await oldLookup
        .prepare(
          `SELECT route_schema_version, account_route_generation,
                  required_binding_route_generation, residency_policy_id,
                  route_projection_json, tenant_lifecycle_state,
                  runtime_route_status, lifecycle_state
             FROM lookup_identifiers
            WHERE virtual_bucket = ? AND index_kind = 'email_exact'
              AND normalization_version = ? AND hmac_key_generation = ?
              AND identifier_blind_digest = ? AND tenant_id = ? AND account_id = ?`
        )
        .bind(
          pair.old.virtual_bucket,
          pair.old.normalization_version,
          pair.old.hmac_key_generation,
          pair.old.blind_digest,
          operation.tenant_id,
          operation.account_id
        )
        .first<LookupIdentifierRow>();
      if (!oldRow || oldRow.lifecycle_state !== 'active') {
        throw new Error('identifier_replacement_old_route_invalid');
      }
      const nextLookup = primary(await this.dependencies.lookupForBucket(pair.next.virtual_bucket));
      await nextLookup
        .prepare(
          `INSERT INTO lookup_identifier_reservations (
             virtual_bucket, tenant_id, index_kind, normalization_version,
             hmac_key_generation, identifier_blind_digest, account_id,
             reservation_state, operation_id, lease_expires_at, created_at, updated_at
           ) VALUES (?, ?, 'email_exact', ?, ?, ?, ?, 'reserved', ?, ?, ?, ?)
           ON CONFLICT (
             virtual_bucket, tenant_id, index_kind, normalization_version,
             hmac_key_generation, identifier_blind_digest
           ) DO UPDATE SET
             account_id = excluded.account_id,
             reservation_state = 'reserved',
             operation_id = excluded.operation_id,
             lease_expires_at = excluded.lease_expires_at,
             committed_at = NULL,
             released_at = NULL,
             created_at = excluded.created_at,
             updated_at = excluded.updated_at
           WHERE lookup_identifier_reservations.reservation_state = 'released'
              OR (lookup_identifier_reservations.reservation_state = 'reserved'
                  AND lookup_identifier_reservations.lease_expires_at <= excluded.created_at)`
        )
        .bind(
          pair.next.virtual_bucket,
          operation.tenant_id,
          pair.next.normalization_version,
          pair.next.hmac_key_generation,
          pair.next.blind_digest,
          operation.account_id,
          operation.operation_id,
          now + 2 * 60 * 60,
          now,
          now
        )
        .run();
      const reservation = await nextLookup
        .prepare(
          `SELECT account_id, operation_id, reservation_state
             FROM lookup_identifier_reservations
            WHERE virtual_bucket = ? AND tenant_id = ? AND index_kind = 'email_exact'
              AND normalization_version = ? AND hmac_key_generation = ?
              AND identifier_blind_digest = ?`
        )
        .bind(
          pair.next.virtual_bucket,
          operation.tenant_id,
          pair.next.normalization_version,
          pair.next.hmac_key_generation,
          pair.next.blind_digest
        )
        .first<ReservationRow>();
      if (
        !reservation ||
        reservation.account_id !== operation.account_id ||
        reservation.operation_id !== operation.operation_id ||
        !['reserved', 'committed'].includes(reservation.reservation_state)
      ) {
        throw new Error('identifier_replacement_reservation_conflict');
      }
      await nextLookup.batch([
        nextLookup
          .prepare(
            `INSERT OR IGNORE INTO lookup_identifier_replacements (
               replacement_id, tenant_id, account_id, index_kind, normalization_version,
               hmac_key_generation, old_virtual_bucket, old_blind_digest,
               new_virtual_bucket, new_blind_digest, gate_state, created_at, updated_at
             ) VALUES (?, ?, ?, 'email_exact', ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
          )
          .bind(
            operation.operation_id,
            operation.tenant_id,
            operation.account_id,
            pair.next.normalization_version,
            pair.next.hmac_key_generation,
            pair.old.virtual_bucket,
            pair.old.blind_digest,
            pair.next.virtual_bucket,
            pair.next.blind_digest,
            now,
            now
          ),
        nextLookup
          .prepare(
            `INSERT OR IGNORE INTO lookup_identifiers (
               virtual_bucket, index_kind, normalization_version, hmac_key_generation,
               identifier_blind_digest, tenant_id, account_id, route_schema_version,
               account_route_generation, required_binding_route_generation, residency_policy_id,
               route_projection_json, tenant_lifecycle_state, runtime_route_status,
               lifecycle_state, created_at, updated_at
             ) VALUES (?, 'email_exact', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
          )
          .bind(
            pair.next.virtual_bucket,
            pair.next.normalization_version,
            pair.next.hmac_key_generation,
            pair.next.blind_digest,
            operation.tenant_id,
            operation.account_id,
            oldRow.route_schema_version,
            oldRow.account_route_generation,
            oldRow.required_binding_route_generation,
            oldRow.residency_policy_id,
            oldRow.route_projection_json,
            oldRow.tenant_lifecycle_state,
            oldRow.runtime_route_status,
            now,
            now
          ),
      ]);
      const [gate, pending] = await Promise.all([
        nextLookup
          .prepare(
            `SELECT tenant_id, account_id, index_kind, normalization_version,
                    hmac_key_generation, old_virtual_bucket, old_blind_digest,
                    new_virtual_bucket, new_blind_digest, gate_state
               FROM lookup_identifier_replacements
              WHERE replacement_id = ? AND hmac_key_generation = ?`
          )
          .bind(operation.operation_id, pair.next.hmac_key_generation)
          .first<ReplacementGateRow>(),
        nextLookup
          .prepare(
            `SELECT route_schema_version, account_route_generation,
                    required_binding_route_generation, residency_policy_id,
                    route_projection_json, tenant_lifecycle_state,
                    runtime_route_status, lifecycle_state
               FROM lookup_identifiers
              WHERE virtual_bucket = ? AND index_kind = 'email_exact'
                AND normalization_version = ? AND hmac_key_generation = ?
                AND identifier_blind_digest = ? AND tenant_id = ? AND account_id = ?`
          )
          .bind(
            pair.next.virtual_bucket,
            pair.next.normalization_version,
            pair.next.hmac_key_generation,
            pair.next.blind_digest,
            operation.tenant_id,
            operation.account_id
          )
          .first<LookupIdentifierRow>(),
      ]);
      if (
        !gate ||
        gate.tenant_id !== operation.tenant_id ||
        gate.account_id !== operation.account_id ||
        gate.index_kind !== 'email_exact' ||
        Number(gate.normalization_version) !== pair.next.normalization_version ||
        Number(gate.hmac_key_generation) !== pair.next.hmac_key_generation ||
        Number(gate.old_virtual_bucket) !== pair.old.virtual_bucket ||
        gate.old_blind_digest !== pair.old.blind_digest ||
        Number(gate.new_virtual_bucket) !== pair.next.virtual_bucket ||
        gate.new_blind_digest !== pair.next.blind_digest ||
        !['pending', 'authoritative_verified', 'completed'].includes(gate.gate_state)
      ) {
        throw new Error('identifier_replacement_gate_mismatch');
      }
      if (
        !pending ||
        Number(pending.route_schema_version) !== Number(oldRow.route_schema_version) ||
        Number(pending.account_route_generation) !== Number(oldRow.account_route_generation) ||
        Number(pending.required_binding_route_generation) !==
          Number(oldRow.required_binding_route_generation) ||
        pending.residency_policy_id !== oldRow.residency_policy_id ||
        pending.route_projection_json !== oldRow.route_projection_json ||
        pending.tenant_lifecycle_state !== oldRow.tenant_lifecycle_state ||
        pending.runtime_route_status !== oldRow.runtime_route_status ||
        !['pending', 'active'].includes(pending.lifecycle_state)
      ) {
        throw new Error('identifier_replacement_pending_route_mismatch');
      }
    }
    await this.dependencies.pii.execute(
      `UPDATE identity_identifier_replacement_projections
          SET projection_state = CASE WHEN identifier_side = 'new' THEN 'pending' ELSE projection_state END,
              updated_at = ?
        WHERE operation_id = ?`,
      [now, operation.operation_id]
    );
  }

  private async switchAuthoritativeValue(
    operation: OperationRow,
    oldValue: string,
    newValue: string
  ): Promise<void> {
    const now = this.now();
    const results = await this.dependencies.pii.batch([
      {
        sql: `UPDATE identity_identifier_replacement_operations
                 SET state = 'authoritative_switched', authoritative_switched_at = ?, updated_at = ?
               WHERE operation_id = ? AND tenant_id = ? AND account_id = ?
                 AND state = 'authoritative_switch_pending'
                 AND EXISTS (
                   SELECT 1 FROM identity_sensitive_values value
                    WHERE value.tenant_id = ? AND value.owner_type = 'runtime_user'
                      AND value.owner_id = ? AND value.value_key = 'email'
                      AND value.lifecycle_state = 'active' AND value.value_json = ?
                 )`,
        params: [
          now,
          now,
          operation.operation_id,
          operation.tenant_id,
          operation.account_id,
          operation.tenant_id,
          operation.account_id,
          JSON.stringify(oldValue),
        ],
      },
      {
        sql: `UPDATE identity_sensitive_values
                 SET value_json = ?, value_hash = NULL, updated_at = ?
               WHERE tenant_id = ? AND owner_type = 'runtime_user' AND owner_id = ?
                 AND value_key = 'email' AND lifecycle_state = 'active' AND value_json = ?
                 AND EXISTS (
                   SELECT 1 FROM identity_identifier_replacement_operations operation
                    WHERE operation.operation_id = ? AND operation.state = 'authoritative_switched'
                 )`,
        params: [
          JSON.stringify(newValue),
          now,
          operation.tenant_id,
          operation.account_id,
          JSON.stringify(oldValue),
          operation.operation_id,
        ],
      },
    ]);
    if (results[0]?.rowsAffected === 1 && results[1]?.rowsAffected === 1) return;
    const reflected = await this.dependencies.pii.queryOne<{ state: string; value_json: string }>(
      `SELECT operation.state, value.value_json
         FROM identity_identifier_replacement_operations operation
         JOIN identity_sensitive_values value
           ON value.tenant_id = operation.tenant_id AND value.owner_id = operation.account_id
          AND value.owner_type = 'runtime_user' AND value.value_key = 'email'
          AND value.lifecycle_state = 'active'
        WHERE operation.operation_id = ?`,
      [operation.operation_id],
      { consistencyClass: 'primary_required' }
    );
    if (
      reflected?.state !== 'authoritative_switched' ||
      reflected.value_json !== JSON.stringify(newValue)
    ) {
      throw new Error('identifier_replacement_authoritative_conflict');
    }
  }

  private async convergeDirectory(
    operation: OperationRow,
    pairs: Array<{ old: ProjectionRow; next: ProjectionRow }>
  ): Promise<void> {
    const now = this.now();
    for (const pair of pairs) {
      const nextLookup = primary(await this.dependencies.lookupForBucket(pair.next.virtual_bucket));
      await nextLookup.batch([
        nextLookup
          .prepare(
            `UPDATE lookup_identifiers
                SET lifecycle_state = 'active', disabled_at = NULL, updated_at = ?
              WHERE virtual_bucket = ? AND index_kind = 'email_exact'
                AND normalization_version = ? AND hmac_key_generation = ?
                AND identifier_blind_digest = ? AND tenant_id = ? AND account_id = ?
                AND tenant_lifecycle_state = 'active' AND runtime_route_status = 'active'
                AND lifecycle_state IN ('pending', 'active')`
          )
          .bind(
            now,
            pair.next.virtual_bucket,
            pair.next.normalization_version,
            pair.next.hmac_key_generation,
            pair.next.blind_digest,
            operation.tenant_id,
            operation.account_id
          ),
        nextLookup
          .prepare(
            `UPDATE lookup_identifier_reservations
                SET reservation_state = 'committed', committed_at = COALESCE(committed_at, ?),
                    lease_expires_at = NULL, updated_at = ?
              WHERE virtual_bucket = ? AND tenant_id = ? AND index_kind = 'email_exact'
                AND normalization_version = ? AND hmac_key_generation = ?
                AND identifier_blind_digest = ? AND account_id = ? AND operation_id = ?
                AND reservation_state IN ('reserved', 'committed')`
          )
          .bind(
            now,
            now,
            pair.next.virtual_bucket,
            operation.tenant_id,
            pair.next.normalization_version,
            pair.next.hmac_key_generation,
            pair.next.blind_digest,
            operation.account_id,
            operation.operation_id
          ),
        nextLookup
          .prepare(
            `UPDATE lookup_identifier_replacements
                SET gate_state = 'authoritative_verified', authoritative_checked_at = ?, updated_at = ?
              WHERE replacement_id = ? AND hmac_key_generation = ?
                AND tenant_id = ? AND account_id = ? AND gate_state IN ('pending', 'authoritative_verified')`
          )
          .bind(
            now,
            now,
            operation.operation_id,
            pair.next.hmac_key_generation,
            operation.tenant_id,
            operation.account_id
          ),
      ]);
      const oldLookup = primary(await this.dependencies.lookupForBucket(pair.old.virtual_bucket));
      await oldLookup.batch([
        oldLookup
          .prepare(
            `UPDATE lookup_identifiers
                SET lifecycle_state = 'disabled', disabled_at = COALESCE(disabled_at, ?), updated_at = ?
              WHERE virtual_bucket = ? AND index_kind = 'email_exact'
                AND normalization_version = ? AND hmac_key_generation = ?
                AND identifier_blind_digest = ? AND tenant_id = ? AND account_id = ?
                AND lifecycle_state IN ('active', 'disabled')`
          )
          .bind(
            now,
            now,
            pair.old.virtual_bucket,
            pair.old.normalization_version,
            pair.old.hmac_key_generation,
            pair.old.blind_digest,
            operation.tenant_id,
            operation.account_id
          ),
        oldLookup
          .prepare(
            `UPDATE lookup_identifier_reservations
                SET reservation_state = 'releasing', lease_expires_at = NULL, updated_at = ?
              WHERE virtual_bucket = ? AND tenant_id = ? AND index_kind = 'email_exact'
                AND normalization_version = ? AND hmac_key_generation = ?
                AND identifier_blind_digest = ? AND account_id = ?
                AND reservation_state IN ('reserved', 'committed', 'releasing')`
          )
          .bind(
            now,
            pair.old.virtual_bucket,
            operation.tenant_id,
            pair.old.normalization_version,
            pair.old.hmac_key_generation,
            pair.old.blind_digest,
            operation.account_id
          ),
      ]);
      const reflectedNew = await nextLookup
        .prepare(
          `SELECT lifecycle_state FROM lookup_identifiers
            WHERE virtual_bucket = ? AND index_kind = 'email_exact'
              AND normalization_version = ? AND hmac_key_generation = ?
              AND identifier_blind_digest = ? AND tenant_id = ? AND account_id = ?`
        )
        .bind(
          pair.next.virtual_bucket,
          pair.next.normalization_version,
          pair.next.hmac_key_generation,
          pair.next.blind_digest,
          operation.tenant_id,
          operation.account_id
        )
        .first<{ lifecycle_state: string }>();
      const reflectedOld = await oldLookup
        .prepare(
          `SELECT lifecycle_state FROM lookup_identifiers
            WHERE virtual_bucket = ? AND index_kind = 'email_exact'
              AND normalization_version = ? AND hmac_key_generation = ?
              AND identifier_blind_digest = ? AND tenant_id = ? AND account_id = ?`
        )
        .bind(
          pair.old.virtual_bucket,
          pair.old.normalization_version,
          pair.old.hmac_key_generation,
          pair.old.blind_digest,
          operation.tenant_id,
          operation.account_id
        )
        .first<{ lifecycle_state: string }>();
      if (
        reflectedNew?.lifecycle_state !== 'active' ||
        reflectedOld?.lifecycle_state !== 'disabled'
      ) {
        throw new Error('identifier_replacement_directory_verification_failed');
      }
    }
    await this.dependencies.pii.execute(
      `UPDATE identity_identifier_replacement_projections
          SET projection_state = CASE identifier_side WHEN 'new' THEN 'active' ELSE 'disabled' END,
              updated_at = ?
        WHERE operation_id = ?`,
      [now, operation.operation_id]
    );
  }

  private async verifyAuthoritativeValue(operation: OperationRow, newValue: string): Promise<void> {
    const reflected = await this.dependencies.pii.queryOne<{ value_json: string }>(
      `SELECT value_json FROM identity_sensitive_values
        WHERE tenant_id = ? AND owner_type = 'runtime_user' AND owner_id = ?
          AND value_key = 'email' AND lifecycle_state = 'active'`,
      [operation.tenant_id, operation.account_id],
      { consistencyClass: 'primary_required' }
    );
    if (reflected?.value_json !== JSON.stringify(newValue)) {
      throw new Error('identifier_replacement_authoritative_verification_failed');
    }
  }

  private async updateOperationState(
    operation: OperationRow,
    from: OperationRow['state'],
    to: OperationRow['state']
  ): Promise<void> {
    const result = await this.dependencies.pii.execute(
      `UPDATE identity_identifier_replacement_operations
          SET state = ?, updated_at = ?
        WHERE operation_id = ? AND tenant_id = ? AND account_id = ? AND state = ?`,
      [to, this.now(), operation.operation_id, operation.tenant_id, operation.account_id, from]
    );
    if (result.rowsAffected === 1) return;
    const reflected = await this.loadOperation({
      operationId: operation.operation_id,
      tenantId: operation.tenant_id,
      accountId: operation.account_id,
    });
    if (reflected.state !== to) throw new Error('identifier_replacement_state_conflict');
  }

  private async complete(
    operation: OperationRow,
    pairs: Array<{ old: ProjectionRow; next: ProjectionRow }>
  ): Promise<void> {
    const now = this.now();
    for (const pair of pairs) {
      const nextLookup = primary(await this.dependencies.lookupForBucket(pair.next.virtual_bucket));
      await nextLookup
        .prepare(
          `UPDATE lookup_identifier_replacements
              SET gate_state = 'completed', completed_at = COALESCE(completed_at, ?), updated_at = ?
            WHERE replacement_id = ? AND hmac_key_generation = ?
              AND gate_state IN ('authoritative_verified', 'completed')`
        )
        .bind(now, now, operation.operation_id, pair.next.hmac_key_generation)
        .run();
      const completedGate = await nextLookup
        .prepare(
          `SELECT gate_state FROM lookup_identifier_replacements
            WHERE replacement_id = ? AND hmac_key_generation = ?
              AND tenant_id = ? AND account_id = ?`
        )
        .bind(
          operation.operation_id,
          pair.next.hmac_key_generation,
          operation.tenant_id,
          operation.account_id
        )
        .first<{ gate_state: string }>();
      if (completedGate?.gate_state !== 'completed') {
        throw new Error('identifier_replacement_gate_completion_failed');
      }
      const oldLookup = primary(await this.dependencies.lookupForBucket(pair.old.virtual_bucket));
      await oldLookup
        .prepare(
          `UPDATE lookup_identifier_reservations
              SET reservation_state = 'released', released_at = COALESCE(released_at, ?),
                  lease_expires_at = NULL, updated_at = ?
            WHERE virtual_bucket = ? AND tenant_id = ? AND index_kind = 'email_exact'
              AND normalization_version = ? AND hmac_key_generation = ?
              AND identifier_blind_digest = ? AND account_id = ?
              AND reservation_state IN ('releasing', 'released')`
        )
        .bind(
          now,
          now,
          pair.old.virtual_bucket,
          operation.tenant_id,
          pair.old.normalization_version,
          pair.old.hmac_key_generation,
          pair.old.blind_digest,
          operation.account_id
        )
        .run();
      const released = await oldLookup
        .prepare(
          `SELECT reservation_state FROM lookup_identifier_reservations
            WHERE virtual_bucket = ? AND tenant_id = ? AND index_kind = 'email_exact'
              AND normalization_version = ? AND hmac_key_generation = ?
              AND identifier_blind_digest = ? AND account_id = ?`
        )
        .bind(
          pair.old.virtual_bucket,
          operation.tenant_id,
          pair.old.normalization_version,
          pair.old.hmac_key_generation,
          pair.old.blind_digest,
          operation.account_id
        )
        .first<{ reservation_state: string }>();
      if (released?.reservation_state !== 'released') {
        throw new Error('identifier_replacement_release_verification_failed');
      }
    }
    const results = await this.dependencies.pii.batch([
      {
        sql: `UPDATE identity_identifier_replacement_operations
                 SET state = 'completed', completed_at = COALESCE(completed_at, ?),
                     error_code = NULL, updated_at = ?
               WHERE operation_id = ? AND state IN ('revocation_pending', 'completed')`,
        params: [now, now, operation.operation_id],
      },
      {
        sql: `UPDATE identity_identifier_replacement_outbox
                 SET status = 'succeeded', completed_at = COALESCE(completed_at, ?),
                     lease_owner = NULL, lease_expires_at = NULL, next_attempt_at = NULL,
                     error_code = NULL, updated_at = ?
               WHERE operation_id = ? AND status IN ('pending', 'leased', 'retry', 'succeeded')`,
        params: [now, now, operation.operation_id],
      },
      {
        sql: `UPDATE identity_identifier_replacement_projections
                 SET projection_state = CASE identifier_side
                   WHEN 'old' THEN 'released' ELSE 'active' END,
                     updated_at = ?
               WHERE operation_id = ?`,
        params: [now, operation.operation_id],
      },
    ]);
    if (
      results[0]?.rowsAffected !== 1 ||
      results[1]?.rowsAffected !== 1 ||
      results[2]?.rowsAffected !== pairs.length * 2
    ) {
      throw new Error('identifier_replacement_completion_conflict');
    }
  }
}
