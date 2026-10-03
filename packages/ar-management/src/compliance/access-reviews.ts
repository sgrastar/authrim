/**
 * Access reviews: an admin reviews who has some access and takes away what is no longer needed.
 *
 * - Creating a review takes a snapshot of its items from every store the tenant's accounts live
 *   in: the users with a role (`role`), the members of an organization (`organization`), all
 *   active users (`all_users`), or those not signed in for some days (`inactive_users`; the last
 *   sign-in is the one sessions record, read from the account's session state when the account
 *   does not show a recent one). A review over more than MAX_REVIEW_ITEMS items is refused.
 * - Reviewers approve or revoke each item (one at a time or in batches), with a justification.
 * - Completing the review needs every item decided, and applies the revocations through the same
 *   removals the Admin API uses (access-revocation.ts): the role assignment or membership goes,
 *   the account is suspended. Each item records the outcome; failed ones are retried by completing
 *   again, and the review completes once nothing is left to apply.
 *
 * User names and emails are not copied into the review; items are shown with them as they are now.
 */
import type { Context } from 'hono';
import { z } from 'zod';
import {
  AR_ERROR_CODES,
  CanonicalRuntimeUserStore,
  createAuditLogFromContext,
  createAuthContextFromHono,
  createErrorResponse,
  createPIIContextFromHono,
  ensureDatabaseAdapter,
  getLogger,
  getSessionRevocationStore,
  getTenantIdFromContext,
  getTenantMetadataContextFromHono,
  isDatabaseSource,
  ADMIN_PERMISSIONS,
  hasAdminPermission,
  type AdminAuthContext,
  type DatabaseAdapter,
  type Env,
} from '@authrim/ar-lib-core';
import {
  AccountLifecycleSupersededError,
  removeOrganizationMembership,
  removeRoleAssignment,
  suspendAccount,
  type RevocationContext,
} from '../access-revocation';
import { canManageRoleHierarchy } from '../admin-rbac';
import { tenantCoreStores } from './tenant-stores';
import { CrossShardAccountExactSearchService } from '../cross-shard-account-list';
import { usesRoutedAccountStorage } from '../tenant-routed-storage';

/** The most items one review may have; narrow the scope for more. */
export const MAX_REVIEW_ITEMS = 1000;
export const DEFAULT_INACTIVE_DAYS = 90;
/** Revocations one completion request applies; completing again continues. */
export const MAX_APPLIES_PER_REQUEST = 100;
/** Accounts read per page when scanning a store. */
const ACCOUNT_PAGE_SIZE = 500;
/** Session sign-in lookups an inactive-user review may make while it is created. */
export const MAX_LAST_LOGIN_LOOKUPS = 5000;
/** A claim on an item older than this was left by an interrupted completion and is taken over. */
const APPLY_CLAIM_STALE_MS = 5 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const LAST_LOGIN_CONCURRENCY = 20;

export const ACCESS_REVIEW_SCOPES = [
  'all_users',
  'role',
  'organization',
  'inactive_users',
] as const;
export type AccessReviewScope = (typeof ACCESS_REVIEW_SCOPES)[number];
export const ACCESS_REVIEW_STATUSES = ['pending', 'in_progress', 'completed', 'cancelled'] as const;
export type AccessReviewStatus = (typeof ACCESS_REVIEW_STATUSES)[number];
type PermissionType = 'role' | 'organization' | 'account';
type Decision = 'approved' | 'revoked';

interface AccessReviewRow {
  id: string;
  tenant_id: string;
  name: string;
  description: string | null;
  scope: AccessReviewScope;
  scope_value: string | null;
  status: AccessReviewStatus;
  reviewer_id: string | null;
  total_items: number;
  reviewed_items: number;
  approved_items: number;
  revoked_items: number;
  created_at: string | number;
  started_at: string | number | null;
  completed_at: string | number | null;
  due_date: string | number | null;
  created_by: string | null;
  completed_by: string | null;
  inactive_days: number | null;
}

interface AccessReviewItemRow {
  id: string;
  review_id: string;
  user_id: string;
  permission_type: PermissionType;
  permission_value: string;
  decision: Decision | 'pending' | null;
  decided_by: string | null;
  decided_at: string | null;
  justification: string | null;
  created_at: string;
  store_ref: string | null;
  entitlement_ref: string | null;
  apply_status: 'applying' | 'applied' | 'incomplete' | 'failed' | 'skipped' | null;
  apply_first_at?: string | null;
  applied_at: string | null;
  apply_error: string | null;
}

/** A snapshot entry: a user with an entitlement, and the store it lives in. */
interface SnapshotItem {
  userId: string;
  permissionType: PermissionType;
  permissionValue: string;
  entitlementRef: string;
  storeRef: string;
}

// =============================================================================
// Helpers
// =============================================================================

