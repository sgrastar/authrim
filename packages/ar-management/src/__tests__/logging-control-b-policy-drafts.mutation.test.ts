/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- admin API response bodies are untyped JSON in these route tests */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../admin-shared', async (original) => ({
  ...(await original<typeof import('../admin-shared')>()),
  writeAdminAuditLog: (await import('./logging-control-b-harness')).auditWrite,
}));
vi.mock('../admin-step-up-gate', async () => {
  const { stepUpFakes } = await import('./logging-control-b-harness');
  return {
    requireAdminStepUp: stepUpFakes.requireAdminStepUp,
    refuseAdminFreshAuth: stepUpFakes.refuseAdminFreshAuth,
  };
});
vi.mock('@authrim/ar-lib-core', async (importOriginal) =>
  (await import('./logging-control-b-harness')).buildCoreMock(
    await importOriginal<typeof import('@authrim/ar-lib-core')>()
  )
);

import type { Env } from '@authrim/ar-lib-core';
import { ADMIN_PERMISSIONS, AR_ERROR_CODES } from '@authrim/ar-lib-core';
import {
  auditWrite,
  envFixture,
  mockAdapter,
  resetFakes,
  stepUpFakes,
} from './logging-control-b-harness';
import { POLICIES, call, createApp, createPlatformApp } from './logging-control-b-app';

const NOW = Date.UTC(2026, 2, 5, 10, 20, 30, 123);
const PUBLISH = [ADMIN_PERMISSIONS.LOGGING_SNAPSHOTS_PUBLISH];
const MIN = 60 * 1000;

beforeEach(() => {
  resetFakes();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

function snapshotJson(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    schemaVersion: 1,
    snapshotId: 'snap_draft',
    scopeType: 'platform',
    scopeId: 'global',
    version: 5,
    policyHash: 'a'.repeat(64),
    synchronizedAt: NOW,
    sourceUpdatedAt: NOW - 100,
    expiresAt: null,
    policies: { assignments: [], fallbacks: [], destinations: [] },
    ...overrides,
  });
}

function draftRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'snap_draft',
    scope_type: 'platform',
    scope_id: 'global',
    version: 5,
    status: 'draft',
    policy_hash: 'a'.repeat(64),
    snapshot_json: snapshotJson(),
    ...overrides,
  };
}

