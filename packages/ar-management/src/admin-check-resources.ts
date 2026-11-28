/**
 * Admin API: the resource registry of self-contract Check API requests (core migration 021).
 *
 * - GET /api/admin/check-resource-types - the tenant's resource types (cursor paging)
 * - GET /api/admin/check-resource-types/:type - one resource type
 * - PUT /api/admin/check-resource-types/:type - set a type's action-to-relation map (whole)
 * - DELETE /api/admin/check-resource-types/:type - remove a type's settings (its registered
 *   resources stay; their checks then get no relation)
 * - GET /api/admin/check-resources - read the resources the tenant's application servers
 *   registered through /api/check/resources (debugging; filter by type and id, cursor paging)
 *
 * Reads need `admin:roles:read`; changes `admin:roles:write` / `admin:roles:delete` and a tenant
 * administrator role (the access table and `requireTenantAdminForChanges`). Every read and write
 * stays inside the routed tenant.
 */

import type { Context } from 'hono';
import type { AdminAuthContext, DatabaseAdapter, Env } from '@authrim/ar-lib-core';
import {
  AR_ERROR_CODES,
  checkResourceFromRow,
  checkResourceTypeFromRow,
  createAuthContextFromHono,
  createErrorResponse,
  createLogger,
  getTenantIdFromContext,
  isCheckResourceId,
  isCheckResourceName,
  parseCheckResourceRelations,
  type CheckResourceRow,
  type CheckResourceTypeRow,
} from '@authrim/ar-lib-core';
import { recordAdminOperationAudit } from './admin-operation-audit';

type AdminContext = Context<{ Bindings: Env; Variables: { adminAuth?: AdminAuthContext } }>;
type BaseContext = Context<{ Bindings: Env }>;

const log = createLogger().module('ADMIN-CHECK-RESOURCES');

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function base(c: AdminContext): BaseContext {
  return c as unknown as BaseContext;
}

function tenantAdapter(c: AdminContext): { tenantId: string; adapter: DatabaseAdapter } {
  const tenantId = getTenantIdFromContext(base(c));
  return { tenantId, adapter: createAuthContextFromHono(base(c), tenantId).coreAdapter };
}

function invalid(c: AdminContext, field: string): Response | Promise<Response> {
  return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
    variables: { field },
  });
}

/** `limit`: 1-200 (default 50); anything else is refused. */
function pageLimit(value: string | undefined): number | null {
  if (value === undefined || value === '') return DEFAULT_LIMIT;
  if (!/^[0-9]{1,3}$/.test(value)) return null;
  const limit = Number(value);
  return limit >= 1 && limit <= MAX_LIMIT ? limit : null;
}