/** Older rows hold Unix seconds as text; newer ones ISO text. */
function toIso(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' || /^\d+$/u.test(value)) {
    const n = Number(value);
    return new Date(n < 1e12 ? n * 1000 : n).toISOString();
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function getAdminAuth(c: Context<{ Bindings: Env }>): AdminAuthContext | null {
  return ((c as unknown as { get(key: string): unknown }).get('adminAuth') ??
    null) as AdminAuthContext | null;
}

function reviewsAdapter(c: Context<{ Bindings: Env }>, tenantId: string): DatabaseAdapter {
  return createAuthContextFromHono(c, tenantId).coreAdapter;
}

function serializeReview(row: AccessReviewRow) {
  const due = toIso(row.due_date);
  return {
    review_id: row.id,
    name: row.name,
    description: row.description,
    scope: row.scope,
    scope_value: row.scope_value,
    inactive_days: row.inactive_days,
    status: row.status,
    reviewer_id: row.reviewer_id,
    created_by: row.created_by,
    completed_by: row.completed_by,
    progress: {
      total_items: row.total_items,
      reviewed_items: row.reviewed_items,
      approved_items: row.approved_items,
      revoked_items: row.revoked_items,
      completion_percent:
        row.total_items > 0 ? Math.round((row.reviewed_items / row.total_items) * 100) : 0,
    },
    created_at: toIso(row.created_at),
    started_at: toIso(row.started_at),
    completed_at: toIso(row.completed_at),
    due_date: due,
    overdue: row.status === 'in_progress' && due !== null && Date.parse(due) < Date.now(),
  };
}

const REVIEW_COLUMNS = `id, tenant_id, name, description, scope, scope_value, status, reviewer_id,
  total_items, reviewed_items, approved_items, revoked_items, created_at, started_at,
  completed_at, due_date, created_by, completed_by, inactive_days`;

async function loadReview(
  adapter: DatabaseAdapter,
  tenantId: string,
  reviewId: string
): Promise<AccessReviewRow | null> {
  return adapter.queryOne<AccessReviewRow>(
    `SELECT ${REVIEW_COLUMNS} FROM access_reviews WHERE tenant_id = ? AND id = ?`,
    [tenantId, reviewId],
    { consistencyClass: 'primary_required' }
  );
}

/** Recounts a review's progress from its items (so counters never drift from decisions). */
async function refreshCounts(adapter: DatabaseAdapter, tenantId: string, reviewId: string) {
  await adapter.execute(
    `UPDATE access_reviews SET
       total_items = (SELECT COUNT(*) FROM access_review_items WHERE review_id = ?),
       reviewed_items = (SELECT COUNT(*) FROM access_review_items
                          WHERE review_id = ? AND decision IN ('approved', 'revoked')),
       approved_items = (SELECT COUNT(*) FROM access_review_items
                          WHERE review_id = ? AND decision = 'approved'),
       revoked_items = (SELECT COUNT(*) FROM access_review_items
                         WHERE review_id = ? AND decision = 'revoked')
     WHERE tenant_id = ? AND id = ?`,
    [reviewId, reviewId, reviewId, reviewId, tenantId, reviewId]
  );
}

function reviewNotFound(c: Context<{ Bindings: Env }>, reviewId: string) {
  return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND, {
    variables: { resource: 'access_review', id: reviewId },
  });
}

function invalid(c: Context<{ Bindings: Env }>, field: string, reason: string) {
  return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
    variables: { field, reason },
  });
}

// =============================================================================
// Snapshot
// =============================================================================

class ReviewTooLargeError extends Error {
  constructor() {
    super('access_review_too_large');
  }
}

/** Finding inactive users would need more sign-in lookups than one request makes. */
class ReviewScanLimitError extends Error {
  constructor() {
    super('access_review_scan_limit');
  }
}

/** The last sign-in of each user, from their session state (null when never). */
async function lastLoginTimes(
  env: Env,
  tenantId: string,
  userIds: string[]
): Promise<Map<string, number | null>> {
  const times = new Map<string, number | null>();
  for (let index = 0; index < userIds.length; index += LAST_LOGIN_CONCURRENCY) {
    const chunk = userIds.slice(index, index + LAST_LOGIN_CONCURRENCY);
    const values = await Promise.all(
      chunk.map((userId) =>
        getSessionRevocationStore(env, tenantId, userId).getLastLoginAtRpc(
          tenantId,
          userId,
          `account:${userId}`
        )
      )
    );
    chunk.forEach((userId, i) => times.set(userId, values[i] ?? null));
  }
  return times;
}

