import type { Context } from 'hono';
import {
  createAccountAuthContextFromHono,
  getTenantIdFromContext,
  resolveAccountDataContextFromHono,
  type DatabaseAdapter,
  type Env,
} from '@authrim/ar-lib-core';
import { getAdminAuth } from './admin-tenant-access';
import { logSanitizedError, scheduleAdminAuditLog } from './admin-shared';

const SAFE_CODE = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const SAFE_IDEMPOTENCY_KEY = /^[^\u0000-\u001f\u007f]{8,128}$/u;
const MAX_SUPPORT_SUMMARY_LENGTH = 4000;
const MAX_EXTERNAL_REFERENCES = 20;

interface CanonicalAccountRow {
  id: string;
}

interface SupportReference {
  system: string;
  kind: string;
  reference: string;
}

interface SupportContextDocument {
  schema_version: 1;
  summary?: string;
  external_references: SupportReference[];
}

interface SupportContextRow {
  context_json: unknown;
  version: number | string;
  created_by: string;
  updated_by: string;
  created_at: number | string;
  updated_at: number | string;
}

interface LegalHoldRow {
  id: string;
  subject_id: string;
  state: 'active' | 'released' | 'expired';
  reason_code: string;
  case_reference: string | null;
  expires_at: number | string | null;
  version: number | string;
  created_by: string;
  created_at: number | string;
  released_by: string | null;
  released_at: number | string | null;
  release_reason: string | null;
  updated_at: number | string;
}

interface LegalHoldProjectionOutboxRow {
  tenant_id: string;
  hold_id: string;
  account_id: string;
  projection_generation: number | string;
  hold_version: number | string;
  projection_state: 'active' | 'inactive';
  updated_at: number | string;
}

function integer(value: number | string, code: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(code);
  return parsed;
}

function optionalInteger(value: number | string | null, code: string): number | null {
  return value === null ? null : integer(value, code);
}

function nonEmptyBoundedString(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (
    normalized.length < 1 ||
    normalized.length > max ||
    /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    return null;
  }
  return normalized;
}

export function validateAccountSupportContext(value: unknown): SupportContextDocument | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const allowed = new Set(['schema_version', 'summary', 'external_references']);
  if (Object.keys(input).some((key) => !allowed.has(key)) || input.schema_version !== 1) {
    return null;
  }

  let summary: string | undefined;
  if (input.summary !== undefined) {
    summary = nonEmptyBoundedString(input.summary, MAX_SUPPORT_SUMMARY_LENGTH) ?? undefined;
    if (!summary) return null;
  }

  const rawReferences = input.external_references ?? [];
  if (!Array.isArray(rawReferences) || rawReferences.length > MAX_EXTERNAL_REFERENCES) return null;
  const externalReferences: SupportReference[] = [];
  const uniqueReferences = new Set<string>();
  for (const raw of rawReferences) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const reference = raw as Record<string, unknown>;
    if (Object.keys(reference).some((key) => !['system', 'kind', 'reference'].includes(key))) {
      return null;
    }
    const system = nonEmptyBoundedString(reference.system, 64);
    const kind = nonEmptyBoundedString(reference.kind, 64);
    const opaqueReference = nonEmptyBoundedString(reference.reference, 256);
    if (!system || !kind || !opaqueReference || !SAFE_CODE.test(system) || !SAFE_CODE.test(kind)) {
      return null;
    }
    const uniqueKey = `${system}\0${kind}\0${opaqueReference}`;
    if (uniqueReferences.has(uniqueKey)) return null;
    uniqueReferences.add(uniqueKey);
    externalReferences.push({ system, kind, reference: opaqueReference });
  }

  return {
    schema_version: 1,
    ...(summary ? { summary } : {}),
    external_references: externalReferences,
  };
}

function parsedStoredSupportContext(value: unknown): SupportContextDocument {
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      throw new Error('account_support_context_storage_invalid');
    }
  }
  const validated = validateAccountSupportContext(parsed);
  if (!validated) throw new Error('account_support_context_storage_invalid');
  return validated;
}

function supportContextView(row: SupportContextRow | null) {
  if (!row) {
    return {
      context: { schema_version: 1, external_references: [] } satisfies SupportContextDocument,
      version: 0,
      created_by: null,
      updated_by: null,
      created_at: null,
      updated_at: null,
    };
  }
  return {
    context: parsedStoredSupportContext(row.context_json),
    version: integer(row.version, 'account_support_context_storage_invalid'),
    created_by: row.created_by,
    updated_by: row.updated_by,
    created_at: integer(row.created_at, 'account_support_context_storage_invalid'),
    updated_at: integer(row.updated_at, 'account_support_context_storage_invalid'),
  };
}

