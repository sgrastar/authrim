import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error node:sqlite is available in the required runtime but this package omits Node types.
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveStores: vi.fn(),
  audit: vi.fn(),
  removeRoleAssignment: vi.fn(),
  removeOrganizationMembership: vi.fn(),
  suspendAccount: vi.fn(),
  lastLoginAt: vi.fn(),
  reviewsAdapter: null as unknown,
  storeAdapters: new Map<string, unknown>(),
  findById: vi.fn(),
  routed: false,
  exactSearch: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getTenantIdFromContext: vi.fn(() => 'tenant-a'),
    createAuthContextFromHono: vi.fn(() => ({ coreAdapter: mocks.reviewsAdapter })),
    createPIIContextFromHono: vi.fn(() => ({ defaultPiiAdapter: {} })),
    getTenantMetadataContextFromHono: vi.fn(() =>
      mocks.routed ? { route: { allocationScope: 'shared_pool' } } : { route: {} }
    ),
    isDatabaseSource: vi.fn(() => true),
    createAuditLogFromContext: mocks.audit,
    resolveTenantAssignedDatabaseSourcesFromRegistry: mocks.resolveStores,
    ensureDatabaseAdapter: vi.fn((source: { ref: string }) => mocks.storeAdapters.get(source.ref)),
    getSessionRevocationStore: vi.fn((_env: unknown, _tenant: string, userId: string) => ({
      getLastLoginAtRpc: () => mocks.lastLoginAt(userId),
    })),
    CanonicalRuntimeUserStore: class {
      findById(userId: string) {
        return mocks.findById(userId);
      }
    },
    getLogger: vi.fn(() => ({
      module: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
    })),
    createErrorResponse: vi.fn((c, code) =>
      c.json(
        { error: code },
        code === actual.AR_ERROR_CODES.INTERNAL_ERROR
          ? 500
          : code === actual.AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND
            ? 404
            : code === actual.AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS
              ? 403
              : 400
      )
    ),
  };
});
vi.mock('../cross-shard-account-list', () => ({
  CrossShardAccountExactSearchService: class {
    find(input: unknown) {
      return mocks.exactSearch(input);
    }
  },
}));
vi.mock('../access-revocation', () => ({
  AccountLifecycleSupersededError: class extends Error {
    constructor() {
      super('account_lifecycle_superseded');
    }
  },
  removeRoleAssignment: mocks.removeRoleAssignment,
  removeOrganizationMembership: mocks.removeOrganizationMembership,
  suspendAccount: mocks.suspendAccount,
}));

import {
  cancelAccessReview,
  completeAccessReview,
  createAccessReview,
  decideAccessReviewItems,
  getAccessReview,
  listAccessReviewItems,
  listAccessReviews,
  MAX_APPLIES_PER_REQUEST,
  MAX_LAST_LOGIN_LOOKUPS,
  MAX_REVIEW_ITEMS,
} from '../compliance/access-reviews';

// ---------------------------------------------------------------------------
// Real SQLite from the core migrations: the reviews' tables and each store's.
// ---------------------------------------------------------------------------

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const CORE_SCHEMA = [
  readFileSync(resolve(REPO_ROOT, 'migrations/core/d1/001_0_4_0_core_baseline.sql'), 'utf8')
    .replaceAll('__AUTHRIM_NOW_EPOCH_MILLISECONDS__', '(unixepoch() * 1000)')
    .replaceAll('__AUTHRIM_NOW_EPOCH_SECONDS__', 'unixepoch()'),
  ...['002_guest_account_lifecycle', '003_account_registration_state'].map((name) =>
    readFileSync(resolve(REPO_ROOT, `migrations/core/d1/${name}.sql`), 'utf8')
  ),
  readFileSync(resolve(REPO_ROOT, 'migrations/core/d1/014_access_review_apply.sql'), 'utf8'),
];

type SqlValue = string | number | null;
const values = (params: unknown[] = []) =>
  params.map((value): SqlValue => (value === undefined ? null : (value as SqlValue)));