export async function takeReviewSnapshot(
  env: Env,
  input: {
    tenantId: string;
    routed: boolean;
    scope: AccessReviewScope;
    scopeValue: string | null;
    inactiveDays: number;
    now?: number;
  }
): Promise<SnapshotItem[]> {
  const { tenantId, scope, scopeValue, inactiveDays } = input;
  const now = input.now ?? Date.now();
  const stores = await tenantCoreStores(env, tenantId, {
    accountsOfRoutedTenant: input.routed && (scope === 'all_users' || scope === 'inactive_users'),
  });
  const limit = MAX_REVIEW_ITEMS + 1;
  const items: SnapshotItem[] = [];
  let lastLoginLookups = 0;
  for (const { bindingRef, adapter } of stores) {
    if (scope === 'role') {
      const rows = await adapter.query<{ id: string; subject_id: string }>(
        `SELECT id, subject_id FROM role_assignments
          WHERE tenant_id = ? AND role_id = ? AND (expires_at IS NULL OR expires_at > ?)
          ORDER BY id LIMIT ?`,
        [tenantId, scopeValue, Math.floor(now / 1000), limit]
      );
      for (const row of rows) {
        items.push({
          userId: row.subject_id,
          permissionType: 'role',
          permissionValue: scopeValue!,
          entitlementRef: row.id,
          storeRef: bindingRef,
        });
      }
    } else if (scope === 'organization') {
      const rows = await adapter.query<{ subject_id: string }>(
        `SELECT subject_id FROM subject_org_membership
          WHERE tenant_id = ? AND org_id = ? ORDER BY subject_id LIMIT ?`,
        [tenantId, scopeValue, limit]
      );
      for (const row of rows) {
        items.push({
          userId: row.subject_id,
          permissionType: 'organization',
          permissionValue: scopeValue!,
          entitlementRef: `${scopeValue!}:${row.subject_id}`,
          storeRef: bindingRef,
        });
      }
    } else {
      const threshold = now - inactiveDays * DAY_MS;
      // Every active registered user, a page at a time. For inactive users, those the account
      // shows signed in within the window are active; the others are checked against the
      // sign-in their sessions recorded (not every sign-in method updates the account).
      let after = '';
      for (;;) {
        const rows = await adapter.query<{ legacy_user_id: string; recent: number }>(
          `SELECT legacy_user_id,
                  CASE WHEN metadata_json IS NOT NULL AND json_valid(metadata_json)
                         AND json_type(metadata_json, '$.last_login_at') IN ('integer', 'real')
                         AND CAST(json_extract(metadata_json, '$.last_login_at') AS INTEGER) >= ?
                       THEN 1 ELSE 0 END AS recent
             FROM identity_accounts
            WHERE tenant_id = ? AND account_type = 'user' AND lifecycle_state = 'active'
              AND (registration_state IS NULL OR registration_state <> 'guest')
              AND legacy_user_id > ?
            ORDER BY legacy_user_id LIMIT ?`,
          [threshold, tenantId, after, ACCOUNT_PAGE_SIZE]
        );
        if (rows.length === 0) break;
        after = rows[rows.length - 1]!.legacy_user_id;
        let selected = rows;
        if (scope === 'inactive_users') {
          const unsure = rows.filter((row) => Number(row.recent) !== 1);
          lastLoginLookups += unsure.length;
          if (lastLoginLookups > MAX_LAST_LOGIN_LOOKUPS) throw new ReviewScanLimitError();
          const times = await lastLoginTimes(
            env,
            tenantId,
            unsure.map((row) => row.legacy_user_id)
          );
          selected = unsure.filter((row) => {
            const at = times.get(row.legacy_user_id);
            return at === null || at === undefined || at < threshold;
          });
        }
        for (const row of selected) {
          items.push({
            userId: row.legacy_user_id,
            permissionType: 'account',
            permissionValue: 'active',
            entitlementRef: row.legacy_user_id,
            storeRef: bindingRef,
          });
        }
        if (items.length > MAX_REVIEW_ITEMS) throw new ReviewTooLargeError();
        if (rows.length < ACCOUNT_PAGE_SIZE) break;
      }
    }
    if (items.length > MAX_REVIEW_ITEMS) throw new ReviewTooLargeError();
  }
  return items;
}

// =============================================================================
// Handlers
// =============================================================================

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

function encodeCursor(id: string, createdAt: string): string {
  return Buffer.from(JSON.stringify({ id, created_at: createdAt })).toString('base64url');
}

function decodeCursor(cursor: string): { id: string; created_at: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      id?: unknown;
      created_at?: unknown;
    };
    if (typeof parsed.id === 'string' && parsed.id && typeof parsed.created_at === 'string') {
      return { id: parsed.id, created_at: parsed.created_at };
    }
    return null;
  } catch {
    return null;
  }
}

/** GET /api/admin/compliance/access-reviews */
export async function listAccessReviews(c: Context<{ Bindings: Env }>) {
  const tenantId = getTenantIdFromContext(c);
  if (c.req.query('page') || c.req.query('page_size')) {
    return invalid(c, 'pagination', 'Use cursor-based pagination. page/page_size not supported.');
  }
  const limit = Math.min(
    Math.max(parseInt(c.req.query('limit') || '', 10) || DEFAULT_LIMIT, 1),
    MAX_LIMIT
  );
  const where = ['tenant_id = ?'];
  const params: unknown[] = [tenantId];
  const cursor = c.req.query('cursor');
  if (cursor) {
    const decoded = decodeCursor(cursor);
    if (!decoded) return invalid(c, 'cursor', 'Invalid cursor format');
    // created_at is text: compare as stored.
    where.push('(created_at < ? OR (created_at = ? AND id > ?))');
    params.push(decoded.created_at, decoded.created_at, decoded.id);
  }
  const status = c.req.query('status') ?? /status=(\w+)/u.exec(c.req.query('filter') ?? '')?.[1];
  if (status && ACCESS_REVIEW_STATUSES.includes(status as AccessReviewStatus)) {
    where.push('status = ?');
    params.push(status);
  }
  try {
    const rows = await reviewsAdapter(c, tenantId).query<AccessReviewRow>(
      `SELECT ${REVIEW_COLUMNS} FROM access_reviews WHERE ${where.join(' AND ')}
        ORDER BY created_at DESC, id ASC LIMIT ?`,
      [...params, limit + 1]
    );
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    return c.json({
      data: page.map(serializeReview),
      pagination: {
        has_more: hasMore,
        ...(hasMore && last ? { next_cursor: encodeCursor(last.id, String(last.created_at)) } : {}),
      },
    });
  } catch (error) {
    getLogger(c)
      .module('ACCESS-REVIEW')
      .error('Failed to list access reviews', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/** A calendar date (YYYY-MM-DD, one that exists) or an ISO date-time. */
function isDateOrDateTime(value: string): boolean {
  const date = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (date) {
    const [year, month, day] = date.slice(1).map(Number) as [number, number, number];
    const parsed = new Date(Date.UTC(year, month - 1, day));
    return (
      parsed.getUTCFullYear() === year &&
      parsed.getUTCMonth() === month - 1 &&
      parsed.getUTCDate() === day
    );
  }
  // A date-time: its date must exist too (Date.parse would roll 02-31 over into March).
  const dateTime = /^(\d{4}-\d{2}-\d{2})T/u.exec(value);
  return Boolean(dateTime && isDateOrDateTime(dateTime[1]!) && !Number.isNaN(Date.parse(value)));
}

const CreateSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    description: z.string().max(1000).optional(),
    scope: z.enum(ACCESS_REVIEW_SCOPES),
    scope_value: z.string().trim().min(1).max(255).optional(),
    // A date (end of that day, UTC) or a date-time.
    due_date: z
      .string()
      .refine(isDateOrDateTime, { message: 'Must be a date or a date-time' })
      .optional(),
    inactive_days: z.number().int().min(1).max(3650).optional(),
  })
  .superRefine((value, context) => {
    if ((value.scope === 'role' || value.scope === 'organization') && !value.scope_value) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['scope_value'],
        message: 'Required for this scope',
      });
    }
  });

