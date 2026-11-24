/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any -- admin API response bodies and hono/vi fakes are untyped in these route tests */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const auditWrite = vi.hoisted(() => vi.fn(async () => 'audit_1'));
vi.mock('../admin-shared', async (original) => ({
  ...(await original<typeof import('../admin-shared')>()),
  writeAdminAuditLog: auditWrite,
}));

const stepUp = vi.hoisted(() => vi.fn(async (..._args: any[]): Promise<Response | null> => null));
vi.mock('../admin-step-up-gate', () => ({
  requireAdminStepUp: stepUp,
  refuseAdminFreshAuth: vi.fn(async () => null),
}));

const mockAdapter = vi.hoisted(() => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  execute: vi.fn(),
  batch: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  const statusByCode: Record<string, number> = {
    [actual.AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS]: 403,
    [actual.AR_ERROR_CODES.ADMIN_INVALID_REQUEST]: 400,
    [actual.AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND]: 404,
    [actual.AR_ERROR_CODES.ADMIN_CONFLICT]: 409,
    [actual.AR_ERROR_CODES.INTERNAL_ERROR]: 500,
  };
  return {
    ...actual,
    requireAdminDatabaseAdapter: vi.fn(() => mockAdapter),
    requireDedicatedAdminDatabaseAdapter: vi.fn(() => mockAdapter),
    getTenantIdFromContext: vi.fn((c: { get: (key: string) => unknown }) => c.get('tenantId')),
    createErrorResponse: vi.fn(
      (
        c: { json: (body: unknown, status?: number) => Response },
        errorCode: string,
        options?: { extensions?: Record<string, unknown> }
      ) =>
        c.json({ error: errorCode, ...(options?.extensions ?? {}) }, statusByCode[errorCode] ?? 500)
    ),
  };
});

import { ADMIN_PERMISSIONS, AR_ERROR_CODES } from '@authrim/ar-lib-core';
import { createApp, resetAdapter, routeSql } from './logging-control-a-harness';
import { must } from './helpers/must';

const PUBLISH = ADMIN_PERMISSIONS.LOGGING_SNAPSHOTS_PUBLISH;
const BASE = '/api/admin/logging-policies';
type Body = Record<string, any>;

let logArchive: { put: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> };
let kv: { put: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> };