function sqliteStore() {
  const db = new DatabaseSync(':memory:');
  for (const sql of CORE_SCHEMA) db.exec(sql);
  // Rows here stand alone (no users_core or identity graph behind them).
  db.exec('PRAGMA foreign_keys = OFF');
  const adapter = {
    db,
    async query(sql: string, params?: unknown[]) {
      return db.prepare(sql).all(...values(params));
    },
    async queryOne(sql: string, params?: unknown[]) {
      return db.prepare(sql).get(...values(params)) ?? null;
    },
    async execute(sql: string, params?: unknown[]) {
      const result = db.prepare(sql).run(...values(params));
      return { success: true, rowsAffected: Number(result.changes) };
    },
    async batch(statements: Array<{ sql: string; params?: unknown[] }>) {
      db.exec('BEGIN');
      try {
        const results = statements.map(({ sql, params }) => ({
          success: true,
          rowsAffected: Number(db.prepare(sql).run(...values(params)).changes),
        }));
        db.exec('COMMIT');
        return results;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  };
  return adapter;
}

type Store = ReturnType<typeof sqliteStore>;

function addRole(store: Store, id: string, hierarchy = 10) {
  store.db
    .prepare(
      `INSERT INTO roles (id, tenant_id, name, permissions_json, hierarchy_level, created_at, updated_at)
       VALUES (?, 'tenant-a', ?, '[]', ?, 0, 0)`
    )
    .run(id, id, hierarchy);
}

function assign(store: Store, id: string, userId: string, roleId = 'role-admin') {
  store.db
    .prepare(
      `INSERT INTO role_assignments (id, tenant_id, subject_id, role_id, created_at, updated_at)
       VALUES (?, 'tenant-a', ?, ?, 0, 0)`
    )
    .run(id, userId, roleId);
}

function account(store: Store, userId: string, metadata: Record<string, unknown> | null = null) {
  store.db
    .prepare(
      `INSERT INTO identity_accounts (id, tenant_id, account_type, lifecycle_state, legacy_user_id,
         metadata_json, created_at, updated_at)
       VALUES (?, 'tenant-a', 'user', 'active', ?, ?, 0, 0)`
    )
    .run(`account:${userId}`, userId, metadata ? JSON.stringify(metadata) : null);
}

function items(reviews: Store): Array<Record<string, any>> {
  return reviews.db.prepare('SELECT * FROM access_review_items ORDER BY id').all();
}

const ALL_PERMISSIONS = ['*'];

function context(
  options: {
    body?: unknown;
    params?: Record<string, string>;
    query?: Record<string, string>;
    permissions?: string[];
    env?: Record<string, unknown>;
  } = {}
) {
  const store = new Map<string, unknown>([
    [
      'adminAuth',
      {
        userId: 'admin-1',
        hierarchyLevel: 50,
        permissions: options.permissions ?? ALL_PERMISSIONS,
      },
    ],
  ]);
  return {
    get: vi.fn((key: string) => store.get(key)),
    set: vi.fn((key: string, value: unknown) => store.set(key, value)),
    req: {
      param: vi.fn((name: string) => options.params?.[name]),
      query: vi.fn((name: string) => options.query?.[name]),
      json: vi.fn().mockResolvedValue(options.body ?? {}),
    },
    env: options.env ?? {},
    json: vi.fn((value: unknown, status = 200) => Response.json(value, { status })),
  } as never;
}

async function json(response: Response) {
  return (await response.json()) as Record<string, any>;
}

describe('access reviews', () => {
  let reviews: Store;
  let db: Store;
  let users1: Store;

  beforeEach(() => {
    vi.clearAllMocks();
    reviews = sqliteStore();
    addRole(reviews, 'role-admin');
    reviews.db
      .prepare(
        `INSERT INTO organizations (id, tenant_id, name, created_at, updated_at)
         VALUES ('org-1', 'tenant-a', 'org-1', 0, 0)`
      )
      .run();
    db = sqliteStore();
    users1 = sqliteStore();
    for (const store of [db, users1]) addRole(store, 'role-admin');
    assign(db, 'ra-1', 'user-1');
    assign(users1, 'ra-2', 'user-2');
    mocks.reviewsAdapter = reviews;
    mocks.storeAdapters.clear();
    mocks.storeAdapters.set('DB', db);
    mocks.storeAdapters.set('DB_USERS_1', users1);
    mocks.resolveStores.mockResolvedValue([
      { source: { ref: 'DB' }, bindingRef: 'DB' },
      { source: { ref: 'DB_USERS_1' }, bindingRef: 'DB_USERS_1' },
    ]);
    mocks.audit.mockResolvedValue(undefined);
    mocks.removeRoleAssignment.mockResolvedValue('removed');
    mocks.removeOrganizationMembership.mockResolvedValue('removed');
    mocks.suspendAccount.mockResolvedValue('suspended');
    mocks.lastLoginAt.mockResolvedValue(null);
    mocks.routed = false;
    mocks.findById.mockImplementation(async (userId: string) => ({
      email: `${userId}@example.com`,
      name: userId,
    }));
  });

  async function createRoleReview() {
    const response = await createAccessReview(
      context({
        body: {
          name: 'Q4 admins',
          scope: 'role',
          scope_value: 'role-admin',
          due_date: '2026-12-31',
        },
      })
    );
    expect(response.status).toBe(201);
    return json(response);
  }

  async function decide(reviewId: string, itemIds: string[], decision: 'approved' | 'revoked') {
    return json(
      await decideAccessReviewItems(
        context({ params: { id: reviewId }, body: { item_ids: itemIds, decision } })
      )
    );
  }

  it('snapshots a role review over every store, keeping where each assignment lives', async () => {
    const review = await createRoleReview();
    expect(review).toMatchObject({
      scope: 'role',
      status: 'in_progress',
      created_by: 'admin-1',
      due_date: '2026-12-31T23:59:59.999Z',
      progress: { total_items: 2, reviewed_items: 0 },
    });
    expect(
      items(reviews).map((item) => [item.user_id, item.entitlement_ref, item.store_ref])
    ).toEqual(
      expect.arrayContaining([
        ['user-1', 'ra-1', 'DB'],
        ['user-2', 'ra-2', 'DB_USERS_1'],
      ])
    );
  });

  it('reads a database named by two assignments once', async () => {
    mocks.resolveStores.mockResolvedValue([
      { source: { ref: 'DB' }, bindingRef: 'DB' },
      { source: { ref: 'DB' }, bindingRef: 'DB' },
    ]);
    const review = await createRoleReview();
    expect(review.progress.total_items).toBe(1);
  });

  it('refuses a review without what its scope needs, of an unknown role, or too large', async () => {
    expect((await createAccessReview(context({ body: { name: 'x', scope: 'role' } }))).status).toBe(
      400
    );
    expect(
      (await createAccessReview(context({ body: { name: 'x', scope: 'role', scope_value: 'no' } })))
        .status
    ).toBe(400);
    for (let i = 0; i <= MAX_REVIEW_ITEMS; i += 1) assign(db, `ra-big-${i}`, `user-big-${i}`);
    const tooLarge = await createAccessReview(
      context({ body: { name: 'x', scope: 'role', scope_value: 'role-admin' } })
    );
    expect(tooLarge.status).toBe(400);
    expect(await json(tooLarge)).toMatchObject({ error: 'access_review_too_large' });
    expect(reviews.db.prepare('SELECT COUNT(*) AS n FROM access_reviews').get()).toEqual({ n: 0 });
  });

  it('finds inactive users beyond the first page, by their recorded sign-in', async () => {
    const now = Date.now();
    // More recent accounts than one page, then two without a recent sign-in on the account.
    for (let i = 0; i < 600; i += 1) {
      account(db, `a-recent-${String(i).padStart(4, '0')}`, { last_login_at: now });
    }
    account(db, 'z-active-by-session');
    account(db, 'z-stale');
    mocks.lastLoginAt.mockImplementation(async (userId: string) =>
      userId === 'z-active-by-session' ? now - 86400000 : now - 200 * 86400000
    );
    const response = await createAccessReview(
      context({ body: { name: 'Inactive', scope: 'inactive_users', inactive_days: 30 } })
    );
    expect(response.status).toBe(201);
    expect(items(reviews).map((item) => item.user_id)).toEqual(['z-stale']);
    // Only the accounts that show no recent sign-in are looked up.
    expect(mocks.lastLoginAt).toHaveBeenCalledTimes(2);
  });

  it('judges the size of an inactive review by the users found, not those looked up', async () => {
    const now = Date.now();
    for (let i = 0; i < MAX_REVIEW_ITEMS + 10; i += 1)
      account(db, `u-${String(i).padStart(5, '0')}`);
    mocks.lastLoginAt.mockResolvedValue(now);
    const response = await createAccessReview(
      context({ body: { name: 'Inactive', scope: 'inactive_users' } })
    );
    expect(response.status).toBe(201);
    expect((await json(response)).progress.total_items).toBe(0);
  });

  it('stops an inactive review that needs more sign-in lookups than allowed', async () => {
    const insert = db.db.prepare(
      `INSERT INTO identity_accounts (id, tenant_id, account_type, lifecycle_state, legacy_user_id,
         created_at, updated_at) VALUES (?, 'tenant-a', 'user', 'active', ?, 0, 0)`
    );
    for (let i = 0; i <= MAX_LAST_LOGIN_LOOKUPS; i += 1) {
      insert.run(`account:l-${i}`, `l-${String(i).padStart(5, '0')}`);
    }
    mocks.lastLoginAt.mockResolvedValue(Date.now());
    const response = await createAccessReview(
      context({ body: { name: 'Inactive', scope: 'inactive_users' } })
    );
    expect(response.status).toBe(400);
    expect(await json(response)).toMatchObject({ error: 'access_review_scan_limit' });
  });

  it('records decisions with who made them, and lists items with current names', async () => {
    const review = await createRoleReview();
    const [first, second] = items(reviews);
    const decided = await json(
      await decideAccessReviewItems(
        context({
          params: { id: review.review_id },
          body: { item_ids: [first!.id], decision: 'revoked', justification: 'Left the team' },
        })
      )
    );
    expect(decided).toMatchObject({ updated: 1, review: { progress: { revoked_items: 1 } } });
    expect(items(reviews).find((item) => item.id === first!.id)).toMatchObject({
      decision: 'revoked',
      decided_by: 'admin-1',
      justification: 'Left the team',
    });
    const listed = await json(
      await listAccessReviewItems(context({ params: { id: review.review_id } }))
    );
    expect(listed.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ item_id: first!.id, decision: 'revoked' }),
        expect.objectContaining({ item_id: second!.id, decision: null }),
      ])
    );
    expect(listed.data[0].user.email).toMatch(/@example\.com$/u);
  });

  it('completes only once every item is decided, applying revocations in their stores', async () => {
    const review = await createRoleReview();
    const [first, second] = items(reviews);
    await decide(review.review_id, [first!.id], 'revoked');
    const early = await completeAccessReview(context({ params: { id: review.review_id } }));
    expect(early.status).toBe(409);
    await decide(review.review_id, [second!.id], 'approved');
    const done = await json(
      await completeAccessReview(context({ params: { id: review.review_id } }))
    );
    expect(done).toMatchObject({ completed: true, applied: 1, failed: 0, remaining: 0 });
    expect(mocks.removeRoleAssignment).toHaveBeenCalledWith(
      expect.objectContaining({
        adapter: first!.store_ref === 'DB' ? db : users1,
        onCacheFailure: 'throw',
      }),
      expect.objectContaining({
        userId: first!.user_id,
        assignmentId: first!.entitlement_ref,
        // One entry per application of the item: its first attempt names it.
        audit: {
          id: `access-review.${review.review_id}.${first!.id}.${Date.parse(
            items(reviews).find((item) => item.id === first!.id)!.apply_first_at
          )}`,
          at: Date.parse(items(reviews).find((item) => item.id === first!.id)!.apply_first_at),
        },
      })
    );
    expect(items(reviews).find((item) => item.id === second!.id)).toMatchObject({
      apply_status: 'skipped',
    });
    expect(reviews.db.prepare('SELECT status, completed_by FROM access_reviews').get()).toEqual({
      status: 'completed',
      completed_by: 'admin-1',
    });
  });

  it('holds decisions and cancellation off while a revocation is being applied', async () => {
    const review = await createRoleReview();
    const all = items(reviews).map((item) => item.id);
    await decide(review.review_id, all, 'revoked');
    let during: Record<string, unknown> = {};
    mocks.removeRoleAssignment.mockImplementationOnce(async (_context, input) => {
      const item = items(reviews).find((row) => row.entitlement_ref === input.assignmentId)!;
      during = {
        status: item.apply_status,
        change: await decide(review.review_id, [item.id], 'approved'),
        cancel: (await cancelAccessReview(context({ params: { id: review.review_id } }))).status,
      };
      return 'removed';
    });
    await completeAccessReview(context({ params: { id: review.review_id } }));
    expect(during).toMatchObject({ status: 'applying', change: { updated: 0 }, cancel: 409 });
    expect(items(reviews).every((item) => item.decision === 'revoked')).toBe(true);
  });

  it('applies nothing for a review cancelled before its completion claims an item', async () => {
    const review = await createRoleReview();
    await decide(
      review.review_id,
      items(reviews).map((item) => item.id),
      'revoked'
    );
    expect((await cancelAccessReview(context({ params: { id: review.review_id } }))).status).toBe(
      200
    );
    expect((await completeAccessReview(context({ params: { id: review.review_id } }))).status).toBe(
      409
    );
    expect(mocks.removeRoleAssignment).not.toHaveBeenCalled();
  });

  it('refuses a revocation the admin could not make through the Admin API', async () => {
    const review = await createRoleReview();
    await decide(
      review.review_id,
      items(reviews).map((item) => item.id),
      'revoked'
    );
    const done = await json(
      await completeAccessReview(
        context({ params: { id: review.review_id }, permissions: ['admin:users:read'] })
      )
    );
    expect(done).toMatchObject({ completed: false, failed: 2 });
    expect(items(reviews)[0]).toMatchObject({ apply_error: 'insufficient_permissions' });
    expect(mocks.removeRoleAssignment).not.toHaveBeenCalled();

    // A role above the admin: refused as the Admin API refuses it.
    db.db.prepare("UPDATE roles SET hierarchy_level = 90 WHERE id = 'role-admin'").run();
    users1.db.prepare("UPDATE roles SET hierarchy_level = 90 WHERE id = 'role-admin'").run();
    const again = await json(
      await completeAccessReview(context({ params: { id: review.review_id } }))
    );
    expect(again).toMatchObject({ completed: false, failed: 2 });
    expect(items(reviews)[0]).toMatchObject({ apply_error: 'insufficient_role_hierarchy' });
  });

  it('retries failures without letting them block revocations not tried yet', async () => {
    for (let i = 0; i <= MAX_APPLIES_PER_REQUEST; i += 1) {
      assign(db, `ra-x-${String(i).padStart(4, '0')}`, `user-x-${i}`);
    }
    const review = await createRoleReview();
    const all = items(reviews);
    await decide(
      review.review_id,
      all.slice(0, 100).map((item) => item.id),
      'revoked'
    );
    await decide(
      review.review_id,
      all.slice(100).map((item) => item.id),
      'revoked'
    );
    // Everything fails on the first completion.
    mocks.removeRoleAssignment.mockRejectedValue(new Error('D1_ERROR'));
    const first = await json(
      await completeAccessReview(context({ params: { id: review.review_id } }))
    );
    expect(first).toMatchObject({ completed: false, failed: MAX_APPLIES_PER_REQUEST });
    const untried = items(reviews).filter((item) => item.apply_status === null);
    expect(untried.length).toBe(all.length - MAX_APPLIES_PER_REQUEST);

    mocks.removeRoleAssignment.mockResolvedValue('removed');
    const second = await json(
      await completeAccessReview(context({ params: { id: review.review_id } }))
    );
    // The ones not tried yet go first.
    for (const item of untried) {
      expect(items(reviews).find((row) => row.id === item.id)).toMatchObject({
        apply_status: 'applied',
      });
    }
    expect(second.completed).toBe(false);
    const third = await json(
      await completeAccessReview(context({ params: { id: review.review_id } }))
    );
    expect(third).toMatchObject({ completed: true, remaining: 0 });
  });

  it('takes over a claim left by a completion that stopped', async () => {
    const review = await createRoleReview();
    await decide(
      review.review_id,
      items(reviews).map((item) => item.id),
      'revoked'
    );
    reviews.db
      .prepare(
        "UPDATE access_review_items SET apply_status = 'applying', apply_claimed_at = '2000-01-01T00:00:00.000Z'"
      )
      .run();
    const done = await json(
      await completeAccessReview(context({ params: { id: review.review_id } }))
    );
    expect(done).toMatchObject({ completed: true, applied: 2 });

    // A fresh claim is not taken over.
    const other = await createRoleReview();
    await decide(
      other.review_id,
      items(reviews)
        .filter((i) => i.review_id === other.review_id)
        .map((i) => i.id),
      'revoked'
    );
    reviews.db
      .prepare(
        `UPDATE access_review_items SET apply_status = 'applying', apply_claimed_at = ?
          WHERE review_id = ?`
      )
      .run(new Date().toISOString(), other.review_id);
    const blocked = await json(
      await completeAccessReview(context({ params: { id: other.review_id } }))
    );
    expect(blocked).toMatchObject({ completed: false, applied: 0, remaining: 2 });
  });

  it('suspends revoked accounts with an operation stable per item', async () => {
    account(db, 'user-9');
    mocks.resolveStores.mockResolvedValue([{ source: { ref: 'DB' }, bindingRef: 'DB' }]);
    const created = await json(
      await createAccessReview(context({ body: { name: 'All', scope: 'all_users' } }))
    );
    const [item] = items(reviews);
    await decide(created.review_id, [item!.id], 'revoked');
    await completeAccessReview(context({ params: { id: created.review_id } }));
    // Its version is the first attempt's: a status change made after that is newer and wins.
    const firstAttemptAt = items(reviews)[0]!.apply_first_at;
    expect(mocks.suspendAccount).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        userId: 'user-9',
        operationId: `access-review:${created.review_id}:${item!.id}`,
        versionMs: Date.parse(firstAttemptAt),
        reasonCode: 'access_review',
      })
    );
  });

  it('lets a revocation a newer status change superseded be decided again', async () => {
    account(db, 'user-9');
    mocks.resolveStores.mockResolvedValue([{ source: { ref: 'DB' }, bindingRef: 'DB' }]);
    const created = await json(
      await createAccessReview(context({ body: { name: 'All', scope: 'all_users' } }))
    );
    const [item] = items(reviews);
    await decide(created.review_id, [item!.id], 'revoked');
    const { AccountLifecycleSupersededError } = await import('../access-revocation');
    mocks.suspendAccount.mockRejectedValueOnce(new AccountLifecycleSupersededError());
    await completeAccessReview(context({ params: { id: created.review_id } }));
    // Nothing of it is left in effect: refused, with its first attempt cleared for a new one.
    expect(items(reviews)[0]).toMatchObject({
      apply_status: 'failed',
      apply_error: 'lifecycle_superseded',
      apply_first_at: null,
    });
    expect(await decide(created.review_id, [item!.id], 'approved')).toMatchObject({
      updated: 1,
    });
  });

  it('reads a review with its application state, and pages the list', async () => {
    const review = await createRoleReview();
    const detail = await json(await getAccessReview(context({ params: { id: review.review_id } })));
    expect(detail).toMatchObject({
      application: { applied: 0, failed: 0, pending_revocations: 0 },
    });
    expect((await getAccessReview(context({ params: { id: 'missing' } }))).status).toBe(404);
    await createRoleReview();
    const page = await json(await listAccessReviews(context({ query: { limit: '1' } })));
    expect(page.data).toHaveLength(1);
    const next = await json(
      await listAccessReviews(
        context({ query: { limit: '1', cursor: page.pagination.next_cursor } })
      )
    );
    expect(next.data).toHaveLength(1);
    expect(next.data[0].review_id).not.toBe(page.data[0].review_id);
    expect((await listAccessReviews(context({ query: { cursor: 'bad' } }))).status).toBe(400);
  });

  it('keeps the decision of a revocation that started and did not finish, and retries it', async () => {
    const review = await createRoleReview();
    const [first] = items(reviews);
    await decide(
      review.review_id,
      items(reviews).map((item) => item.id),
      'revoked'
    );
    mocks.removeRoleAssignment.mockRejectedValueOnce(new Error('access_cache_invalidation_failed'));
    await completeAccessReview(context({ params: { id: review.review_id } }));
    const stuck = items(reviews).find((item) => item.apply_status === 'incomplete')!;
    // It may have removed the access already: neither approving it nor cancelling abandons it.
    expect(await decide(review.review_id, [stuck.id], 'approved')).toMatchObject({ updated: 0 });
    expect((await cancelAccessReview(context({ params: { id: review.review_id } }))).status).toBe(
      409
    );

    const done = await json(
      await completeAccessReview(context({ params: { id: review.review_id } }))
    );
    expect(done).toMatchObject({ completed: true });
    // Retried with the audit id and time of its first attempt.
    const calls = mocks.removeRoleAssignment.mock.calls.filter(
      ([, input]) => input.assignmentId === stuck.entitlement_ref
    );
    expect(calls).toHaveLength(2);
    expect(calls[1]![1].audit).toEqual(calls[0]![1].audit);
    expect(first).toBeDefined();
  });

  it('finishes a started suspension that a later suspension replaced', async () => {
    account(db, 'user-9');
    mocks.resolveStores.mockResolvedValue([{ source: { ref: 'DB' }, bindingRef: 'DB' }]);
    const created = await json(
      await createAccessReview(context({ body: { name: 'All', scope: 'all_users' } }))
    );
    const [item] = items(reviews);
    await decide(created.review_id, [item!.id], 'revoked');
    mocks.suspendAccount.mockRejectedValueOnce(new Error('access_cache_invalidation_failed'));
    await completeAccessReview(context({ params: { id: created.review_id } }));
    await completeAccessReview(context({ params: { id: created.review_id } }));
    // The retry says the suspension started, so what it left undone is finished.
    expect(mocks.suspendAccount.mock.calls.map(([, input]) => input.started)).toEqual([
      false,
      true,
    ]);
  });

  it('keeps a started revocation started when an admin who may not apply it retries', async () => {
    const review = await createRoleReview();
    await decide(
      review.review_id,
      items(reviews).map((item) => item.id),
      'revoked'
    );
    mocks.removeRoleAssignment.mockRejectedValueOnce(new Error('access_cache_invalidation_failed'));
    await completeAccessReview(context({ params: { id: review.review_id } }));
    const stuck = items(reviews).find((item) => item.apply_status === 'incomplete')!;
    // Refused for this admin, but what the first attempt changed is still to be finished.
    await completeAccessReview(
      context({ params: { id: review.review_id }, permissions: ['admin:users:read'] })
    );
    expect(items(reviews).find((item) => item.id === stuck.id)).toMatchObject({
      apply_status: 'incomplete',
      apply_error: 'insufficient_permissions',
    });
    expect(await decide(review.review_id, [stuck.id], 'approved')).toMatchObject({ updated: 0 });
    expect((await cancelAccessReview(context({ params: { id: review.review_id } }))).status).toBe(
      409
    );
  });

  it("audits with the first attempt's time as stored, even one made by another completion", async () => {
    const review = await createRoleReview();
    await decide(
      review.review_id,
      items(reviews).map((item) => item.id),
      'revoked'
    );
    // Between this completion reading the items and claiming one, another completion tried it
    // first (and stopped).
    const firstElsewhere = '2026-01-01T00:00:00.000Z';
    const execute = reviews.execute.bind(reviews);
    let raced = false;
    reviews.execute = async (sql: string, params?: unknown[]) => {
      if (!raced && sql.includes("SET apply_status = 'applying'")) {
        raced = true;
        reviews.db
          .prepare(
            `UPDATE access_review_items SET apply_status = 'incomplete', apply_first_at = ?
              WHERE id = ?`
          )
          .run(firstElsewhere, params![2] as string);
      }
      return execute(sql, params);
    };
    await completeAccessReview(context({ params: { id: review.review_id } }));
    expect(mocks.removeRoleAssignment.mock.calls[0]![1].audit.at).toBe(Date.parse(firstElsewhere));
  });

  it('applies in the store holding the access now, or as gone when none does', async () => {
    const review = await createRoleReview();
    await decide(
      review.review_id,
      items(reviews).map((item) => item.id),
      'revoked'
    );
    // The tenant moved: DB_USERS_1 is no longer one of its stores; its assignment lives in DB_NEW.
    const moved = sqliteStore();
    addRole(moved, 'role-admin');
    assign(moved, 'ra-2', 'user-2');
    mocks.storeAdapters.set('DB_NEW', moved);
    mocks.resolveStores.mockResolvedValue([
      { source: { ref: 'DB' }, bindingRef: 'DB' },
      { source: { ref: 'DB_NEW' }, bindingRef: 'DB_NEW' },
    ]);
    const done = await json(
      await completeAccessReview(context({ params: { id: review.review_id } }))
    );
    expect(done).toMatchObject({ completed: true, applied: 2 });
    expect(mocks.removeRoleAssignment).toHaveBeenCalledWith(
      expect.objectContaining({ adapter: moved }),
      expect.objectContaining({ assignmentId: 'ra-2' })
    );

    // Gone from every store: nothing left to take away.
    const other = await createRoleReview();
    const otherItems = items(reviews).filter((item) => item.review_id === other.review_id);
    await decide(
      other.review_id,
      otherItems.map((item) => item.id),
      'revoked'
    );
    // Its stores are replaced by one that holds neither assignment.
    const empty = sqliteStore();
    mocks.storeAdapters.set('DB_EMPTY', empty);
    mocks.resolveStores.mockResolvedValue([
      { source: { ref: 'DB_EMPTY' }, bindingRef: 'DB_EMPTY' },
    ]);
    mocks.removeRoleAssignment.mockClear();
    mocks.removeRoleAssignment.mockResolvedValue('already_removed');
    const gone = await json(
      await completeAccessReview(context({ params: { id: other.review_id } }))
    );
    expect(gone).toMatchObject({ completed: true });
    // Removed again where nothing holds it (the tenant's default store), which finds nothing and
    // finishes the rest (caches, audit) of a removal an earlier attempt started.
    expect(
      items(reviews)
        .filter((item) => item.review_id === other.review_id)
        .map((item) => item.apply_status)
    ).toEqual(['applied', 'applied']);
    expect(mocks.removeRoleAssignment).toHaveBeenCalledTimes(2);
    expect(mocks.removeRoleAssignment).toHaveBeenCalledWith(
      expect.objectContaining({ adapter: reviews }),
      expect.anything()
    );
  });

  it('refuses a due date that is not a real date', async () => {
    for (const due_date of [
      '2026-13-01',
      '2026-02-31',
      'tomorrow',
      '2026-02-31T12:00:00Z',
      '2026-04-31T00:00:00+09:00',
    ]) {
      const response = await createAccessReview(
        context({ body: { name: 'x', scope: 'role', scope_value: 'role-admin', due_date } })
      );
      expect(response.status).toBe(400);
    }
  });

  it("shows a routed tenant's suspended users by name", async () => {
    const review = await createRoleReview();
    mocks.routed = true;
    mocks.exactSearch.mockImplementation(async (input: { identifier: string }) => [
      {
        id: `account:${input.identifier}`,
        legacyUserId: input.identifier,
        coreBindingRef: 'DB',
        piiBindingRef: 'DB',
      },
    ]);
    const listed = await json(
      await listAccessReviewItems(
        context({ params: { id: review.review_id }, env: { DB: { ref: 'DB' } } })
      )
    );
    expect(mocks.exactSearch).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-a', purpose: 'admin_view' })
    );
    expect(listed.data[0].user.email).toMatch(/@example\.com$/u);
  });
});