function legalHoldView(row: LegalHoldRow) {
  return {
    id: row.id,
    subject_type: 'account' as const,
    account_id: row.subject_id,
    state: row.state,
    reason_code: row.reason_code,
    case_reference: row.case_reference,
    expires_at: optionalInteger(row.expires_at, 'account_legal_hold_storage_invalid'),
    version: integer(row.version, 'account_legal_hold_storage_invalid'),
    created_by: row.created_by,
    created_at: integer(row.created_at, 'account_legal_hold_storage_invalid'),
    released_by: row.released_by,
    released_at: optionalInteger(row.released_at, 'account_legal_hold_storage_invalid'),
    release_reason: row.release_reason,
    updated_at: integer(row.updated_at, 'account_legal_hold_storage_invalid'),
  };
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function attemptLegalHoldProjection(
  c: Context<{ Bindings: Env }>,
  adapter: DatabaseAdapter,
  operationId: string
): Promise<void> {
  const control = c.env.CONTROL;
  if (!control?.applyAccountLegalHoldProjection) return;
  const row = await adapter.queryOne<LegalHoldProjectionOutboxRow>(
    `SELECT tenant_id, hold_id, account_id, projection_generation, hold_version,
            projection_state, updated_at
       FROM legal_hold_projection_outbox
      WHERE operation_id = ? AND status <> 'succeeded'`,
    [operationId],
    { consistencyClass: 'primary_required' }
  );
  if (!row) return;
  const now = Date.now();
  try {
    await control.applyAccountLegalHoldProjection({
      tenantId: row.tenant_id,
      accountId: row.account_id,
      holdId: row.hold_id,
      projectionGeneration: integer(
        row.projection_generation,
        'account_legal_hold_projection_outbox_invalid'
      ),
      holdVersion: integer(row.hold_version, 'account_legal_hold_projection_outbox_invalid'),
      projectionState: row.projection_state,
      sourceOperationId: operationId,
      sourceUpdatedAt: integer(row.updated_at, 'account_legal_hold_projection_outbox_invalid'),
    });
    await adapter.execute(
      `UPDATE legal_hold_projection_outbox
          SET status = 'succeeded', completed_at = ?, updated_at = ?,
              lease_owner = NULL, lease_expires_at = NULL, last_error_code = NULL
        WHERE operation_id = ? AND status <> 'succeeded'`,
      [now, now, operationId]
    );
  } catch {
    await adapter.execute(
      `UPDATE legal_hold_projection_outbox
          SET status = 'pending', attempt_count = attempt_count + 1,
              next_attempt_at = ?, updated_at = ?, lease_owner = NULL,
              lease_expires_at = NULL, last_error_code = 'control_projection_failed'
        WHERE operation_id = ? AND status <> 'succeeded'`,
      [now + 60_000, now, operationId]
    );
  }
}

function actorId(c: Context<{ Bindings: Env }>): string | null {
  const auth = getAdminAuth(c);
  return auth?.actorId ?? auth?.userId ?? null;
}

async function accountScope(c: Context<{ Bindings: Env }>): Promise<{
  tenantId: string;
  accountId: string;
  adapter: DatabaseAdapter;
}> {
  const tenantId = getTenantIdFromContext(c);
  const requestedId = c.req.param('id');
  if (!requestedId) throw new Error('account_governance_account_required');
  await resolveAccountDataContextFromHono(c, requestedId);
  const adapter = createAccountAuthContextFromHono(c, tenantId).coreAdapter;
  const account = await adapter.queryOne<CanonicalAccountRow>(
    `SELECT id FROM identity_accounts
      WHERE tenant_id = ? AND (legacy_user_id = ? OR id = ?)
      LIMIT 1`,
    [tenantId, requestedId, requestedId],
    { consistencyClass: 'primary_required' }
  );
  if (!account) throw new Error('account_governance_account_not_found');
  return { tenantId, accountId: account.id, adapter };
}

function accountNotFound(c: Context<{ Bindings: Env }>) {
  return c.json(
    { error: 'not_found', error_description: 'The requested account was not found' },
    404
  );
}

function invalidRequest(c: Context<{ Bindings: Env }>, description: string) {
  return c.json({ error: 'invalid_request', error_description: description }, 400);
}

function conflict(c: Context<{ Bindings: Env }>, description: string) {
  return c.json({ error: 'conflict', error_description: description }, 409);
}

export async function adminAccountSupportContextGetHandler(c: Context<{ Bindings: Env }>) {
  try {
    const { tenantId, accountId, adapter } = await accountScope(c);
    const row = await adapter.queryOne<SupportContextRow>(
      `SELECT context_json, version, created_by, updated_by, created_at, updated_at
         FROM account_support_contexts
        WHERE tenant_id = ? AND account_id = ?`,
      [tenantId, accountId],
      { consistencyClass: 'primary_required' }
    );
    return c.json(supportContextView(row));
  } catch (error) {
    if (error instanceof Error && error.message === 'account_governance_account_not_found') {
      return accountNotFound(c);
    }
    logSanitizedError('Account support context read failed', error);
    return c.json(
      { error: 'server_error', error_description: 'Unable to read support context' },
      500
    );
  }
}

export async function adminAccountSupportContextPutHandler(c: Context<{ Bindings: Env }>) {
  try {
    const actor = actorId(c);
    if (!actor) return c.json({ error: 'access_denied' }, 403);
    const body = await c.req.json<{ expected_version?: unknown; context?: unknown }>();
    if (!Number.isSafeInteger(body.expected_version) || (body.expected_version as number) < 0) {
      return invalidRequest(c, 'expected_version must be a non-negative integer');
    }
    const document = validateAccountSupportContext(body.context);
    if (!document) {
      return invalidRequest(c, 'context does not match the account support context schema');
    }
    const { tenantId, accountId, adapter } = await accountScope(c);
    const expectedVersion = body.expected_version as number;
    const now = Date.now();
    const encoded = JSON.stringify(document);
    const result =
      expectedVersion === 0
        ? await adapter.execute(
            `INSERT INTO account_support_contexts (
               tenant_id, account_id, context_json, version, created_by, updated_by,
               created_at, updated_at
             ) VALUES (?, ?, ?, 1, ?, ?, ?, ?)
             ON CONFLICT (tenant_id, account_id) DO NOTHING`,
            [tenantId, accountId, encoded, actor, actor, now, now]
          )
        : await adapter.execute(
            `UPDATE account_support_contexts
                SET context_json = ?, version = version + 1, updated_by = ?, updated_at = ?
              WHERE tenant_id = ? AND account_id = ? AND version = ?`,
            [encoded, actor, now, tenantId, accountId, expectedVersion]
          );
    if (result.rowsAffected !== 1) {
      return conflict(c, 'Support context was modified by another request');
    }
    const row = await adapter.queryOne<SupportContextRow>(
      `SELECT context_json, version, created_by, updated_by, created_at, updated_at
         FROM account_support_contexts
        WHERE tenant_id = ? AND account_id = ?`,
      [tenantId, accountId],
      { consistencyClass: 'primary_required' }
    );
    if (!row) throw new Error('account_support_context_write_not_reflected');
    const view = supportContextView(row);
    scheduleAdminAuditLog(c, 'account_support_context.updated', accountId, 'success', {
      changed_fields: ['summary', 'external_references'],
      old_version: expectedVersion,
      new_version: view.version,
      external_reference_count: view.context.external_references.length,
    });
    return c.json(view);
  } catch (error) {
    if (error instanceof Error && error.message === 'account_governance_account_not_found') {
      return accountNotFound(c);
    }
    logSanitizedError('Account support context update failed', error);
    return c.json(
      { error: 'server_error', error_description: 'Unable to update support context' },
      500
    );
  }
}

export async function adminAccountLegalHoldsListHandler(c: Context<{ Bindings: Env }>) {
  try {
    const { tenantId, accountId, adapter } = await accountScope(c);
    const rows = await adapter.query<LegalHoldRow>(
      `SELECT id, subject_id, state, reason_code, case_reference, expires_at, version,
              created_by, created_at, released_by, released_at, release_reason, updated_at
         FROM legal_holds
        WHERE tenant_id = ? AND subject_type = 'account' AND subject_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT 100`,
      [tenantId, accountId],
      { consistencyClass: 'primary_required' }
    );
    return c.json({ items: rows.map(legalHoldView) });
  } catch (error) {
    if (error instanceof Error && error.message === 'account_governance_account_not_found') {
      return accountNotFound(c);
    }
    logSanitizedError('Account legal hold list failed', error);
    return c.json({ error: 'server_error', error_description: 'Unable to read legal holds' }, 500);
  }
}

function idempotencyKey(c: Context<{ Bindings: Env }>): string | null {
  const value = c.req.header('Idempotency-Key')?.trim() ?? '';
  return SAFE_IDEMPOTENCY_KEY.test(value) ? value : null;
}

function parseExpiry(value: unknown, now: number): number | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return undefined;
  const parsed = Date.parse(value);
  if (!Number.isSafeInteger(parsed) || parsed <= now) return undefined;
  return parsed;
}

