import type { Context } from 'hono';
import {
  createAuditLogFromContext,
  createPIIContextFromHono,
  getTenantIdFromContext,
  resolveAccountDataContextFromHono,
  type DatabaseAdapter,
  type Env,
} from '@authrim/ar-lib-core';
import { resumeIdentifierReplacementOperation } from './account-identifier-replacement';

const SAFE_ID = /^[a-zA-Z0-9_-][a-zA-Z0-9._:-]{0,255}$/u;
const OPERATION_ID = /^identifier-replacement:[a-f0-9-]{36}$/u;
const RETRY_BUDGET_SECONDS = 2 * 60 * 60;
const OPERATION_STATES = new Set([
  'directory_pending',
  'authoritative_switch_pending',
  'authoritative_switched',
  'revocation_pending',
  'completed',
  'blocked_forward_repair',
  'canceled',
]);

async function resolveIdentifierReplacementPii(
  c: Context<{ Bindings: Env }>,
  tenantId: string,
  accountId: string
): Promise<DatabaseAdapter> {
  await resolveAccountDataContextFromHono(c, accountId);
  return createPIIContextFromHono(c, tenantId).defaultPiiAdapter;
}

interface OperationRow {
  operation_id: string;
  authority: string;
  state: string;
  error_code: string | null;
  created_at: number | string;
  updated_at: number | string;
  completed_at: number | string | null;
}

export interface AdminIdentifierReplacementOperation {
  operationId: string;
  authority: 'self_service' | 'admin' | 'scim' | 'external_idp';
  state: string;
  attentionRequired: boolean;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

function integer(value: number | string | null, code: string): number | null {
  if (value === null) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(code);
  return parsed;
}

function view(row: OperationRow): AdminIdentifierReplacementOperation {
  if (
    !OPERATION_ID.test(row.operation_id) ||
    !['self_service', 'admin', 'scim', 'external_idp'].includes(row.authority) ||
    !OPERATION_STATES.has(row.state)
  ) {
    throw new Error('admin_identifier_replacement_row_invalid');
  }
  return {
    operationId: row.operation_id,
    authority: row.authority as AdminIdentifierReplacementOperation['authority'],
    state: row.state,
    attentionRequired: row.state === 'blocked_forward_repair',
    createdAt: integer(row.created_at, 'admin_identifier_replacement_row_invalid')!,
    updatedAt: integer(row.updated_at, 'admin_identifier_replacement_row_invalid')!,
    completedAt: integer(row.completed_at, 'admin_identifier_replacement_row_invalid'),
  };
}

export async function listAdminIdentifierReplacements(
  pii: DatabaseAdapter,
  input: { tenantId: string; accountId: string; limit?: number }
): Promise<AdminIdentifierReplacementOperation[]> {
  if (!SAFE_ID.test(input.tenantId) || !SAFE_ID.test(input.accountId)) {
    throw new Error('admin_identifier_replacement_scope_invalid');
  }
  const limit = input.limit ?? 10;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) {
    throw new Error('admin_identifier_replacement_limit_invalid');
  }
  const rows = await pii.query<OperationRow>(
    `SELECT operation_id, authority, state, error_code, created_at, updated_at, completed_at
       FROM identity_identifier_replacement_operations
      WHERE tenant_id = ? AND account_id = ? AND identifier_kind = 'email_exact'
      ORDER BY created_at DESC, operation_id DESC LIMIT ?`,
    [input.tenantId, input.accountId, limit],
    { consistencyClass: 'primary_required' }
  );
  return rows.map(view);
}

