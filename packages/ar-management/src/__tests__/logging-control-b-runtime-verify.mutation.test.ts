/* eslint-disable @typescript-eslint/no-unsafe-member-access -- admin API response bodies are untyped JSON in these route tests */
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

import { ADMIN_PERMISSIONS, type Env } from '@authrim/ar-lib-core';
import { LOG_ICEBERG_POLICY_PREFIX } from '@authrim/ar-lib-core/services/log-iceberg-policy-artifacts';
import { buildRuntimeLoggingPolicySnapshotPointerKey } from '@authrim/ar-lib-logging/policies';
import { envFixture, mockAdapter, resetFakes } from './logging-control-b-harness';
import { POLICIES, call, createApp, createPlatformApp } from './logging-control-b-app';

const READ = [ADMIN_PERMISSIONS.LOGGING_OVERVIEW_READ];

describe('runtime/verify', () => {
  beforeEach(() => resetFakes());
  const path = `${POLICIES}/runtime/verify`;
  const verifyPerm = [ADMIN_PERMISSIONS.LOGGING_SNAPSHOTS_PUBLISH];
  const pointerKey = (scopeType: 'platform' | 'tenant', scopeId: string) =>
    buildRuntimeLoggingPolicySnapshotPointerKey({
      scopeType,
      scopeId,
      prefix: LOG_ICEBERG_POLICY_PREFIX,
    });
  const kv = (values: Record<string, string>) =>
    envFixture.AUTHRIM_CONFIG.get.mockImplementation(async (key: string) => values[key] ?? null);

  it('requires one of the read or snapshot-publish permissions', async () => {
    expect((await call(createApp([]), 'GET', path)).status).toBe(403);
    expect((await call(createApp(verifyPerm), 'GET', path)).status).toBe(200);
  });

  it('rejects unknown scope types', async () => {
    const res = await call(createApp(READ), 'GET', `${path}?scope_type=region`);
    expect(res.status).toBe(400);
    expect(res.body.details.fields).toEqual([
      {
        path: 'scope_type',
        code: 'invalid_value',
        message: 'Scope type must be platform or tenant.',
      },
    ]);
  });

  it('requires platform authority for the platform scope and defaults its id to global', async () => {
    const denied = await call(createApp(READ), 'GET', `${path}?scope_type=platform`);
    expect(denied.status).toBe(403);
    expect(denied.body.details.permission).toEqual({
      required_scope: 'platform',
      reason: 'platform_authority_required',
    });
    const res = await call(createPlatformApp(READ), 'GET', `${path}?filter[scope_type]=platform`);
    expect(res.status).toBe(200);
    expect(res.body.item).toMatchObject({
      scope_type: 'platform',
      scope_id: 'global',
      pointer_key: pointerKey('platform', 'global'),
    });
    expect(mockAdapter.queryOne.mock.calls[0][1]).toEqual(['platform', 'global']);
  });

  it('resolves the tenant scope from tenant_id, scope_id or the context and enforces tenancy', async () => {
    const own = await call(createApp(READ), 'GET', path);
    expect(own.body.item).toMatchObject({ scope_type: 'tenant', scope_id: 'tenant-a' });
    const viaScope = await call(createPlatformApp(READ), 'GET', `${path}?scope_id=tenant-q`);
    expect(viaScope.body.item.scope_id).toBe('tenant-q');
    const viaTenant = await call(
      createPlatformApp(READ),
      'GET',
      `${path}?filter[tenant_id]=tenant-r&scope_id=tenant-q`
    );
    expect(viaTenant.body.item.scope_id).toBe('tenant-r');
    const mismatch = await call(createApp(READ), 'GET', `${path}?scope_id=tenant-b`);
    expect(mismatch.status).toBe(403);
    expect(mismatch.body.details.permission.reason).toBe('tenant_scope_mismatch');
  });

  it('reports a missing pointer and nothing else', async () => {
    const res = await call(createApp(READ), 'GET', path);
    expect(res.body.item).toMatchObject({
      pointer_status: 'missing',
      object_status: 'not_referenced',
      snapshot_status: 'not_referenced',
      pointer: null,
      snapshot: null,
      database_latest: null,
      checks: {
        pointer_present: false,
        object_ref_present: false,
        snapshot_present: false,
        pointer_matches_snapshot: false,
        pointer_matches_database: false,
        database_latest_present: false,
      },
    });
    expect(res.body.item.verified_at).toEqual(expect.any(Number));
  });

  it('flags a pointer that is not a JSON object as invalid_json', async () => {
    for (const raw of ['{broken', '[1,2]', '"text"']) {
      kv({ [pointerKey('tenant', 'tenant-a')]: raw });
      const res = await call(createApp(READ), 'GET', path);
      expect(res.body.item.pointer_status).toBe('invalid_json');
      expect(res.body.item.pointer).toBeNull();
      expect(res.body.item.checks.pointer_present).toBe(false);
    }
  });

  it('verifies a pointer, a kv snapshot and the database row that all agree', async () => {
    const pointer = {
      snapshotId: 's1',
      version: 3,
      policyHash: 'h1',
      scopeType: 'tenant',
      scopeId: 'tenant-a',
      objectRef: 'kv://snap/s1',
      publishedAt: 11,
      expiresAt: 22,
    };
    kv({
      [pointerKey('tenant', 'tenant-a')]: JSON.stringify(pointer),
      'snap/s1': JSON.stringify({
        snapshotId: 's1',
        version: 3,
        policyHash: 'h1',
        scopeType: 'tenant',
        scopeId: 'tenant-a',
        synchronizedAt: 33,
        sourceUpdatedAt: 44,
      }),
    });
    const latest = {
      id: 's1',
      version: 3,
      policy_hash: 'h1',
      object_ref: 'kv://snap/s1',
      published_at: 5,
    };
    mockAdapter.queryOne.mockResolvedValue(latest);
    const res = await call(createApp(READ), 'GET', path);
    expect(res.body.item).toMatchObject({
      pointer_status: 'readable',
      object_status: 'readable',
      snapshot_status: 'readable',
      pointer: {
        snapshot_id: 's1',
        version: 3,
        policy_hash: 'h1',
        object_ref: 'kv://snap/s1',
        published_at: 11,
        expires_at: 22,
      },
      snapshot: {
        snapshot_id: 's1',
        version: 3,
        policy_hash: 'h1',
        synchronized_at: 33,
        source_updated_at: 44,
      },
      database_latest: latest,
      checks: {
        pointer_present: true,
        object_ref_present: true,
        snapshot_present: true,
        pointer_matches_snapshot: true,
        pointer_matches_database: true,
        database_latest_present: true,
      },
    });
  });

  it('detects each field that makes the pointer disagree with the snapshot or database', async () => {
    const pointer = {
      snapshotId: 's1',
      version: 3,
      policyHash: 'h1',
      scopeType: 'tenant',
      scopeId: 'tenant-a',
      objectRef: 'kv://snap/s1',
    };
    const snapshot = { ...pointer };
    delete (snapshot as Record<string, unknown>).objectRef;
    const latest = { id: 's1', version: 3, policy_hash: 'h1', object_ref: 'kv://snap/s1' };
    const snapshotOverrides: Record<string, unknown>[] = [
      { snapshotId: 'other' },
      { version: 4 },
      { policyHash: 'other' },
      { scopeType: 'platform' },
      { scopeId: 'tenant-z' },
    ];
    for (const override of snapshotOverrides) {
      kv({
        [pointerKey('tenant', 'tenant-a')]: JSON.stringify(pointer),
        'snap/s1': JSON.stringify({ ...snapshot, ...override }),
      });
      mockAdapter.queryOne.mockResolvedValue(latest);
      const res = await call(createApp(READ), 'GET', path);
      expect(res.body.item.checks.pointer_matches_snapshot).toBe(false);
      expect(res.body.item.checks.pointer_matches_database).toBe(true);
    }
    const dbOverrides: Record<string, unknown>[] = [
      { id: 'other' },
      { version: 9 },
      { policy_hash: 'other' },
      { object_ref: 'kv://other' },
    ];
    for (const override of dbOverrides) {
      kv({
        [pointerKey('tenant', 'tenant-a')]: JSON.stringify(pointer),
        'snap/s1': JSON.stringify(snapshot),
      });
      mockAdapter.queryOne.mockResolvedValue({ ...latest, ...override });
      const res = await call(createApp(READ), 'GET', path);
      expect(res.body.item.checks.pointer_matches_snapshot).toBe(true);
      expect(res.body.item.checks.pointer_matches_database).toBe(false);
    }
  });

  it('reports a missing or unparsable kv snapshot', async () => {
    const pointer = JSON.stringify({ objectRef: 'kv://snap/gone' });
    kv({ [pointerKey('tenant', 'tenant-a')]: pointer });
    const missing = await call(createApp(READ), 'GET', path);
    expect(missing.body.item).toMatchObject({
      pointer_status: 'readable',
      object_status: 'missing',
      snapshot_status: 'missing',
      snapshot: null,
    });
    expect(missing.body.item.checks).toMatchObject({
      object_ref_present: true,
      snapshot_present: false,
    });

    kv({ [pointerKey('tenant', 'tenant-a')]: pointer, 'snap/gone': 'not json' });
    const invalid = await call(createApp(READ), 'GET', path);
    expect(invalid.body.item).toMatchObject({
      object_status: 'readable',
      snapshot_status: 'invalid_json',
    });
    kv({ [pointerKey('tenant', 'tenant-a')]: JSON.stringify({ objectRef: 7 }) });
    const nonString = await call(createApp(READ), 'GET', path);
    expect(nonString.body.item.object_status).toBe('not_referenced');
    expect(nonString.body.item.pointer.object_ref).toBeNull();
  });

  it('reads private snapshot objects through the archive writer when one is bound', async () => {
    const objectRef = `${LOG_ICEBERG_POLICY_PREFIX}/snapshots/tenant/tenant-a/v1-abc.json`;
    const pointer = JSON.stringify({ objectRef, snapshotId: 's1' });
    kv({ [pointerKey('tenant', 'tenant-a')]: pointer });
    const readPolicyArtifact = vi.fn();
    const archiveEnv = {
      ...envFixture,
      LOG_ARCHIVE_WRITER: { readPolicyArtifact },
    } as unknown as Env;

    readPolicyArtifact.mockResolvedValue(JSON.stringify({ snapshotId: 's1' }));
    const readable = await call(createApp(READ), 'GET', path, undefined, {}, archiveEnv);
    expect(readable.body.item).toMatchObject({
      object_status: 'readable',
      snapshot_status: 'readable',
      snapshot: { snapshot_id: 's1' },
    });
    expect(readPolicyArtifact).toHaveBeenCalledWith({
      scopeType: 'tenant',
      scopeId: 'tenant-a',
      objectKey: objectRef,
    });

    readPolicyArtifact.mockResolvedValue('');
    const empty = await call(createApp(READ), 'GET', path, undefined, {}, archiveEnv);
    expect(empty.body.item.object_status).toBe('unreadable');
    expect(empty.body.item.snapshot_status).toBe('unreadable');

    readPolicyArtifact.mockResolvedValue(null);
    const gone = await call(createApp(READ), 'GET', path, undefined, {}, archiveEnv);
    expect(gone.body.item.object_status).toBe('missing');
    expect(gone.body.item.snapshot_status).toBe('missing');

    readPolicyArtifact.mockResolvedValue('{bad');
    const bad = await call(createApp(READ), 'GET', path, undefined, {}, archiveEnv);
    expect(bad.body.item.snapshot_status).toBe('invalid_json');
  });

  it('reports object_store_unavailable for a private ref without an archive bucket', async () => {
    const objectRef = `${LOG_ICEBERG_POLICY_PREFIX}/snapshots/tenant/tenant-a/v1-abc.json`;
    kv({ [pointerKey('tenant', 'tenant-a')]: JSON.stringify({ objectRef }) });
    const noArchive = { ...envFixture, LOG_ARCHIVE: undefined } as unknown as Env;
    const res = await call(createApp(READ), 'GET', path, undefined, {}, noArchive);
    expect(res.body.item.object_status).toBe('object_store_unavailable');
    expect(res.body.item.snapshot_status).toBe('object_store_unavailable');
  });

  it('answers 500 when the pointer store throws', async () => {
    envFixture.AUTHRIM_CONFIG.get.mockRejectedValue(new Error('kv down'));
    const res = await call(createApp(READ), 'GET', path);
    expect(res.status).toBe(500);
  });
});