function sameCreatedHold(
  row: LegalHoldRow,
  input: {
    accountId: string;
    reasonCode: string;
    caseReference: string | null;
    expiresAt: number | null;
  }
): boolean {
  return (
    row.subject_id === input.accountId &&
    row.reason_code === input.reasonCode &&
    row.case_reference === input.caseReference &&
    optionalInteger(row.expires_at, 'account_legal_hold_storage_invalid') === input.expiresAt
  );
}

export async function adminAccountLegalHoldCreateHandler(c: Context<{ Bindings: Env }>) {
  try {
    const actor = actorId(c);
    if (!actor) return c.json({ error: 'access_denied' }, 403);
    const key = idempotencyKey(c);
    if (!key) return invalidRequest(c, 'A valid Idempotency-Key header is required');
    const body = await c.req.json<{
      reason_code?: unknown;
      case_reference?: unknown;
      expires_at?: unknown;
    }>();
    const reasonCode = nonEmptyBoundedString(body.reason_code, 64);
    if (!reasonCode || !SAFE_CODE.test(reasonCode)) {
      return invalidRequest(c, 'reason_code must be a stable lowercase code');
    }
    const caseReference =
      body.case_reference === undefined || body.case_reference === null
        ? null
        : nonEmptyBoundedString(body.case_reference, 256);
    if (body.case_reference !== undefined && body.case_reference !== null && !caseReference) {
      return invalidRequest(c, 'case_reference is invalid');
    }
    const now = Date.now();
    const expiresAt = parseExpiry(body.expires_at, now);
    if (expiresAt === undefined) return invalidRequest(c, 'expires_at must be a future timestamp');
    const { tenantId, accountId, adapter } = await accountScope(c);
    const keyDigest = await sha256Hex(`${tenantId}\0${accountId}\0${key}`);
    const holdId = `legal-hold:${keyDigest}`;
    const eventId = `legal-hold-event:${keyDigest}`;
    const operationId = `legal-hold-projection:${keyDigest}`;

    await adapter.batch([
      {
        sql: `INSERT INTO legal_holds (
                id, tenant_id, subject_type, subject_id, state, reason_code, case_reference,
                expires_at, version, created_by, created_at, updated_at
              ) VALUES (?, ?, 'account', ?, 'active', ?, ?, ?, 1, ?, ?, ?)
              ON CONFLICT (id) DO NOTHING`,
        params: [
          holdId,
          tenantId,
          accountId,
          reasonCode,
          caseReference,
          expiresAt,
          actor,
          now,
          now,
        ],
      },
      {
        sql: `INSERT INTO legal_hold_events (
                event_id, hold_id, tenant_id, account_id, event_type, hold_version,
                projection_generation, actor_id, reason_code, case_reference,
                effective_at, created_at
              )
              SELECT ?, hold.id, hold.tenant_id, hold.subject_id, 'created', hold.version,
                     authority.projection_generation, ?, hold.reason_code,
                     hold.case_reference, hold.created_at, ?
                FROM legal_holds hold
                JOIN account_legal_hold_states authority
                  ON authority.tenant_id = hold.tenant_id
                 AND authority.account_id = hold.subject_id
               WHERE hold.id = ? AND hold.tenant_id = ? AND hold.subject_id = ?
                 AND hold.state = 'active' AND hold.version = 1 AND hold.reason_code = ?
                 AND authority.projection_state = 'active'
                 AND authority.active_hold_id = hold.id
                 AND ((hold.case_reference IS NULL AND ? IS NULL) OR hold.case_reference = ?)
                 AND ((hold.expires_at IS NULL AND ? IS NULL) OR hold.expires_at = ?)
              ON CONFLICT DO NOTHING`,
        params: [
          eventId,
          actor,
          now,
          holdId,
          tenantId,
          accountId,
          reasonCode,
          caseReference,
          caseReference,
          expiresAt,
          expiresAt,
        ],
      },
      {
        sql: `INSERT INTO legal_hold_projection_outbox (
                operation_id, tenant_id, hold_id, account_id, projection_generation, hold_version,
                projection_state, next_attempt_at, created_at, updated_at
              )
              SELECT ?, hold.tenant_id, hold.id, hold.subject_id, authority.projection_generation,
                     hold.version, 'active', ?, ?, ?
                FROM legal_holds hold
                JOIN account_legal_hold_states authority
                  ON authority.tenant_id = hold.tenant_id
                 AND authority.account_id = hold.subject_id
               WHERE hold.id = ? AND hold.tenant_id = ?
                 AND hold.subject_id = ? AND hold.state = 'active'
                 AND hold.version = 1 AND authority.projection_state = 'active'
                 AND authority.active_hold_id = hold.id AND EXISTS (
                   SELECT 1 FROM legal_hold_events event WHERE event.event_id = ?
                 )
              ON CONFLICT (operation_id) DO NOTHING`,
        params: [operationId, now, now, now, holdId, tenantId, accountId, eventId],
      },
    ]);

    const row = await adapter.queryOne<LegalHoldRow>(
      `SELECT id, subject_id, state, reason_code, case_reference, expires_at, version,
              created_by, created_at, released_by, released_at, release_reason, updated_at
         FROM legal_holds WHERE id = ? AND tenant_id = ?`,
      [holdId, tenantId],
      { consistencyClass: 'primary_required' }
    );
    if (!row || !sameCreatedHold(row, { accountId, reasonCode, caseReference, expiresAt })) {
      return conflict(c, 'Idempotency-Key was already used for another legal hold request');
    }
    await attemptLegalHoldProjection(c, adapter, operationId);
    scheduleAdminAuditLog(c, 'account_legal_hold.created', accountId, 'success', {
      hold_id: holdId,
      hold_version: 1,
      reason_code: reasonCode,
      has_case_reference: caseReference !== null,
      has_expiry: expiresAt !== null,
    });
    return c.json(legalHoldView(row), 201);
  } catch (error) {
    if (error instanceof Error && error.message === 'account_governance_account_not_found') {
      return accountNotFound(c);
    }
    if (
      error instanceof Error &&
      (error.message.includes('idx_legal_holds_one_active_account') ||
        error.message.includes('legal_hold_active_conflict') ||
        error.message.includes('legal_holds.tenant_id'))
    ) {
      return conflict(c, 'The account already has an active legal hold');
    }
    logSanitizedError('Account legal hold create failed', error);
    return c.json({ error: 'server_error', error_description: 'Unable to create legal hold' }, 500);
  }
}