async function call(
  perms: string[],
  method: string,
  path: string,
  body?: unknown,
  opts: { platform?: boolean; archive?: boolean; tenantId?: string } = {}
) {
  const res = await createApp(perms, {
    platform: opts.platform ?? false,
    tenantId: opts.tenantId,
  }).request(
    `${BASE}${path}`,
    {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    {
      DB_ADMIN: {},
      AUTHRIM_CONFIG: kv,
      ...(opts.archive === false ? {} : { LOG_ARCHIVE: logArchive }),
    }
  );
  return { status: res.status, body: await res.json<Body>() };
}

interface World {
  nextVersion?: number | null;
  assignments?: Array<Record<string, unknown>>;
  fallbacks?: Array<Record<string, unknown>>;
  destinations?: Array<Record<string, unknown>>;
  previous?: { id: string; version: number; snapshot_json: string | null } | null;
  draft?: Record<string, unknown> | null;
}
function world(w: World = {}) {
  routeSql(mockAdapter, {
    one: [
      {
        match: /COALESCE\(MAX\(version\), 0\) \+ 1/,
        result: w.nextVersion === null ? null : { next_version: w.nextVersion ?? 1 },
      },
      { match: /status = 'published'/, result: w.previous ?? null },
      { match: /WHERE id = \?/, result: w.draft ?? null },
    ],
    many: [
      { match: /FROM logging_destination_overrides/, result: w.assignments ?? [] },
      { match: /FROM logging_fallback_policies/, result: w.fallbacks ?? [] },
      { match: /FROM admin_destinations/, result: w.destinations ?? [] },
    ],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetAdapter(mockAdapter);
  stepUp.mockReset().mockResolvedValue(null);
  auditWrite.mockReset().mockResolvedValue('audit_1');
  logArchive = { put: vi.fn().mockResolvedValue({}), get: vi.fn().mockResolvedValue(null) };
  kv = { put: vi.fn().mockResolvedValue(undefined), get: vi.fn().mockResolvedValue(null) };
  world();
});

describe('policy snapshot draft body', () => {
  it.each(['/drafts', '/snapshots'])('%s requires the publish permission', async (path) => {
    const res = await call([], 'POST', path, {});
    expect(res.status).toBe(403);
    expect(res.body.error).toBe(AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  });

  it.each(['/drafts', '/snapshots'])('%s validates scope_type and expires_at', async (path) => {
    const bad = await call([PUBLISH], 'POST', path, { scope_type: 'galaxy', expires_at: 'soon' });
    expect(bad.status).toBe(400);
    expect(bad.body.details.fields).toEqual([
      {
        path: 'scope_type',
        code: 'invalid_value',
        message: 'Scope type must be platform or tenant.',
      },
      {
        path: 'expires_at',
        code: 'invalid_type',
        message: 'Expires at must be a timestamp number.',
      },
    ]);
    const soon = await call([PUBLISH], 'POST', path, { expires_at: Date.now() + 5_000 });
    expect(soon.body.details.fields).toEqual([
      {
        path: 'expires_at',
        code: 'too_soon',
        message: 'Expires at must be at least 60 seconds from now.',
      },
    ]);
    expect(mockAdapter.execute).not.toHaveBeenCalled();
  });

  it('accepts an expiry just beyond the minimum and rejects one just under', async () => {
    const ok = await call([PUBLISH], 'POST', '/drafts', { expires_at: Date.now() + 70_000 });
    expect(ok.status).toBe(201);
    const under = await call([PUBLISH], 'POST', '/drafts', { expires_at: Date.now() + 50_000 });
    expect(under.status).toBe(400);
  });

  it('keeps platform snapshots to platform administrators and tenant ones to their tenant', async () => {
    const platform = await call([PUBLISH], 'POST', '/drafts', { scope_type: 'platform' });
    expect(platform.status).toBe(403);
    expect(platform.body.details.permission.reason).toBe('platform_authority_required');
    const foreign = await call([PUBLISH], 'POST', '/drafts', { scope_id: 'tenant-b' });
    expect(foreign.status).toBe(403);
    expect(foreign.body.error).toBe(AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
    const own = await call([PUBLISH], 'POST', '/drafts', { scope_id: ' tenant-a ' });
    expect(own.status).toBe(201);
    expect(own.body.item.scope_id).toBe('tenant-a');
    const other = await call(
      [PUBLISH],
      'POST',
      '/drafts',
      { scope_id: 'tenant-b' },
      { platform: true }
    );
    expect(other.body.item).toMatchObject({ scope_type: 'tenant', scope_id: 'tenant-b' });
  });
});

describe('POST /drafts', () => {
  it('stores a draft for the context tenant with the next version', async () => {
    world({
      nextVersion: 4,
      assignments: [{ id: 'a1' }],
      fallbacks: [{ id: 'f1' }, { id: 'f2' }],
      destinations: [{ id: 'd1', updated_at: 500 }],
    });
    const res = await call([PUBLISH], 'POST', '/drafts', {}, { tenantId: 'tenant-q' });
    expect(res.status).toBe(201);
    expect(res.body.item).toMatchObject({
      scope_type: 'tenant',
      scope_id: 'tenant-q',
      version: 4,
      status: 'draft',
      policy_hash: expect.any(String),
      confirmation: 'PUBLISH LOGGING POLICY tenant:tenant-q',
      diff: {
        compared_to_snapshot_id: null,
        compared_to_version: null,
        assignment_added: 1,
        assignment_removed: 0,
        assignment_changed: 0,
        fallback_added: 2,
        destination_added: 1,
      },
    });
    expect(res.body.audit_id).toBe('audit_1');
    const [sql, p] = mockAdapter.execute.mock.calls[0];
    expect(sql).toContain('INSERT INTO logging_policy_snapshots');
    expect(p.slice(1, 7)).toEqual([
      'tenant',
      'tenant-q',
      4,
      'draft',
      res.body.item.policy_hash,
      null,
    ]);
    expect(p[8]).toBeNull();
    expect(p[10]).toBeNull();
    const stored = JSON.parse(p[7]);
    expect(stored.policies).toEqual({
      assignments: [{ id: 'a1' }],
      fallbacks: [{ id: 'f1' }, { id: 'f2' }],
      destinations: [{ id: 'd1', updated_at: 500 }],
    });
    expect(stored.sourceUpdatedAt).toBe(500);
    expect(auditWrite).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'logging_policy_snapshot.draft_create',
        severity: 'info',
        metadata: expect.objectContaining({
          version: 4,
          assignment_count: 1,
          fallback_count: 2,
          destination_count: 1,
        }),
      })
    );
  });

  it('defaults to version 1 and platform scope id "global"', async () => {
    world({ nextVersion: null });
    const res = await call(
      [PUBLISH],
      'POST',
      '/drafts',
      { scope_type: 'platform' },
      { platform: true }
    );
    expect(res.body.item).toMatchObject({ scope_type: 'platform', scope_id: 'global', version: 1 });
    expect(res.body.item.confirmation).toBe('PUBLISH LOGGING POLICY platform:global');
    const versionQuery = mockAdapter.queryOne.mock.calls[0];
    expect(versionQuery[1]).toEqual(['platform', 'global']);
  });

  it('queries candidate rows by scope', async () => {
    await call([PUBLISH], 'POST', '/drafts', { scope_id: 'tenant-z' }, { platform: true });
    const byTable = (needle: string) =>
      must(mockAdapter.query.mock.calls.find(([s]) => String(s).includes(needle)));
    expect(byTable('FROM logging_destination_overrides')[1]).toEqual(['tenant-z']);
    expect(byTable('FROM logging_fallback_policies')[1]).toEqual(['tenant', 'tenant-z']);
    expect(byTable('FROM admin_destinations')[1]).toEqual([]);
  });

  it('diffs against the latest published snapshot (added, removed and changed rows)', async () => {
    const previousPolicies = {
      assignments: [
        { id: 'a_same', v: 1 },
        { id: 'a_changed', v: 1 },
        { id: 'a_removed' },
        'junk',
        null,
        ['x'],
      ],
      fallbacks: [{ tenant_id: 't', scope_id: 's', log_type: 'audit', plane: 'archive', v: 1 }],
      destinations: [{ id: 'd_removed' }],
    };
    world({
      nextVersion: 3,
      previous: {
        id: 'snap_prev',
        version: 2,
        snapshot_json: JSON.stringify({ policies: previousPolicies }),
      },
      assignments: [{ id: 'a_same', v: 1 }, { id: 'a_changed', v: 2 }, { id: 'a_new' }],
      fallbacks: [
        { tenant_id: 't', scope_id: 's', log_type: 'audit', plane: 'archive', v: 2 },
        { scope_type: 'platform', log_type: 'job', plane: 'primary' },
      ],
      destinations: [],
    });
    const res = await call([PUBLISH], 'POST', '/drafts', {});
    expect(res.body.item.diff).toEqual({
      compared_to_snapshot_id: 'snap_prev',
      compared_to_version: 2,
      assignment_added: 1,
      assignment_removed: 1,
      assignment_changed: 1,
      fallback_added: 1,
      fallback_removed: 0,
      fallback_changed: 1,
      destination_added: 0,
      destination_removed: 1,
      destination_changed: 0,
    });
  });

  it('treats a blank or malformed previous snapshot as having no policies', async () => {
    world({ previous: { id: 'p1', version: 1, snapshot_json: '   ' }, assignments: [{ id: 'a' }] });
    const blank = await call([PUBLISH], 'POST', '/drafts', {});
    expect(blank.body.item.diff).toMatchObject({
      compared_to_snapshot_id: 'p1',
      compared_to_version: 1,
      assignment_added: 1,
    });
    world({
      previous: { id: 'p1', version: 1, snapshot_json: JSON.stringify({ policies: 'nope' }) },
      assignments: [{ id: 'a' }],
    });
    const odd = await call([PUBLISH], 'POST', '/drafts', {});
    expect(odd.body.item.diff).toMatchObject({
      compared_to_snapshot_id: 'p1',
      assignment_added: 1,
      assignment_removed: 0,
    });
    world({
      previous: {
        id: 'p1',
        version: 1,
        snapshot_json: JSON.stringify({
          policies: { assignments: 'x', fallbacks: {}, destinations: null },
        }),
      },
    });
    const arrays = await call([PUBLISH], 'POST', '/drafts', {});
    expect(arrays.body.item.diff.assignment_removed).toBe(0);
  });

  it('maps failures to 500', async () => {
    mockAdapter.execute.mockRejectedValue(new Error('db'));
    expect((await call([PUBLISH], 'POST', '/drafts', {})).status).toBe(500);
  });
});

describe('POST /drafts/:id/publish', () => {
  async function makeDraft(
    extra: Record<string, unknown> = {},
    scope: Record<string, unknown> = {}
  ) {
    world({ assignments: [{ id: 'a1' }] });
    const created = await call([PUBLISH], 'POST', '/drafts', scope, { platform: true });
    const [, p] = must(mockAdapter.execute.mock.calls.at(-1));
    mockAdapter.execute.mockClear();
    return {
      id: p[0] as string,
      scope_type: p[1] as string,
      scope_id: p[2] as string,
      version: p[3] as number,
      status: 'draft',
      policy_hash: p[5] as string,
      snapshot_json: p[7] as string,
      confirmation: created.body.item.confirmation as string,
      ...extra,
    };
  }
  const publish = (
    draft: unknown,
    body: unknown,
    opts: { platform?: boolean; archive?: boolean } = {}
  ) => {
    world({ draft: draft as never });
    return call([PUBLISH], 'POST', '/drafts/snap/publish', body, { platform: true, ...opts });
  };

  it('requires the permission and a positive integer expected_version', async () => {
    expect((await call([], 'POST', '/drafts/x/publish', {})).status).toBe(403);
    for (const expected_version of [0, -1, 'abc']) {
      const res = await call([PUBLISH], 'POST', '/drafts/x/publish', { expected_version });
      expect(res.status).toBe(400);
      expect(res.body.details.fields).toEqual([
        {
          path: 'expected_version',
          code: 'invalid_value',
          message: 'Expected version must be a positive integer.',
        },
      ]);
    }
  });

  it('404s missing, non-draft and empty drafts', async () => {
    const draft = await makeDraft();
    for (const row of [
      null,
      { ...draft, status: 'published' },
      { ...draft, snapshot_json: null },
    ]) {
      expect((await publish(row, { confirmation: draft.confirmation })).status).toBe(404);
    }
  });

  it('enforces scope: platform drafts need platform authority and tenant drafts the tenant', async () => {
    const platformDraft = await makeDraft({}, { scope_type: 'platform' });
    world({ draft: platformDraft });
    const denied = await call([PUBLISH], 'POST', '/drafts/snap/publish', {
      confirmation: platformDraft.confirmation,
    });
    expect(denied.status).toBe(403);
    expect(denied.body.details.permission.reason).toBe('platform_authority_required');
    const tenantDraft = await makeDraft({}, { scope_id: 'tenant-b' });
    world({ draft: tenantDraft });
    const foreign = await call([PUBLISH], 'POST', '/drafts/snap/publish', {
      confirmation: tenantDraft.confirmation,
    });
    expect(foreign.status).toBe(403);
    expect(foreign.body.error).toBe(AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  });

  it('reports version conflicts and confirmation mismatches', async () => {
    const draft = await makeDraft();
    const conflict = await publish(draft, {
      expected_version: draft.version + 1,
      confirmation: draft.confirmation,
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body.details.conflict).toEqual({
      expected_version: draft.version + 1,
      actual_version: draft.version,
    });
    const mismatch = await publish(draft, { confirmation: 'nope' });
    expect(mismatch.status).toBe(400);
    expect(mismatch.body.details.fields).toEqual([
      {
        path: 'confirmation',
        code: 'confirmation_mismatch',
        message: `Confirmation must be "${draft.confirmation}".`,
      },
    ]);
    expect(kv.put).not.toHaveBeenCalled();
  });

  it('publishes the snapshot to storage, marks the draft published and audits', async () => {
    const draft = await makeDraft();
    const res = await publish(draft, {
      expected_version: draft.version,
      confirmation: draft.confirmation,
    });
    expect(res.status).toBe(200);
    expect(res.body.item).toMatchObject({
      scope_type: 'tenant',
      scope_id: 'tenant-a',
      version: draft.version,
      status: 'published',
      policy_hash: draft.policy_hash,
      object_ref: expect.any(String),
      pointer_key: expect.any(String),
    });
    expect(res.body.item.created_at).toBe(res.body.item.published_at);
    expect(logArchive.put).toHaveBeenCalledTimes(1);
    expect(kv.put).toHaveBeenCalledTimes(1);
    const [sql, p] = mockAdapter.execute.mock.calls[0];
    expect(sql).toContain("SET status = 'published'");
    expect(p).toEqual([res.body.item.object_ref, 'admin-1', res.body.item.published_at, draft.id]);
    expect(stepUp.mock.calls[0][1]).toMatchObject({
      operation: 'logging.policy.publish',
      targetIds: [draft.id],
      params: {
        kind: 'logging.policy.publish_draft',
        scope_type: 'tenant',
        scope_id: 'tenant-a',
        version: draft.version,
        policy_hash: draft.policy_hash,
        policies_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    expect(auditWrite).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'logging_policy_snapshot.publish',
        severity: 'warn',
        metadata: expect.objectContaining({
          draft_id: draft.id,
          object_ref: res.body.item.object_ref,
        }),
      })
    );
  });

  it('refuses when the object store is missing, the step-up fails, or the snapshot expires too soon', async () => {
    const draft = await makeDraft();
    expect(
      (await publish(draft, { confirmation: draft.confirmation }, { archive: false })).status
    ).toBe(500);
    stepUp.mockResolvedValueOnce(new Response('{}', { status: 428 }));
    expect((await publish(draft, { confirmation: draft.confirmation })).status).toBe(428);
    expect(kv.put).not.toHaveBeenCalled();
    const snapshot = JSON.parse(draft.snapshot_json);
    snapshot.expiresAt = snapshot.synchronizedAt + 10_000;
    const expiring = await publish(
      { ...draft, snapshot_json: JSON.stringify(snapshot) },
      { confirmation: draft.confirmation }
    );
    expect(expiring.status).toBe(400);
    expect(expiring.body.details.fields).toEqual([
      {
        path: 'expires_at',
        code: 'too_soon',
        message: 'Snapshot expiry is less than 60 seconds away.',
      },
    ]);
    snapshot.expiresAt = Date.now() + 10_000;
    snapshot.synchronizedAt = Date.now() - 600_000;
    const past = await publish(
      { ...draft, snapshot_json: JSON.stringify(snapshot) },
      { confirmation: draft.confirmation }
    );
    expect(past.body.details.fields[0].code).toBe('too_soon');
  });
});

describe('POST /snapshots', () => {
  it('publishes immediately and records the published row', async () => {
    world({ nextVersion: 2, assignments: [{ id: 'a1' }], fallbacks: [{ id: 'f1' }] });
    const res = await call([PUBLISH], 'POST', '/snapshots', {});
    expect(res.status).toBe(200);
    expect(res.body.item).toMatchObject({
      scope_type: 'tenant',
      scope_id: 'tenant-a',
      version: 2,
      status: 'published',
      object_ref: expect.any(String),
      pointer_key: expect.any(String),
    });
    expect(res.body.item.created_at).toBe(res.body.item.published_at);
    expect(logArchive.put).toHaveBeenCalledTimes(1);
    expect(kv.put).toHaveBeenCalledTimes(1);
    const [sql, p] = mockAdapter.execute.mock.calls[0];
    expect(sql).toContain('INSERT INTO logging_policy_snapshots');
    expect(p.slice(1, 5)).toEqual(['tenant', 'tenant-a', 2, 'published']);
    expect(p[6]).toBe(res.body.item.object_ref);
    expect(p[8]).toBe('admin-1');
    expect(stepUp.mock.calls[0][1]).toMatchObject({
      operation: 'logging.policy.publish',
      params: expect.objectContaining({ kind: 'logging.policy.publish_snapshot', version: 2 }),
    });
    expect(stepUp.mock.calls[0][1].targetIds).toBeUndefined();
    expect(auditWrite).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        metadata: expect.objectContaining({
          assignment_count: 1,
          fallback_count: 1,
          destination_count: 0,
        }),
      })
    );
  });

  it('targets the step-up at the tenant of tenant snapshots and at the context for platform ones', async () => {
    await call(
      [PUBLISH],
      'POST',
      '/snapshots',
      { scope_id: 'tenant-b' },
      { platform: true, tenantId: 'ctx' }
    );
    expect(stepUp.mock.calls[0][1]).toMatchObject({ targetTenantId: 'tenant-b' });
    await call(
      [PUBLISH],
      'POST',
      '/snapshots',
      { scope_type: 'platform' },
      { platform: true, tenantId: 'ctx' }
    );
    expect(stepUp.mock.calls[1][1]).toMatchObject({ targetTenantId: 'ctx' });
  });

  it('fails without an object store, on an imminent expiry, a step-up refusal, or storage errors', async () => {
    expect((await call([PUBLISH], 'POST', '/snapshots', {}, { archive: false })).status).toBe(500);
    stepUp.mockResolvedValueOnce(new Response('{}', { status: 428 }));
    expect((await call([PUBLISH], 'POST', '/snapshots', {})).status).toBe(428);
    expect(kv.put).not.toHaveBeenCalled();
    expect(mockAdapter.execute).not.toHaveBeenCalled();
    kv.put.mockRejectedValue(new Error('kv'));
    expect((await call([PUBLISH], 'POST', '/snapshots', {})).status).toBe(500);
    expect(mockAdapter.execute).not.toHaveBeenCalled();
  });
});