function dueDateIso(value: string | undefined): string | null {
  if (!value) return null;
  return /^\d{4}-\d{2}-\d{2}$/u.test(value)
    ? new Date(`${value}T23:59:59.999Z`).toISOString()
    : new Date(Date.parse(value)).toISOString();
}

/** POST /api/admin/compliance/access-reviews */
export async function createAccessReview(c: Context<{ Bindings: Env }>) {
  const tenantId = getTenantIdFromContext(c);
  const log = getLogger(c).module('ACCESS-REVIEW');
  const body: unknown = await c.req.json().catch(() => null);
  const parsed = CreateSchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return invalid(c, issue?.path.join('.') || 'body', issue?.message || 'Invalid value');
  }
  const input = parsed.data;
  const adminId = getAdminAuth(c)?.userId;
  if (!adminId) return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);

  const adapter = reviewsAdapter(c, tenantId);
  const scopeValue =
    input.scope === 'role' || input.scope === 'organization' ? input.scope_value! : null;
  const inactiveDays =
    input.scope === 'inactive_users' ? (input.inactive_days ?? DEFAULT_INACTIVE_DAYS) : null;

  try {
    if (input.scope === 'role' || input.scope === 'organization') {
      const table = input.scope === 'role' ? 'roles' : 'organizations';
      const exists = await adapter.queryOne<{ id: string }>(
        `SELECT id FROM ${table} WHERE tenant_id = ? AND id = ?`,
        [tenantId, scopeValue]
      );
      if (!exists) return invalid(c, 'scope_value', `No such ${input.scope}`);
    }

    let items: SnapshotItem[];
    try {
      items = await takeReviewSnapshot(c.env, {
        tenantId,
        routed: usesRoutedAccountStorage(getTenantMetadataContextFromHono(c)),
        scope: input.scope,
        scopeValue,
        inactiveDays: inactiveDays ?? DEFAULT_INACTIVE_DAYS,
      });
    } catch (error) {
      if (error instanceof ReviewScanLimitError) {
        return c.json(
          {
            error: 'access_review_scan_limit',
            error_description: `Finding inactive users needs more than ${MAX_LAST_LOGIN_LOOKUPS} sign-in lookups; review a role or an organization instead`,
            max_lookups: MAX_LAST_LOGIN_LOOKUPS,
          },
          400
        );
      }
      if (error instanceof ReviewTooLargeError) {
        return c.json(
          {
            error: 'access_review_too_large',
            error_description: `A review may have at most ${MAX_REVIEW_ITEMS} items; narrow its scope`,
            max_items: MAX_REVIEW_ITEMS,
          },
          400
        );
      }
      throw error;
    }

    const reviewId = crypto.randomUUID();
    const now = new Date().toISOString();
    const statements = [
      {
        sql: `INSERT INTO access_reviews (
                id, tenant_id, name, description, scope, scope_value, status, reviewer_id,
                total_items, reviewed_items, approved_items, revoked_items,
                created_at, started_at, due_date, created_by, inactive_days
              ) VALUES (?, ?, ?, ?, ?, ?, 'in_progress', ?, ?, 0, 0, 0, ?, ?, ?, ?, ?)`,
        params: [
          reviewId,
          tenantId,
          input.name,
          input.description ?? null,
          input.scope,
          scopeValue,
          adminId,
          items.length,
          now,
          now,
          dueDateIso(input.due_date),
          adminId,
          inactiveDays,
        ],
      },
      ...items.map((item) => ({
        sql: `INSERT INTO access_review_items (
                id, review_id, tenant_id, user_id, permission_type, permission_value,
                decision, created_at, store_ref, entitlement_ref
              ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
        params: [
          crypto.randomUUID(),
          reviewId,
          tenantId,
          item.userId,
          item.permissionType,
          item.permissionValue,
          now,
          item.storeRef,
          item.entitlementRef,
        ],
      })),
    ];
    // The review and its items are written together.
    await adapter.batch(statements);

    await createAuditLogFromContext(c, 'access_review.created', 'access_review', reviewId, {
      name: input.name,
      scope: input.scope,
      scope_value: scopeValue,
      inactive_days: inactiveDays,
      total_items: items.length,
    });

    const created = await loadReview(adapter, tenantId, reviewId);
    return c.json(serializeReview(created!), 201);
  } catch (error) {
    log.error('Failed to create access review', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/** GET /api/admin/compliance/access-reviews/:id */
export async function getAccessReview(c: Context<{ Bindings: Env }>) {
  const tenantId = getTenantIdFromContext(c);
  const reviewId = c.req.param('id')!;
  try {
    const adapter = reviewsAdapter(c, tenantId);
    const review = await loadReview(adapter, tenantId, reviewId);
    if (!review) return reviewNotFound(c, reviewId);
    const applied = await adapter.queryOne<{
      applied: number | null;
      failed: number | null;
      pending_revocations: number | null;
    }>(
      `SELECT SUM(CASE WHEN apply_status = 'applied' THEN 1 ELSE 0 END) AS applied,
              SUM(CASE WHEN apply_status IN ('failed', 'incomplete') THEN 1 ELSE 0 END) AS failed,
              SUM(CASE WHEN decision = 'revoked' AND (apply_status IS NULL OR apply_status <> 'applied')
                       THEN 1 ELSE 0 END) AS pending_revocations
         FROM access_review_items WHERE review_id = ? AND tenant_id = ?`,
      [reviewId, tenantId]
    );
    return c.json({
      ...serializeReview(review),
      application: {
        applied: Number(applied?.applied ?? 0),
        failed: Number(applied?.failed ?? 0),
        pending_revocations: Number(applied?.pending_revocations ?? 0),
      },
    });
  } catch (error) {
    getLogger(c)
      .module('ACCESS-REVIEW')
      .error('Failed to read access review', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/** Names and emails as they are now (display only; unknown ones are null). */
async function userLabels(
  c: Context<{ Bindings: Env }>,
  tenantId: string,
  userIds: string[]
): Promise<Map<string, { email: string | null; name: string | null }>> {
  const labels = new Map<string, { email: string | null; name: string | null }>();
  const routed = usesRoutedAccountStorage(getTenantMetadataContextFromHono(c));
  const defaults = routed
    ? null
    : {
        coreAdapter: createAuthContextFromHono(c, tenantId).coreAdapter,
        piiAdapter: createPIIContextFromHono(c, tenantId).defaultPiiAdapter,
      };
  const search = routed ? new CrossShardAccountExactSearchService(c.env) : null;
  await Promise.all(
    [...new Set(userIds)].map(async (userId) => {
      try {
        let adapters = defaults;
        if (!adapters) {
          // A routed account, wherever it lives, suspended or locked too (a review suspends).
          const [route] = await search!.find({
            tenantId,
            identifier: userId,
            purpose: 'admin_view',
          });
          if (!route || route.legacyUserId !== userId) throw new Error('account_not_found');
          adapters = {
            coreAdapter: bindingAdapter(c.env, route.coreBindingRef, 'core'),
            piiAdapter: bindingAdapter(c.env, route.piiBindingRef, 'pii'),
          };
        }
        const user = await new CanonicalRuntimeUserStore({ ...adapters, tenantId }).findById(
          userId,
          { includeInactive: true }
        );
        labels.set(userId, { email: user?.email ?? null, name: user?.name ?? null });
      } catch {
        labels.set(userId, { email: null, name: null });
      }
    })
  );
  return labels;
}

function bindingAdapter(env: Env, bindingRef: string, partition: 'core' | 'pii'): DatabaseAdapter {
  const source = (env as unknown as Record<string, unknown>)[bindingRef];
  if (!isDatabaseSource(source)) throw new Error('access_review_binding_unavailable');
  return ensureDatabaseAdapter(source, `access-review-${partition}`);
}

/** GET /api/admin/compliance/access-reviews/:id/items */
export async function listAccessReviewItems(c: Context<{ Bindings: Env }>) {
  const tenantId = getTenantIdFromContext(c);
  const reviewId = c.req.param('id')!;
  const limit = Math.min(Math.max(parseInt(c.req.query('limit') || '', 10) || 50, 1), MAX_LIMIT);
  const decision = c.req.query('decision');
  const where = ['review_id = ?', 'tenant_id = ?'];
  const params: unknown[] = [reviewId, tenantId];
  if (decision === 'pending') where.push('decision IS NULL');
  else if (decision === 'approved' || decision === 'revoked') {
    where.push('decision = ?');
    params.push(decision);
  } else if (decision !== undefined) {
    return invalid(c, 'decision', 'Must be pending, approved or revoked');
  }
  const cursor = c.req.query('cursor');
  if (cursor) {
    where.push('id > ?');
    params.push(cursor);
  }
  try {
    const adapter = reviewsAdapter(c, tenantId);
    if (!(await loadReview(adapter, tenantId, reviewId))) return reviewNotFound(c, reviewId);
    const rows = await adapter.query<AccessReviewItemRow>(
      `SELECT id, review_id, user_id, permission_type, permission_value, decision, decided_by,
              decided_at, justification, created_at, store_ref, entitlement_ref, apply_status,
              applied_at, apply_error
         FROM access_review_items WHERE ${where.join(' AND ')} ORDER BY id LIMIT ?`,
      [...params, limit + 1]
    );
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const labels = await userLabels(
      c,
      tenantId,
      page.map((row) => row.user_id)
    );
    return c.json({
      data: page.map((row) => ({
        item_id: row.id,
        user_id: row.user_id,
        user: labels.get(row.user_id) ?? { email: null, name: null },
        permission_type: row.permission_type,
        permission_value: row.permission_value,
        decision: row.decision === 'approved' || row.decision === 'revoked' ? row.decision : null,
        decided_by: row.decided_by,
        decided_at: toIso(row.decided_at),
        justification: row.justification,
        apply_status: row.apply_status,
        applied_at: toIso(row.applied_at),
        apply_error: row.apply_error,
      })),
      pagination: {
        has_more: hasMore,
        ...(hasMore && page.length > 0 ? { next_cursor: page[page.length - 1]!.id } : {}),
      },
    });
  } catch (error) {
    getLogger(c)
      .module('ACCESS-REVIEW')
      .error('Failed to list access review items', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

const DecisionSchema = z.object({
  item_ids: z.array(z.string().min(1).max(64)).min(1).max(MAX_LIMIT),
  decision: z.enum(['approved', 'revoked']),
  justification: z.string().max(1000).optional(),
});

const REVIEW_OPEN = `EXISTS (SELECT 1 FROM access_reviews r
                     WHERE r.id = ? AND r.tenant_id = ? AND r.status = 'in_progress')`;

function reviewClosed(c: Context<{ Bindings: Env }>) {
  return c.json(
    { error: 'access_review_closed', error_description: 'The review is not open' },
    409
  );
}

/**
 * POST /api/admin/compliance/access-reviews/:id/decisions
 *
 * Decides items of an open review. An item whose revocation is being applied or was applied keeps
 * its decision.
 */
export async function decideAccessReviewItems(c: Context<{ Bindings: Env }>) {
  const tenantId = getTenantIdFromContext(c);
  const reviewId = c.req.param('id')!;
  const body: unknown = await c.req.json().catch(() => null);
  const parsed = DecisionSchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return invalid(c, issue?.path.join('.') || 'body', issue?.message || 'Invalid value');
  }
  const adminId = getAdminAuth(c)?.userId;
  if (!adminId) return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  try {
    const adapter = reviewsAdapter(c, tenantId);
    const review = await loadReview(adapter, tenantId, reviewId);
    if (!review) return reviewNotFound(c, reviewId);
    if (review.status !== 'in_progress') return reviewClosed(c);
    const now = new Date().toISOString();
    const itemIds = [...new Set(parsed.data.item_ids)];
    // Each update holds only while the review is open and the item is not being or been applied.
    const results = await adapter.batch(
      itemIds.map((itemId) => ({
        sql: `UPDATE access_review_items
                 SET decision = ?, decided_by = ?, decided_at = ?, justification = ?,
                     apply_status = NULL, apply_error = NULL, apply_claimed_at = NULL
               WHERE id = ? AND review_id = ? AND tenant_id = ?
                 AND (apply_status IS NULL OR apply_status IN ('failed', 'skipped'))
                 AND ${REVIEW_OPEN}`,
        params: [
          parsed.data.decision,
          adminId,
          now,
          parsed.data.justification ?? null,
          itemId,
          reviewId,
          tenantId,
          reviewId,
          tenantId,
        ],
      }))
    );
    await refreshCounts(adapter, tenantId, reviewId);
    const updated = results.filter((result) => (result.rowsAffected ?? 0) > 0).length;
    await createAuditLogFromContext(c, 'access_review.decided', 'access_review', reviewId, {
      decision: parsed.data.decision,
      items: updated,
    });
    return c.json({
      updated,
      // Unknown items, ones being or been applied, or all when the review closed meanwhile.
      unchanged: itemIds.length - updated,
      review: serializeReview((await loadReview(adapter, tenantId, reviewId))!),
    });
  } catch (error) {
    getLogger(c)
      .module('ACCESS-REVIEW')
      .error('Failed to decide items', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/** What a revocation needs from the admin applying it, as the Admin API asks for it. */
function permissionFor(item: AccessReviewItemRow): string {
  return item.permission_type === 'account'
    ? ADMIN_PERMISSIONS.USERS_SUSPEND
    : ADMIN_PERMISSIONS.ROLES_WRITE;
}

async function applyRevocation(
  context: RevocationContext,
  admin: AdminAuthContext,
  item: AccessReviewItemRow,
  reviewId: string,
  firstAttemptAt: number,
  started: boolean
): Promise<{ status: 'applied' | 'failed'; error?: string }> {
  // The Admin API's own gates: the permission for the change, and for roles the hierarchy.
  if (!hasAdminPermission(admin.permissions ?? [], permissionFor(item))) {
    return { status: 'failed', error: 'insufficient_permissions' };
  }
  const details = { access_review_id: reviewId, access_review_item_id: item.id };
  // Stable per item (id and time), so an entry written by an interrupted attempt, and its copies,
  // are the ones a retry records.
  // One per application (its first attempt): a revocation applied again after it was decided
  // again is another entry.
  const audit = {
    id: `access-review.${reviewId}.${item.id}.${firstAttemptAt}`,
    at: firstAttemptAt,
  };
  if (item.permission_type === 'role') {
    const role = await context.adapter.queryOne<{ hierarchy_level: number }>(
      `SELECT r.hierarchy_level FROM role_assignments ra
         JOIN roles r ON r.id = ra.role_id AND r.tenant_id = ra.tenant_id
        WHERE ra.tenant_id = ? AND ra.id = ?`,
      [context.tenantId, item.entitlement_ref]
    );
    if (role && !canManageRoleHierarchy(admin, role.hierarchy_level)) {
      return { status: 'failed', error: 'insufficient_role_hierarchy' };
    }
    await removeRoleAssignment(context, {
      userId: item.user_id,
      assignmentId: item.entitlement_ref!,
      details,
      audit,
    });
    return { status: 'applied' };
  }
  if (item.permission_type === 'organization') {
    await removeOrganizationMembership(context, {
      userId: item.user_id,
      orgId: item.permission_value,
      details,
      audit,
    });
    return { status: 'applied' };
  }
  // An account suspended by another transition, deleted or not found has no access left to take.
  await suspendAccount(context, {
    userId: item.user_id,
    // Stable per item, and the version is the first attempt's, so applying again finishes the
    // same transition; a status change made after that attempt is newer and wins.
    operationId: `access-review:${reviewId}:${item.id}`,
    versionMs: firstAttemptAt,
    reasonCode: 'access_review',
    details,
    audit,
    started,
  });
  return { status: 'applied' };
}

const ITEM_COLUMNS = `id, review_id, user_id, permission_type, permission_value, decision, decided_by,
  decided_at, justification, created_at, store_ref, entitlement_ref, apply_status, applied_at,
  apply_error, apply_first_at`;

/**
 * Revocations left to apply: not yet tried, refused, started and not finished, or claimed by a
 * completion that stopped.
 */
const LEFT_TO_APPLY = `decision = 'revoked' AND (
  apply_status IS NULL OR apply_status IN ('failed', 'incomplete')
  OR (apply_status = 'applying' AND apply_claimed_at < ?)
)`;

/**
 * The store holding an item's entitlement: the one it was found in, or, when that store is no
 * longer the tenant's (moved to another placement), the one holding it now. None: it is gone.
 */
async function storeHolding(
  stores: Map<string, DatabaseAdapter>,
  tenantId: string,
  item: AccessReviewItemRow
): Promise<DatabaseAdapter | null> {
  const recorded = item.store_ref ? stores.get(item.store_ref) : undefined;
  if (recorded) return recorded;
  const [sql, params] =
    item.permission_type === 'role'
      ? [
          'SELECT 1 AS found FROM role_assignments WHERE tenant_id = ? AND id = ?',
          [tenantId, item.entitlement_ref],
        ]
      : item.permission_type === 'organization'
        ? [
            'SELECT 1 AS found FROM subject_org_membership WHERE tenant_id = ? AND org_id = ? AND subject_id = ?',
            [tenantId, item.permission_value, item.user_id],
          ]
        : [
            'SELECT 1 AS found FROM identity_accounts WHERE tenant_id = ? AND legacy_user_id = ?',
            [tenantId, item.user_id],
          ];
  for (const adapter of stores.values()) {
    if (await adapter.queryOne<{ found: number }>(sql as string, params as unknown[])) {
      return adapter;
    }
  }
  return null;
}

/**
 * POST /api/admin/compliance/access-reviews/:id/complete
 *
 * Applies the revocations (up to MAX_APPLIES_PER_REQUEST per request, those not yet tried first,
 * then failed ones from the longest ago) and completes the review once every item is decided and
 * every revocation is applied. Each item is claimed before it is applied, so a decision change,
 * a cancellation or another completion cannot run alongside it.
 */
export async function completeAccessReview(c: Context<{ Bindings: Env }>) {
  const tenantId = getTenantIdFromContext(c);
  const reviewId = c.req.param('id')!;
  const admin = getAdminAuth(c);
  if (!admin?.userId) return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  const log = getLogger(c).module('ACCESS-REVIEW');
  try {
    const adapter = reviewsAdapter(c, tenantId);
    const review = await loadReview(adapter, tenantId, reviewId);
    if (!review) return reviewNotFound(c, reviewId);
    if (review.status !== 'in_progress') return reviewClosed(c);
    const undecided = await adapter.queryOne<{ count: number }>(
      `SELECT COUNT(*) AS count FROM access_review_items
        WHERE review_id = ? AND tenant_id = ? AND decision IS NULL`,
      [reviewId, tenantId]
    );
    if (Number(undecided?.count ?? 0) > 0) {
      return c.json(
        {
          error: 'access_review_undecided_items',
          error_description: 'Every item must be approved or revoked before completing',
          undecided_items: Number(undecided?.count ?? 0),
        },
        409
      );
    }

    const now = () => new Date().toISOString();
    const staleBefore = () => new Date(Date.now() - APPLY_CLAIM_STALE_MS).toISOString();
    await adapter.execute(
      `UPDATE access_review_items SET apply_status = 'skipped', applied_at = ?
        WHERE review_id = ? AND tenant_id = ? AND decision = 'approved' AND apply_status IS NULL
          AND ${REVIEW_OPEN}`,
      [now(), reviewId, tenantId, reviewId, tenantId]
    );
    const toApply = await adapter.query<AccessReviewItemRow>(
      `SELECT ${ITEM_COLUMNS} FROM access_review_items
        WHERE review_id = ? AND tenant_id = ? AND ${LEFT_TO_APPLY}
        ORDER BY CASE WHEN apply_status IS NULL THEN 0 ELSE 1 END,
                 COALESCE(applied_at, apply_claimed_at, ''), id
        LIMIT ?`,
      [reviewId, tenantId, staleBefore(), MAX_APPLIES_PER_REQUEST]
    );

    const stores = new Map(
      (toApply.length > 0 ? await tenantCoreStores(c.env, tenantId) : []).map((store) => [
        store.bindingRef,
        store.adapter,
      ])
    );
    let applied = 0;
    let failed = 0;
    for (const item of toApply) {
      const claimedAt = now();
      const claim = await adapter.execute(
        `UPDATE access_review_items
            SET apply_status = 'applying', apply_claimed_at = ?,
                apply_first_at = COALESCE(apply_first_at, ?), apply_attempts = apply_attempts + 1
          WHERE id = ? AND review_id = ? AND tenant_id = ? AND ${LEFT_TO_APPLY}
            AND ${REVIEW_OPEN}`,
        [claimedAt, claimedAt, item.id, reviewId, tenantId, staleBefore(), reviewId, tenantId]
      );
      // Decided otherwise, taken by another completion, or the review closed meanwhile.
      if ((claim.rowsAffected ?? 0) === 0) continue;
      // The first attempt's time as stored: another completion may have made the first attempt
      // after this one read the item.
      const claimed = await adapter.queryOne<{
        apply_first_at: string | null;
        apply_attempts: number;
      }>(
        `SELECT apply_first_at, apply_attempts FROM access_review_items
          WHERE id = ? AND review_id = ? AND tenant_id = ? AND apply_claimed_at = ?`,
        [item.id, reviewId, tenantId, claimedAt],
        { consistencyClass: 'primary_required' }
      );
      const firstAttemptAt = claimed?.apply_first_at ?? claimedAt;
      // An earlier attempt left it started (incomplete, or stopped while applying; a refusal that
      // changed nothing clears the count): what that attempt changed must be finished, so the
      // item stays started whatever this attempt does.
      const started = Number(claimed?.apply_attempts ?? 0) > 1;

      let result: { status: 'applied' | 'incomplete' | 'failed'; error?: string };
      // The store holding it now; when no store holds it any more, the tenant's default store,
      // where removing it again finds nothing and finishes the rest (caches, audit).
      const store = (await storeHolding(stores, tenantId, item)) ?? adapter;
      {
        try {
          result = await applyRevocation(
            {
              env: c.env,
              tenantId,
              adapter: store,
              log,
              audit: (action, resource, resourceId, details, stable) =>
                createAuditLogFromContext(
                  c,
                  action,
                  resource,
                  resourceId,
                  details,
                  'info',
                  stable?.id,
                  stable?.at
                ),
              // A cache left behind keeps the revoked access in new tokens: apply it again.
              onCacheFailure: 'throw',
            },
            admin,
            item,
            reviewId,
            Date.parse(firstAttemptAt),
            started
          );
        } catch (error) {
          if (error instanceof AccountLifecycleSupersededError) {
            // A status change made after this revocation was first tried decides the account:
            // nothing of this one is left in effect. Refused, so it can be decided again; a new
            // attempt is a new transition (its first attempt is cleared below).
            result = { status: 'failed', error: 'lifecycle_superseded' };
          } else {
            log.warn('Access review revocation failed', {
              reviewId,
              itemId: item.id,
              errorType: error instanceof Error ? error.message : 'Unknown',
            });
            // It may have changed something before it stopped: finish it on the next
            // completion, and keep its decision.
            result = { status: 'incomplete', error: 'revocation_failed' };
          }
        }
      }
      // Refused before changing anything this time, but started before (by an admin who could):
      // still left to finish.
      if (started && result.status === 'failed' && result.error !== 'lifecycle_superseded') {
        result = { status: 'incomplete', error: result.error };
      }
      if (result.status === 'applied') applied += 1;
      else failed += 1;
      await adapter.execute(
        `UPDATE access_review_items
            SET apply_status = ?, applied_at = ?, apply_error = ?,
                apply_first_at = CASE WHEN ? = 'failed' THEN NULL ELSE apply_first_at END,
                apply_attempts = CASE WHEN ? = 'failed' THEN 0 ELSE apply_attempts END
          WHERE id = ? AND review_id = ? AND tenant_id = ?
            AND apply_status = 'applying' AND apply_claimed_at = ?`,
        [
          result.status,
          now(),
          result.error ?? null,
          result.status,
          result.status,
          item.id,
          reviewId,
          tenantId,
          claimedAt,
        ]
      );
    }

    // Completed only if, at this moment, every item is decided and every revocation applied.
    const completion = await adapter.execute(
      `UPDATE access_reviews SET status = 'completed', completed_at = ?, completed_by = ?
        WHERE tenant_id = ? AND id = ? AND status = 'in_progress'
          AND NOT EXISTS (
            SELECT 1 FROM access_review_items i
             WHERE i.review_id = ? AND i.tenant_id = ?
               AND (i.decision IS NULL
                    OR (i.decision = 'revoked' AND (i.apply_status IS NULL OR i.apply_status <> 'applied')))
          )`,
      [now(), admin.userId, tenantId, reviewId, reviewId, tenantId]
    );
    const completed = (completion.rowsAffected ?? 0) > 0;
    if (completed) {
      await createAuditLogFromContext(c, 'access_review.completed', 'access_review', reviewId, {
        revoked_items: review.revoked_items,
        approved_items: review.approved_items,
      });
    }
    const remaining = await adapter.queryOne<{ count: number }>(
      `SELECT COUNT(*) AS count FROM access_review_items
        WHERE review_id = ? AND tenant_id = ? AND decision = 'revoked'
          AND (apply_status IS NULL OR apply_status <> 'applied')`,
      [reviewId, tenantId]
    );
    return c.json({
      completed,
      applied,
      failed,
      // Revocations not applied yet (failed and in progress included); complete again to continue.
      remaining: Number(remaining?.count ?? 0),
      review: serializeReview((await loadReview(adapter, tenantId, reviewId))!),
    });
  } catch (error) {
    log.error('Failed to complete access review', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/** POST /api/admin/compliance/access-reviews/:id/cancel */
export async function cancelAccessReview(c: Context<{ Bindings: Env }>) {
  const tenantId = getTenantIdFromContext(c);
  const reviewId = c.req.param('id')!;
  try {
    const adapter = reviewsAdapter(c, tenantId);
    const review = await loadReview(adapter, tenantId, reviewId);
    if (!review) return reviewNotFound(c, reviewId);
    // Only while open and nothing is being or was applied (once revocations were made the review
    // is completed, not cancelled) — checked in the same statement that cancels.
    const cancelled = await adapter.execute(
      `UPDATE access_reviews SET status = 'cancelled', completed_at = ?
        WHERE tenant_id = ? AND id = ? AND status = 'in_progress'
          AND NOT EXISTS (
            SELECT 1 FROM access_review_items i
             WHERE i.review_id = ? AND i.tenant_id = ?
               AND i.apply_status IN ('applying', 'applied', 'incomplete')
          )`,
      [new Date().toISOString(), tenantId, reviewId, reviewId, tenantId]
    );
    if ((cancelled.rowsAffected ?? 0) === 0) {
      return c.json(
        { error: 'access_review_closed', error_description: 'The review cannot be cancelled' },
        409
      );
    }
    await createAuditLogFromContext(c, 'access_review.cancelled', 'access_review', reviewId, {});
    return c.json(serializeReview((await loadReview(adapter, tenantId, reviewId))!));
  } catch (error) {
    getLogger(c)
      .module('ACCESS-REVIEW')
      .error('Failed to cancel access review', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}