export async function adminAccountLegalHoldReleaseHandler(c: Context<{ Bindings: Env }>) {
  try {
    const actor = actorId(c);
    if (!actor) return c.json({ error: 'access_denied' }, 403);
    const key = idempotencyKey(c);
    if (!key) return invalidRequest(c, 'A valid Idempotency-Key header is required');
    const holdId = c.req.param('holdId');
    if (!holdId || !/^legal-hold:[a-f0-9]{64}$/u.test(holdId)) {
      return invalidRequest(c, 'holdId is invalid');
    }
    const body = await c.req.json<{ expected_version?: unknown; reason_code?: unknown }>();
    if (!Number.isSafeInteger(body.expected_version) || (body.expected_version as number) < 1) {
      return invalidRequest(c, 'expected_version must be a positive integer');
    }
    const reasonCode = nonEmptyBoundedString(body.reason_code, 64);
    if (!reasonCode || !SAFE_CODE.test(reasonCode)) {
      return invalidRequest(c, 'reason_code must be a stable lowercase code');
    }
    const expectedVersion = body.expected_version as number;
    const { tenantId, accountId, adapter } = await accountScope(c);
    const now = Date.now();
    const eventDigest = await sha256Hex(`${tenantId}\0${holdId}\0release\0${key}`);
    const eventId = `legal-hold-event:${eventDigest}`;
    const operationId = `legal-hold-projection:${eventDigest}`;
    const results = await adapter.batch([
      {
        sql: `UPDATE legal_holds
                 SET state = 'released', released_by = ?, released_at = ?, release_reason = ?,
                     version = version + 1, updated_at = ?
               WHERE id = ? AND tenant_id = ? AND subject_type = 'account' AND subject_id = ?
                 AND state = 'active' AND version = ?`,
        params: [actor, now, reasonCode, now, holdId, tenantId, accountId, expectedVersion],
      },
      {
        sql: `INSERT INTO legal_hold_events (
                event_id, hold_id, tenant_id, account_id, event_type, hold_version,
                projection_generation, actor_id, reason_code, case_reference,
                effective_at, created_at
              )
              SELECT ?, hold.id, hold.tenant_id, hold.subject_id, 'released', hold.version,
                     authority.projection_generation, ?, ?, hold.case_reference, ?, ?
                FROM legal_holds hold
                JOIN account_legal_hold_states authority
                  ON authority.tenant_id = hold.tenant_id
                 AND authority.account_id = hold.subject_id
               WHERE hold.id = ? AND hold.tenant_id = ? AND hold.subject_id = ?
                 AND hold.state = 'released' AND hold.version = ?
                 AND authority.projection_state = 'inactive'
                 AND authority.active_hold_id IS NULL
              ON CONFLICT DO NOTHING`,
        params: [
          eventId,
          actor,
          reasonCode,
          now,
          now,
          holdId,
          tenantId,
          accountId,
          expectedVersion + 1,
        ],
      },
      {
        sql: `INSERT INTO legal_hold_projection_outbox (
                operation_id, tenant_id, hold_id, account_id, projection_generation, hold_version,
                projection_state, next_attempt_at, created_at, updated_at
              )
              SELECT ?, hold.tenant_id, hold.id, hold.subject_id, authority.projection_generation,
                     hold.version, 'inactive', ?, ?, ?
                FROM legal_holds hold
                JOIN account_legal_hold_states authority
                  ON authority.tenant_id = hold.tenant_id
                 AND authority.account_id = hold.subject_id
               WHERE hold.id = ? AND hold.tenant_id = ? AND hold.subject_id = ?
                 AND hold.state = 'released' AND hold.version = ?
                 AND authority.projection_state = 'inactive'
                 AND authority.active_hold_id IS NULL AND EXISTS (
                   SELECT 1 FROM legal_hold_events event WHERE event.event_id = ?
                 )
              ON CONFLICT (operation_id) DO NOTHING`,
        params: [
          operationId,
          now,
          now,
          now,
          holdId,
          tenantId,
          accountId,
          expectedVersion + 1,
          eventId,
        ],
      },
    ]);

    const row = await adapter.queryOne<LegalHoldRow>(
      `SELECT id, subject_id, state, reason_code, case_reference, expires_at, version,
              created_by, created_at, released_by, released_at, release_reason, updated_at
         FROM legal_holds WHERE id = ? AND tenant_id = ? AND subject_id = ?`,
      [holdId, tenantId, accountId],
      { consistencyClass: 'primary_required' }
    );
    const idempotentRetry =
      results[0]?.rowsAffected === 0 &&
      row?.state === 'released' &&
      integer(row.version, 'account_legal_hold_storage_invalid') === expectedVersion + 1 &&
      (await adapter.queryOne<{ event_id: string }>(
        `SELECT event_id FROM legal_hold_events
          WHERE event_id = ? AND hold_id = ? AND hold_version = ? AND event_type = 'released'`,
        [eventId, holdId, expectedVersion + 1],
        { consistencyClass: 'primary_required' }
      )) !== null;
    if (!row || (results[0]?.rowsAffected !== 1 && !idempotentRetry)) {
      return conflict(c, 'Legal hold state or version changed');
    }
    await attemptLegalHoldProjection(c, adapter, operationId);
    scheduleAdminAuditLog(c, 'account_legal_hold.released', accountId, 'success', {
      hold_id: holdId,
      old_version: expectedVersion,
      new_version: expectedVersion + 1,
      reason_code: reasonCode,
    });
    return c.json(legalHoldView(row));
  } catch (error) {
    if (error instanceof Error && error.message === 'account_governance_account_not_found') {
      return accountNotFound(c);
    }
    logSanitizedError('Account legal hold release failed', error);
    return c.json(
      { error: 'server_error', error_description: 'Unable to release legal hold' },
      500
    );
  }
}