describe.each(['drafts', 'snapshots'])('POST /%s request validation', (route) => {
  const path = `${POLICIES}/${route}`;

  it('requires the snapshot publish permission', async () => {
    const res = await call(createPlatformApp([]), 'POST', path, {});
    expect(res.status).toBe(403);
    expect(res.body.error).toBe(AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
    expect(mockAdapter.query).not.toHaveBeenCalled();
  });

  it('reports invalid scope and expiry values', async () => {
    const res = await call(createPlatformApp(PUBLISH), 'POST', path, {
      scope_type: 'org',
      expires_at: 'tomorrow',
    });
    expect(res.status).toBe(400);
    expect(res.body.details.fields).toEqual([
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
    for (const expiresAt of [NOW + MIN - 1, 0, NOW - 5000]) {
      const soon = await call(createPlatformApp(PUBLISH), 'POST', path, { expires_at: expiresAt });
      expect(soon.body.details.fields).toEqual([
        {
          path: 'expires_at',
          code: 'too_soon',
          message: 'Expires at must be at least 60 seconds from now.',
        },
      ]);
    }
    expect(mockAdapter.execute).not.toHaveBeenCalled();
  });

  it('keeps platform scope for platform authority and tenant scope inside its tenant', async () => {
    const platform = await call(createApp(PUBLISH), 'POST', path, { scope_type: 'platform' });
    expect(platform.status).toBe(403);
    expect(platform.body.details.permission.reason).toBe('platform_authority_required');
    const foreign = await call(createApp(PUBLISH), 'POST', path, { scope_id: 'tenant-b' });
    expect(foreign.status).toBe(403);
    expect(foreign.body.error).toBe(AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
    expect(mockAdapter.execute).not.toHaveBeenCalled();
  });

  it('accepts an expiry exactly 60 seconds away and answers 500 when building fails', async () => {
    mockAdapter.queryOne.mockRejectedValue(new Error('x'));
    const failed = await call(createPlatformApp(PUBLISH), 'POST', path, { expires_at: NOW + MIN });
    expect(failed.status).toBe(500);
  });
});

describe('POST /drafts/:id/publish', () => {
  const path = `${POLICIES}/drafts/snap_draft/publish`;
  const confirmation = 'PUBLISH LOGGING POLICY platform:global';
  const platform = () => createPlatformApp(PUBLISH);

  it('requires the publish permission and a positive expected version', async () => {
    expect((await call(createPlatformApp([]), 'POST', path, {})).status).toBe(403);
    for (const expected of [0, -2, 'abc']) {
      const res = await call(platform(), 'POST', path, {
        expected_version: expected,
        confirmation,
      });
      expect(res.status).toBe(400);
      expect(res.body.details.fields).toEqual([
        {
          path: 'expected_version',
          code: 'invalid_value',
          message: 'Expected version must be a positive integer.',
        },
      ]);
    }
    expect(mockAdapter.queryOne).not.toHaveBeenCalled();
  });

  it('answers 404 unless a draft with a snapshot exists', async () => {
    expect((await call(platform(), 'POST', path, { confirmation })).status).toBe(404);
    expect(mockAdapter.queryOne.mock.calls[0][1]).toEqual(['snap_draft']);
    for (const row of [draftRow({ status: 'published' }), draftRow({ snapshot_json: null })]) {
      mockAdapter.queryOne.mockResolvedValue(row);
      expect((await call(platform(), 'POST', path, { confirmation })).status).toBe(404);
    }
  });

  it('enforces platform authority and tenant ownership of the draft', async () => {
    mockAdapter.queryOne.mockResolvedValue(draftRow());
    const notGlobal = await call(createApp(PUBLISH, ['ar_super_admin'], false), 'POST', path, {
      confirmation,
    });
    expect(notGlobal.status).toBe(403);
    expect(notGlobal.body.details.permission.reason).toBe('platform_authority_required');
    mockAdapter.queryOne.mockResolvedValue(
      draftRow({ scope_type: 'tenant', scope_id: 'tenant-b' })
    );
    const foreign = await call(createApp(PUBLISH), 'POST', path, {
      confirmation: 'PUBLISH LOGGING POLICY tenant:tenant-b',
    });
    expect(foreign.status).toBe(403);
    expect(foreign.body.error).toBe(AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
    const ownPlatform = await call(platform(), 'POST', path, {
      confirmation: 'PUBLISH LOGGING POLICY tenant:tenant-b',
    });
    expect(ownPlatform.status).toBe(200);
  });

  it('answers 409 for a stale version and 400 for a wrong confirmation', async () => {
    mockAdapter.queryOne.mockResolvedValue(draftRow());
    const stale = await call(platform(), 'POST', path, { expected_version: 4, confirmation });
    expect(stale.status).toBe(409);
    expect(stale.body.details.conflict).toEqual({ expected_version: 4, actual_version: 5 });
    for (const wrong of [undefined, 'PUBLISH LOGGING POLICY tenant:global', ` ${confirmation}`]) {
      const res = await call(platform(), 'POST', path, { confirmation: wrong });
      expect(res.status).toBe(400);
      expect(res.body.details.fields).toEqual([
        {
          path: 'confirmation',
          code: 'confirmation_mismatch',
          message: `Confirmation must be "${confirmation}".`,
        },
      ]);
    }
    expect(stepUpFakes.requireAdminStepUp).not.toHaveBeenCalled();
  });

  it('fails without a policy store, refuses an expiring snapshot and gates on step-up', async () => {
    mockAdapter.queryOne.mockResolvedValue(draftRow());
    const noStore = await call(platform(), 'POST', path, { confirmation }, {}, {
      ...envFixture,
      LOG_ARCHIVE: undefined,
    } as unknown as Env);
    expect(noStore.status).toBe(500);
    const cases = [NOW + MIN - 1, NOW - 1];
    for (const expiresAt of cases) {
      mockAdapter.queryOne.mockResolvedValue(
        draftRow({ snapshot_json: snapshotJson({ expiresAt }) })
      );
      const res = await call(platform(), 'POST', path, { confirmation });
      expect(res.status).toBe(400);
      expect(res.body.details.fields).toEqual([
        {
          path: 'expires_at',
          code: 'too_soon',
          message: 'Snapshot expiry is less than 60 seconds away.',
        },
      ]);
    }
    mockAdapter.queryOne.mockResolvedValue(
      draftRow({
        snapshot_json: snapshotJson({
          synchronizedAt: NOW - 3 * MIN,
          expiresAt: NOW - 2 * MIN - 1,
        }),
      })
    );
    expect((await call(platform(), 'POST', path, { confirmation })).status).toBe(400);
    expect(stepUpFakes.requireAdminStepUp).not.toHaveBeenCalled();
    mockAdapter.queryOne.mockResolvedValue(draftRow());
    stepUpFakes.requireAdminStepUp.mockResolvedValueOnce(new Response('stepup', { status: 401 }));
    expect((await call(platform(), 'POST', path, { confirmation })).status).toBe(401);
    expect(mockAdapter.execute).not.toHaveBeenCalled();
    expect(stepUpFakes.requireAdminStepUp).toHaveBeenCalledWith(expect.anything(), {
      operation: 'logging.policy.publish',
      targetTenantId: 'tenant-a',
      targetIds: ['snap_draft'],
      params: {
        kind: 'logging.policy.publish_draft',
        scope_type: 'platform',
        scope_id: 'global',
        version: 5,
        policy_hash: 'a'.repeat(64),
        policies_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        expires_at: null,
      },
    });
  });

  it('publishes the draft, marking it published with the stored object ref', async () => {
    mockAdapter.queryOne.mockResolvedValue(draftRow());
    const res = await call(platform(), 'POST', path, { expected_version: 5, confirmation });
    expect(res.status).toBe(200);
    expect(res.body.item).toMatchObject({
      id: 'snap_draft',
      scope_type: 'platform',
      scope_id: 'global',
      version: 5,
      status: 'published',
      policy_hash: 'a'.repeat(64),
      created_at: NOW,
      published_at: NOW,
    });
    expect(res.body.item.pointer_key).toContain('/current/platform/global');
    const [sql, params] = mockAdapter.execute.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("WHERE id = ? AND status = 'draft'");
    expect(params).toEqual([res.body.item.object_ref, 'admin-1', NOW, 'snap_draft']);
    expect(envFixture.AUTHRIM_CONFIG.put).toHaveBeenCalled();
    expect(auditWrite).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'logging_policy_snapshot.publish',
        resourceType: 'logging_policy_snapshot',
        resourceId: 'snap_draft',
        severity: 'warn',
        metadata: expect.objectContaining({
          draft_id: 'snap_draft',
          version: 5,
          object_ref: res.body.item.object_ref,
        }),
      })
    );
    mockAdapter.execute.mockRejectedValue(new Error('x'));
    expect((await call(platform(), 'POST', path, { confirmation })).status).toBe(500);
  });

  it('binds a tenant draft to its tenant for step-up', async () => {
    mockAdapter.queryOne.mockResolvedValue(
      draftRow({
        scope_type: 'tenant',
        scope_id: 'tenant-a',
        snapshot_json: snapshotJson({ scopeType: 'tenant', scopeId: 'tenant-a' }),
      })
    );
    const res = await call(createApp(PUBLISH), 'POST', path, {
      confirmation: 'PUBLISH LOGGING POLICY tenant:tenant-a',
    });
    expect(res.status).toBe(200);
    expect(stepUpFakes.requireAdminStepUp.mock.calls[0][1].targetTenantId).toBe('tenant-a');
    expect(stepUpFakes.requireAdminStepUp.mock.calls[0][1].params.kind).toBe(
      'logging.policy.publish_draft'
    );
  });
});