function encodeCursor(position: readonly string[]): string {
  const bytes = new TextEncoder().encode(JSON.stringify(position));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The position a cursor names (`length` strings), or null when it is not one of ours. */
function decodeCursor(cursor: string, length: number): string[] | null {
  if (!/^[A-Za-z0-9_-]{1,2048}$/.test(cursor)) return null;
  try {
    const binary = atob(cursor.replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!Array.isArray(parsed) || parsed.length !== length) return null;
    const parts = parsed.filter((part): part is string => typeof part === 'string');
    return parts.length === length ? parts : null;
  } catch {
    return null;
  }
}

async function readJson(c: AdminContext): Promise<unknown> {
  try {
    return await c.req.json<unknown>();
  } catch {
    return undefined;
  }
}

async function findType(
  adapter: DatabaseAdapter,
  tenantId: string,
  resourceType: string
): Promise<CheckResourceTypeRow | null> {
  return adapter.queryOne<CheckResourceTypeRow>(
    `SELECT tenant_id, resource_type, relations_json, row_token, revision, created_at, updated_at
       FROM check_resource_types WHERE tenant_id = ? AND resource_type = ?`,
    [tenantId, resourceType]
  );
}

// =============================================================================
// Resource types
// =============================================================================

/**
 * GET /api/admin/check-resource-types?limit=&cursor=
 * `{ resource_types: [...], next_cursor }`, in resource type order.
 */
export async function adminCheckResourceTypesListHandler(c: AdminContext) {
  const limit = pageLimit(c.req.query('limit'));
  if (limit === null) return invalid(c, 'limit');
  const cursorParam = c.req.query('cursor');
  const after = cursorParam ? decodeCursor(cursorParam, 1) : undefined;
  if (after === null) return invalid(c, 'cursor');
  try {
    const { tenantId, adapter } = tenantAdapter(c);
    const rows = await adapter.query<CheckResourceTypeRow>(
      `SELECT tenant_id, resource_type, relations_json, created_at, updated_at
         FROM check_resource_types
        WHERE tenant_id = ?${after ? ' AND resource_type > ?' : ''}
        ORDER BY resource_type
        LIMIT ?`,
      [tenantId, ...(after ?? []), limit + 1]
    );
    const page = rows.slice(0, limit);
    return c.json({
      resource_types: page.map(checkResourceTypeFromRow),
      next_cursor: rows.length > limit ? encodeCursor([page[page.length - 1].resource_type]) : null,
    });
  } catch (error) {
    log.error('Failed to list check resource types', { error: String(error) }, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/** GET /api/admin/check-resource-types/:type */
export async function adminCheckResourceTypeGetHandler(c: AdminContext) {
  const resourceType = c.req.param('type');
  if (!isCheckResourceName(resourceType)) return invalid(c, 'resource_type');
  try {
    const { tenantId, adapter } = tenantAdapter(c);
    const row = await findType(adapter, tenantId, resourceType);
    if (!row) return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    return c.json(checkResourceTypeFromRow(row));
  } catch (error) {
    log.error('Failed to read a check resource type', { error: String(error) }, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/** The answer to a write that lost a race with another administrator's (nothing was changed). */
function conflict(c: AdminContext): Response {
  return c.json(
    {
      error: 'check_resource_type_conflict',
      error_description: 'The resource type changed since it was read. Try again.',
    },
    409
  );
}

/**
 * A best-effort record that a change announced in the audit log did not happen: `conflict` (the
 * row changed since it was read; nothing written) or `error` (the write failed). A failure to
 * record it is logged only.
 */
async function recordAborted(
  c: AdminContext,
  resourceType: string,
  intended: 'created' | 'updated' | 'deleted',
  reason: 'conflict' | 'error'
): Promise<void> {
  try {
    await recordAdminOperationAudit(base(c), {
      action: 'permission.check_resource_type.aborted',
      resourceType: 'check_resource_type',
      resourceId: resourceType,
      result: 'failure',
      metadata: { intended: `permission.check_resource_type.${intended}`, reason },
    });
  } catch (error) {
    log.error(
      'Aborted check resource type change not recorded',
      { resourceType, reason, error: String(error) },
      error as Error
    );
  }
}

/** The row this request means to leave behind (`null`: none, for a deletion). */
type IntendedRow = { rowToken: string; revision: number; relationsJson: string } | null;

/**
 * The row as it is now, and whether it is what this request meant to leave: a write the database
 * reports as having changed nothing (or that threw) may still have landed, as when a transport
 * error made the adapter retry a write that had been applied. Throws when the row cannot be read.
 */
async function readIntended(
  adapter: DatabaseAdapter,
  tenantId: string,
  resourceType: string,
  intended: IntendedRow
): Promise<{ matches: boolean; row: CheckResourceTypeRow | null }> {
  const row = await findType(adapter, tenantId, resourceType);
  if (intended === null) return { matches: row === null, row };
  return {
    matches:
      row !== null &&
      row.row_token === intended.rowToken &&
      Number(row.revision ?? 0) === intended.revision &&
      row.relations_json === intended.relationsJson,
    row,
  };
}

/**
 * The outcome of the conditional write of a change already recorded:
 * - `done`: written now (`stored` absent), or already in place from a retried write that had
 *   landed (`stored`: the row as read back, which the answer is built from);
 * - `conflict`: the database wrote nothing (success, 0 rows) and the row is another write's;
 * - `error`: the write threw or reported failure (`success: false`), or the row could not be
 *   read back, and the change is not known to be in place.
 */
type WriteOutcome =
  | { outcome: 'done'; stored?: CheckResourceTypeRow | null }
  | { outcome: 'conflict' | 'error' };

async function writeRecorded(
  adapter: DatabaseAdapter,
  tenantId: string,
  resourceType: string,
  statement: { sql: string; params: unknown[] },
  intended: IntendedRow
): Promise<WriteOutcome> {
  let result: { success: boolean; rowsAffected: number };
  try {
    result = await adapter.execute(statement.sql, statement.params);
  } catch (error) {
    log.error('Check resource type write failed', { error: String(error) }, error as Error);
    // It may have landed before the error: read it back (an unreadable row is an error too).
    try {
      const now = await readIntended(adapter, tenantId, resourceType, intended);
      return now.matches ? { outcome: 'done', stored: now.row } : { outcome: 'error' };
    } catch {
      return { outcome: 'error' };
    }
  }
  if (!result.success) {
    log.error('Check resource type write reported failure', { resourceType });
    return { outcome: 'error' };
  }
  if (result.rowsAffected === 1) return { outcome: 'done' };
  try {
    const now = await readIntended(adapter, tenantId, resourceType, intended);
    return now.matches ? { outcome: 'done', stored: now.row } : { outcome: 'conflict' };
  } catch (error) {
    log.error('Check resource type read-back failed', { error: String(error) }, error as Error);
    return { outcome: 'error' };
  }
}

/*
 * Ordering of a resource type change (PUT and DELETE): the audit record comes FIRST.
 *
 * 1. Read the row as it is: its relations, its `row_token` (a random id given at insert: a row
 *    deleted and created again gets another) and its `revision`.
 * 2. Record the change in the Admin audit log, with the map it replaces and the map it writes.
 *    The action is in the fail-closed role-and-permission class (`permission.`): when the record
 *    cannot be written, the request fails (500) and nothing is written.
 * 3. Write, conditional on `row_token` and `revision` as read: a PUT sets revision + 1, a DELETE
 *    removes the row, and a creation inserts (with a new token) only while no row exists.
 *    - Nothing changed, but the row already is what this request meant (a write retried after it
 *      had landed): success.
 *    - Nothing changed otherwise: 409, and a best-effort `aborted` record (`reason: conflict`).
 *    - The write failed and the row does not hold the change: 500, and a best-effort `aborted`
 *      record (`reason: error`).
 *
 * So the audit log may hold a record of a change that was then aborted (followed by its aborted
 * record when that could be written), but never a change without a record. No change is ever
 * undone after the fact.
 */

/**
 * PUT /api/admin/check-resource-types/:type
 * Body: `{ relations: { "<action>": "<relation>" } }` (the whole map; `{}` maps no action).
 * Creates the type's settings or replaces them; answers the stored type.
 */
export async function adminCheckResourceTypePutHandler(c: AdminContext) {
  const resourceType = c.req.param('type');
  if (!isCheckResourceName(resourceType)) return invalid(c, 'resource_type');
  const body = await readJson(c);
  if (
    typeof body !== 'object' ||
    body === null ||
    Array.isArray(body) ||
    Object.keys(body).some((key) => key !== 'relations')
  ) {
    return invalid(c, 'body');
  }
  const relations = parseCheckResourceRelations((body as { relations?: unknown }).relations);
  if (!relations.ok) return invalid(c, relations.field);

  try {
    const { tenantId, adapter } = tenantAdapter(c);
    const before = await findType(adapter, tenantId, resourceType);
    const now = Date.now();
    const written = JSON.stringify(relations.value);
    const intended = before ? 'updated' : 'created';

    await recordAdminOperationAudit(base(c), {
      action: `permission.check_resource_type.${intended}`,
      resourceType: 'check_resource_type',
      resourceId: resourceType,
      ...(before && { before: { relations: checkResourceTypeFromRow(before).relations } }),
      after: { relations: relations.value },
    });

    const revision = Number(before?.revision ?? 0);
    const rowToken = before?.row_token ?? crypto.randomUUID();
    const writeOutcome = await writeRecorded(
      adapter,
      tenantId,
      resourceType,
      before
        ? {
            sql: `UPDATE check_resource_types
                     SET relations_json = ?, revision = revision + 1, updated_at = ?
                   WHERE tenant_id = ? AND resource_type = ? AND row_token = ? AND revision = ?`,
            params: [written, now, tenantId, resourceType, rowToken, revision],
          }
        : {
            sql: `INSERT INTO check_resource_types
                    (tenant_id, resource_type, relations_json, row_token, revision, created_at,
                     updated_at)
                  VALUES (?, ?, ?, ?, 0, ?, ?)
                  ON CONFLICT (tenant_id, resource_type) DO NOTHING`,
            params: [tenantId, resourceType, written, rowToken, now, now],
          },
      { rowToken, revision: before ? revision + 1 : 0, relationsJson: written }
    );
    if (writeOutcome.outcome !== 'done') {
      await recordAborted(c, resourceType, intended, writeOutcome.outcome);
      return writeOutcome.outcome === 'conflict'
        ? conflict(c)
        : createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
    }
    // Already in place from a retried write: answer with the row as stored.
    if (writeOutcome.stored) return c.json(checkResourceTypeFromRow(writeOutcome.stored));

    return c.json(
      checkResourceTypeFromRow({
        tenant_id: tenantId,
        resource_type: resourceType,
        relations_json: written,
        created_at: before ? before.created_at : now,
        updated_at: now,
      })
    );
  } catch (error) {
    log.error('Failed to save a check resource type', { error: String(error) }, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * DELETE /api/admin/check-resource-types/:type (404 when the type has no settings, 409 when it
 * changed since it was read).
 */
export async function adminCheckResourceTypeDeleteHandler(c: AdminContext) {
  const resourceType = c.req.param('type');
  if (!isCheckResourceName(resourceType)) return invalid(c, 'resource_type');
  try {
    const { tenantId, adapter } = tenantAdapter(c);
    const before = await findType(adapter, tenantId, resourceType);
    if (!before) return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);

    await recordAdminOperationAudit(base(c), {
      action: 'permission.check_resource_type.deleted',
      resourceType: 'check_resource_type',
      resourceId: resourceType,
      before: { relations: checkResourceTypeFromRow(before).relations },
    });

    const deleted = await writeRecorded(
      adapter,
      tenantId,
      resourceType,
      {
        sql: `DELETE FROM check_resource_types
               WHERE tenant_id = ? AND resource_type = ? AND row_token = ? AND revision = ?`,
        params: [tenantId, resourceType, before.row_token, Number(before.revision ?? 0)],
      },
      null
    );
    if (deleted.outcome !== 'done') {
      await recordAborted(c, resourceType, 'deleted', deleted.outcome);
      return deleted.outcome === 'conflict'
        ? conflict(c)
        : createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
    }
    return c.json({ success: true });
  } catch (error) {
    log.error('Failed to delete a check resource type', { error: String(error) }, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

// =============================================================================
// Registered resources (read only)
// =============================================================================

/**
 * GET /api/admin/check-resources?resource_type=&resource_id=&limit=&cursor=
 * `{ resources: [...], next_cursor }`, in (resource type, resource id) order. A stored attribute
 * value that is not a JSON object is answered as `attributes: null, attributes_invalid: true`.
 */
export async function adminCheckResourcesListHandler(c: AdminContext) {
  const resourceType = c.req.query('resource_type') || undefined;
  const resourceId = c.req.query('resource_id') || undefined;
  if (resourceType !== undefined && !isCheckResourceName(resourceType)) {
    return invalid(c, 'resource_type');
  }
  if (resourceId !== undefined && !isCheckResourceId(resourceId)) {
    return invalid(c, 'resource_id');
  }
  const limit = pageLimit(c.req.query('limit'));
  if (limit === null) return invalid(c, 'limit');
  const cursorParam = c.req.query('cursor');
  const after = cursorParam ? decodeCursor(cursorParam, 2) : undefined;
  if (after === null) return invalid(c, 'cursor');

  try {
    const { tenantId, adapter } = tenantAdapter(c);
    const where = ['tenant_id = ?'];
    const params: unknown[] = [tenantId];
    if (resourceType !== undefined) {
      where.push('resource_type = ?');
      params.push(resourceType);
    }
    if (resourceId !== undefined) {
      where.push('resource_id = ?');
      params.push(resourceId);
    }
    if (after) {
      where.push('(resource_type > ? OR (resource_type = ? AND resource_id > ?))');
      params.push(after[0], after[0], after[1]);
    }
    const rows = await adapter.query<CheckResourceRow>(
      `SELECT tenant_id, resource_type, resource_id, owner_id, group_id, attributes_json, updated_at
         FROM check_resources
        WHERE ${where.join(' AND ')}
        ORDER BY resource_type, resource_id
        LIMIT ?`,
      [...params, limit + 1]
    );
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return c.json({
      resources: page.map((row) => {
        try {
          return checkResourceFromRow(row);
        } catch {
          return {
            ...checkResourceFromRow({ ...row, attributes_json: null }),
            attributes_invalid: true,
          };
        }
      }),
      next_cursor:
        rows.length > limit && last ? encodeCursor([last.resource_type, last.resource_id]) : null,
    });
  } catch (error) {
    log.error('Failed to list check resources', { error: String(error) }, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}