export async function prepareBlockedIdentifierReplacementResume(
  pii: DatabaseAdapter,
  input: { tenantId: string; accountId: string; operationId: string; now: number }
): Promise<void> {
  if (
    !SAFE_ID.test(input.tenantId) ||
    !SAFE_ID.test(input.accountId) ||
    !OPERATION_ID.test(input.operationId) ||
    !Number.isSafeInteger(input.now) ||
    input.now < 1
  ) {
    throw new Error('admin_identifier_replacement_resume_invalid');
  }
  const results = await pii.batch([
    {
      sql: `UPDATE identity_identifier_replacement_operations
               SET state = 'authoritative_switched', error_code = NULL,
                   next_attempt_at = ?, retry_budget_expires_at = ?,
                   lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
             WHERE operation_id = ? AND tenant_id = ? AND account_id = ?
               AND state = 'blocked_forward_repair' AND authoritative_switched_at IS NOT NULL`,
      params: [
        input.now,
        input.now + RETRY_BUDGET_SECONDS,
        input.now,
        input.operationId,
        input.tenantId,
        input.accountId,
      ],
    },
    {
      sql: `UPDATE identity_identifier_replacement_outbox
               SET status = 'retry', next_attempt_at = ?, error_code = NULL,
                   lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
             WHERE operation_id = ? AND tenant_id = ? AND account_id = ? AND status = 'blocked'`,
      params: [input.now, input.now, input.operationId, input.tenantId, input.accountId],
    },
  ]);
  if (
    results.length !== 2 ||
    results.some((result) => !result.success || result.rowsAffected !== 1)
  ) {
    throw new Error('admin_identifier_replacement_not_resumable');
  }
}

export async function adminUserIdentifierReplacementsHandler(
  c: Context<{ Bindings: Env }>
): Promise<Response> {
  try {
    const tenantId = getTenantIdFromContext(c);
    const accountId = c.req.param('id')!;
    const pii = await resolveIdentifierReplacementPii(c, tenantId, accountId);
    const operations = await listAdminIdentifierReplacements(pii, { tenantId, accountId });
    return c.json({
      operations: operations.map((operation) => ({
        operation_id: operation.operationId,
        authority: operation.authority,
        state: operation.state,
        attention_required: operation.attentionRequired,
        error_code: operation.attentionRequired ? 'identifier_replacement_forward_repair' : null,
        created_at: operation.createdAt,
        updated_at: operation.updatedAt,
        completed_at: operation.completedAt,
      })),
    });
  } catch (error) {
    if (
      error instanceof Error &&
      /^(admin_identifier_replacement_(scope|row)_invalid)$/u.test(error.message)
    ) {
      return c.json({ error: 'not_found', error_description: 'User was not found' }, 404);
    }
    return c.json(
      { error: 'server_error', error_description: 'Failed to read identifier operations' },
      500
    );
  }
}

export async function adminUserIdentifierReplacementResumeHandler(
  c: Context<{ Bindings: Env }>
): Promise<Response> {
  try {
    const tenantId = getTenantIdFromContext(c);
    const accountId = c.req.param('id')!;
    const operationId = c.req.param('operationId')!;
    const now = Math.floor(Date.now() / 1000);
    const pii = await resolveIdentifierReplacementPii(c, tenantId, accountId);
    const before = (
      await listAdminIdentifierReplacements(pii, { tenantId, accountId, limit: 20 })
    ).find((candidate) => candidate.operationId === operationId);
    if (!before?.attentionRequired) {
      throw new Error('admin_identifier_replacement_not_resumable');
    }
    await createAuditLogFromContext(
      c,
      'user.identifier_replacement.resume_requested',
      'user',
      accountId,
      { operation_id: operationId }
    );
    await prepareBlockedIdentifierReplacementResume(pii, {
      tenantId,
      accountId,
      operationId,
      now,
    });
    await resumeIdentifierReplacementOperation(c, { operationId, tenantId, accountId });
    const operations = await listAdminIdentifierReplacements(pii, {
      tenantId,
      accountId,
      limit: 20,
    });
    const exact = operations.find((candidate) => candidate.operationId === operationId);
    if (!exact) throw new Error('admin_identifier_replacement_resume_reflection_failed');
    return c.json({
      operation_id: exact.operationId,
      state: exact.state,
      attention_required: exact.attentionRequired,
    });
  } catch (error) {
    if (
      error instanceof Error &&
      /^(admin_identifier_replacement_(resume_invalid|not_resumable|scope_invalid))$/u.test(
        error.message
      )
    ) {
      return c.json(
        { error: 'conflict', error_description: 'Identifier operation cannot be resumed' },
        409
      );
    }
    return c.json(
      { error: 'server_error', error_description: 'Failed to resume identifier operation' },
      500
    );
  }
}
