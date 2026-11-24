/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any -- admin API response bodies and hono/vi fakes are untyped in these route tests */
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

import { ADMIN_PERMISSIONS } from '@authrim/ar-lib-core';
import { createApp, destinationRow, resetAdapter, routeSql } from './logging-control-a-harness';
import { must } from './helpers/must';

const ROOT_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const P = ADMIN_PERMISSIONS;
const CRED = P.STORAGE_DESTINATIONS_CREDENTIALS_WRITE;
const D1_REF = 'd1secret://admin/credential_secrets/dest_1/v1#v1';

type Body = Record<string, any>;
async function call(
  perms: string[],
  method: string,
  path: string,
  body?: unknown,
  env: Record<string, unknown> = { OBJECT_ENCRYPTION_ROOT_KEY: ROOT_KEY }
) {
  const res = await createApp(perms, { platform: true }).request(
    `/api/admin/destinations${path}`,
    {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    { DB_ADMIN: {}, ...env }
  );
  return { status: res.status, body: await res.json<Body>() };
}

const selectDestination = (row: Record<string, unknown> | null) => {
  let notificationReads = 0;
  routeSql(mockAdapter, {
    one: [
      {
        match: /FROM internal_notification_events/,
        // First read is the dedupe check (miss), the second reads the inserted row back.
        result: () =>
          notificationReads++ === 0 ? null : { id: 'evt_existing', status: 'pending' },
      },
      { match: /FROM admin_destinations/, result: row },
    ],
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  resetAdapter(mockAdapter);
  stepUp.mockReset().mockResolvedValue(null);
  auditWrite.mockReset().mockResolvedValue('audit_1');
});

describe('credentials/prepare', () => {
  it('requires a secret value in any of the accepted fields', async () => {
    selectDestination(destinationRow());
    const missing = await call([CRED], 'POST', '/dest_1/credentials/prepare', {
      secret_value: '  ',
    });
    expect(missing.status).toBe(400);
    expect(missing.body.details.fields).toEqual([
      { path: 'secret_value', code: 'required', message: 'Credential secret value is required.' },
    ]);
    for (const key of ['secret_value', 'credential_value', 'plaintext']) {
      const ok = await call([CRED], 'POST', '/dest_1/credentials/prepare', { [key]: 'tok' });
      expect(ok.status).toBe(200);
    }
  });

  it('reports backend_unavailable without a root key or with an r2 backend lacking a bucket', async () => {
    selectDestination(destinationRow());
    const noKey = await call(
      [CRED],
      'POST',
      '/dest_1/credentials/prepare',
      { secret_value: 's' },
      {}
    );
    expect(noKey.status).toBe(400);
    expect(noKey.body.details.fields[0]).toMatchObject({
      path: 'backend',
      code: 'backend_unavailable',
    });
    const noBucket = await call(
      [CRED],
      'POST',
      '/dest_1/credentials/prepare',
      { secret_value: 's', backend: 'r2_encrypted_object' },
      { OBJECT_ENCRYPTION_ROOT_KEY: ROOT_KEY }
    );
    expect(noBucket.status).toBe(400);
    expect(noBucket.body.details.fields[0].code).toBe('backend_unavailable');
    expect(mockAdapter.execute).not.toHaveBeenCalled();
  });

  it('reserves the next version, writes a d1 secret and records the testing state', async () => {
    selectDestination(
      destinationRow({
        credential_version: 2,
        next_credential_version: 4,
        version: 7,
        credential_ref: D1_REF,
      })
    );
    const res = await call([CRED], 'POST', '/dest_1/credentials/prepare', {
      secret_value: 'top-secret',
      content_type: 'application/json',
    });
    expect(res.status).toBe(200);
    expect(res.body.item).toMatchObject({
      id: 'dest_1',
      rotation_status: 'testing',
      next_credential_version: 5,
      version: 9,
    });
    expect(res.body.item.next_credential_ref).toBe(
      'd1secret://admin/credential_secrets/dest_1/v5#v5'
    );
    expect(res.body.audit_id).toBe('audit_1');
    const sqls = mockAdapter.execute.mock.calls.map(([sql]) => String(sql));
    expect(sqls[0]).toContain('SET next_credential_ref = NULL, next_credential_version = ?');
    expect(mockAdapter.execute.mock.calls[0][1]).toEqual([
      5,
      'admin-1',
      expect.any(Number),
      'dest_1',
      7,
    ]);
    expect(sqls.some((s) => s.includes('INSERT INTO credential_secret_bodies'))).toBe(true);
    const final = must(mockAdapter.execute.mock.calls.at(-1));
    expect(final[0]).toContain('next_credential_version = ? AND next_credential_ref IS NULL');
    expect(final[1]).toEqual([
      'd1secret://admin/credential_secrets/dest_1/v5#v5',
      5,
      'testing',
      'admin-1',
      expect.any(Number),
      'dest_1',
      5,
    ]);
    expect(JSON.stringify(mockAdapter.execute.mock.calls)).not.toContain('top-secret');
    expect(stepUp).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        targetIds: ['dest_1'],
        params: expect.objectContaining({
          kind: 'destination.credential.prepare',
          backend: 'd1_encrypted_table',
          content_type: 'application/json',
          credential_version: 2,
          next_credential_version: 4,
          secret_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      })
    );
    expect(auditWrite).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'storage_destination.credentials.prepare',
        severity: 'warn',
        metadata: expect.objectContaining({
          backend: 'd1_encrypted_table',
          next_credential_version: 5,
        }),
      })
    );
  });

  it('starts at version 1 and prefers r2 when a bucket is bound', async () => {
    selectDestination(destinationRow({ credential_version: null, next_credential_version: null }));
    const put = vi.fn().mockResolvedValue({});
    const res = await call(
      [CRED],
      'POST',
      '/dest_1/credentials/prepare',
      { secret_value: 's' },
      {
        OBJECT_ENCRYPTION_ROOT_KEY: ROOT_KEY,
        SENSITIVE_DETAILS: { put, get: vi.fn(), delete: vi.fn() },
      }
    );
    expect(res.status).toBe(200);
    expect(res.body.item.next_credential_version).toBe(1);
    expect(res.body.item.next_credential_ref).toMatch(/^r2secret:\/\//);
    expect(put).toHaveBeenCalledTimes(1);
    expect(stepUp.mock.calls[0][1]).toMatchObject({
      params: expect.objectContaining({
        backend: 'r2_encrypted_object',
        credential_version: 0,
        next_credential_version: 0,
      }),
    });
  });

  it('honours an explicit d1 backend even when a bucket exists', async () => {
    selectDestination(destinationRow());
    const put = vi.fn();
    const res = await call(
      [CRED],
      'POST',
      '/dest_1/credentials/prepare',
      { secret_value: 's', backend: 'd1_encrypted_table' },
      { OBJECT_ENCRYPTION_ROOT_KEY: ROOT_KEY, SENSITIVE_DETAILS: { put } }
    );
    expect(res.body.item.next_credential_ref).toMatch(/^d1secret:/);
    expect(put).not.toHaveBeenCalled();
  });

  it('ignores an unknown backend name', async () => {
    selectDestination(destinationRow());
    const res = await call([CRED], 'POST', '/dest_1/credentials/prepare', {
      secret_value: 's',
      backend: 'vault',
    });
    expect(res.status).toBe(200);
    expect(res.body.item.next_credential_ref).toMatch(/^d1secret:/);
  });

  it('returns the step-up refusal before touching the database', async () => {
    selectDestination(destinationRow());
    stepUp.mockResolvedValue(new Response('{}', { status: 428 }));
    const res = await call([CRED], 'POST', '/dest_1/credentials/prepare', { secret_value: 's' });
    expect(res.status).toBe(428);
    expect(mockAdapter.execute).not.toHaveBeenCalled();
  });

  it('answers 409 when the version reservation or the pending-ref update lost the race', async () => {
    selectDestination(destinationRow());
    mockAdapter.execute.mockResolvedValueOnce({ rowsAffected: 0 });
    const first = await call([CRED], 'POST', '/dest_1/credentials/prepare', { secret_value: 's' });
    expect(first.status).toBe(409);
    expect(first.body.details.conflict).toEqual({ reason: 'concurrent_modification' });
    expect(mockAdapter.execute).toHaveBeenCalledTimes(1);

    mockAdapter.execute.mockReset().mockImplementation(async (sql: string) => ({
      rowsAffected: String(sql).includes('AND next_credential_ref IS NULL') ? 0 : 1,
    }));
    const second = await call([CRED], 'POST', '/dest_1/credentials/prepare', { secret_value: 's' });
    expect(second.status).toBe(409);
    expect(auditWrite).not.toHaveBeenCalled();
  });
});

describe('credentials/ready', () => {
  it('marks a prepared credential ready', async () => {
    selectDestination(
      destinationRow({
        next_credential_ref: D1_REF,
        next_credential_version: 3,
        rotation_status: 'testing',
        version: 5,
      })
    );
    const res = await call([CRED], 'POST', '/dest_1/credentials/ready');
    expect(res.status).toBe(200);
    expect(res.body.item).toMatchObject({
      id: 'dest_1',
      rotation_status: 'ready',
      next_credential_ref: D1_REF,
      next_credential_version: 3,
      version: 6,
    });
    expect(mockAdapter.execute.mock.calls[0][1]).toEqual([
      'ready',
      'admin-1',
      expect.any(Number),
      'dest_1',
    ]);
    expect(auditWrite).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'storage_destination.credentials.ready',
        result: 'success',
        severity: 'warn',
        metadata: expect.objectContaining({ rotation_status: 'ready', next_credential_version: 3 }),
      })
    );
  });

  it('records failure when nothing is prepared', async () => {
    selectDestination(destinationRow());
    const res = await call([CRED], 'POST', '/dest_1/credentials/ready');
    expect(res.status).toBe(200);
    expect(res.body.item.rotation_status).toBe('failed');
    expect(auditWrite).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ result: 'failure' })
    );
  });
});

describe('credentials/activate', () => {
  const prepared = (extra: Record<string, unknown> = {}) =>
    destinationRow({
      credential_ref: D1_REF,
      credential_version: 1,
      next_credential_ref: 'd1secret://admin/credential_secrets/dest_1/v2#v2',
      next_credential_version: 2,
      rotation_status: 'ready',
      version: 3,
      ...extra,
    });

  it('requires the exact confirmation phrase', async () => {
    selectDestination(prepared());
    const res = await call([CRED], 'POST', '/dest_1/credentials/activate', {
      confirmation: 'nope',
    });
    expect(res.status).toBe(400);
    expect(res.body.details.fields[0]).toEqual({
      path: 'confirmation',
      code: 'confirmation_mismatch',
      message: 'Confirmation must be "ACTIVATE CREDENTIAL archive".',
    });
    expect(mockAdapter.execute).not.toHaveBeenCalled();
  });

  it('switches credentials with the default one-day overlap', async () => {
    selectDestination(prepared());
    const before = Date.now();
    const res = await call([CRED], 'POST', '/dest_1/credentials/activate', {
      confirmation: 'ACTIVATE CREDENTIAL archive',
    });
    expect(res.status).toBe(200);
    expect(res.body.item).toMatchObject({
      credential_ref: 'd1secret://admin/credential_secrets/dest_1/v2#v2',
      credential_version: 2,
      previous_credential_ref: D1_REF,
      rotation_status: 'retiring',
      version: 4,
    });
    const retireAfter = res.body.item.previous_credential_retire_after as number;
    expect(retireAfter - res.body.item.updated_at).toBe(24 * 60 * 60 * 1000);
    expect(retireAfter).toBeGreaterThanOrEqual(before);
    const [sql, params] = mockAdapter.execute.mock.calls[0];
    expect(sql).toContain('version = version + 1');
    expect(params.slice(0, 2)).toEqual(['d1secret://admin/credential_secrets/dest_1/v2#v2', 2]);
    expect(params.slice(2, 4)).toEqual([null, null]);
    expect(params.slice(-2)).toEqual(['dest_1', 3]);
    expect(stepUp.mock.calls[0][1]).toMatchObject({
      targetIds: ['dest_1'],
      params: expect.objectContaining({
        kind: 'destination.credential.activate',
        overlap_ms: 24 * 60 * 60 * 1000,
        previous_credential_ref: D1_REF,
      }),
    });
    expect(auditWrite).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ result: 'success', severity: 'critical' })
    );
  });

  it('honours overlap_ms, capping it at 30 days and ignoring negatives', async () => {
    selectDestination(prepared());
    const url = '/dest_1/credentials/activate';
    const confirmation = 'ACTIVATE CREDENTIAL archive';
    const cases: Array<[unknown, number]> = [
      [0, 0],
      [5000, 5000],
      [365 * 24 * 60 * 60 * 1000, 30 * 24 * 60 * 60 * 1000],
      [-1, 24 * 60 * 60 * 1000],
      ['5', 24 * 60 * 60 * 1000],
    ];
    for (const [overlap_ms, expected] of cases) {
      const res = await call([CRED], 'POST', url, { confirmation, overlap_ms });
      expect(res.body.item.previous_credential_retire_after - res.body.item.updated_at).toBe(
        expected
      );
    }
  });

  it('keeps the first activation without a previous credential active', async () => {
    selectDestination(prepared({ credential_ref: null, credential_version: 0 }));
    const res = await call([CRED], 'POST', '/dest_1/credentials/activate', {
      confirmation: 'ACTIVATE CREDENTIAL archive',
    });
    expect(res.body.item).toMatchObject({
      rotation_status: 'active',
      previous_credential_ref: null,
    });
    expect(res.body.item.previous_credential_retire_after).toBeNull();
  });

  it('does not gate a failed activation (nothing prepared) and audits a failure', async () => {
    selectDestination(destinationRow());
    stepUp.mockResolvedValue(new Response('{}', { status: 428 }));
    const res = await call([CRED], 'POST', '/dest_1/credentials/activate', {
      confirmation: 'ACTIVATE CREDENTIAL archive',
    });
    expect(res.status).toBe(200);
    expect(stepUp).not.toHaveBeenCalled();
    expect(res.body.item.rotation_status).toBe('failed');
    expect(auditWrite).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ result: 'failure' })
    );
  });

  it('returns the step-up refusal for a real switch and 409 on a lost compare-and-set', async () => {
    selectDestination(prepared());
    stepUp.mockResolvedValueOnce(new Response('{}', { status: 428 }));
    const refused = await call([CRED], 'POST', '/dest_1/credentials/activate', {
      confirmation: 'ACTIVATE CREDENTIAL archive',
    });
    expect(refused.status).toBe(428);
    expect(mockAdapter.execute).not.toHaveBeenCalled();

    mockAdapter.execute.mockResolvedValue({ rowsAffected: 0 });
    const lost = await call([CRED], 'POST', '/dest_1/credentials/activate', {
      confirmation: 'ACTIVATE CREDENTIAL archive',
    });
    expect(lost.status).toBe(409);
    expect(lost.body.details.conflict.reason).toBe('concurrent_modification');
    expect(auditWrite).not.toHaveBeenCalled();
  });
});

describe('credentials/retire-previous', () => {
  const retiring = (extra: Record<string, unknown> = {}) =>
    destinationRow({
      credential_ref: 'd1secret://admin/credential_secrets/dest_1/v2#v2',
      credential_version: 2,
      previous_credential_ref: D1_REF,
      previous_credential_retire_after: Date.now() - 1000,
      rotation_status: 'retiring',
      version: 6,
      ...extra,
    });
  const url = '/dest_1/credentials/retire-previous';

  it('rejects when no previous credential exists', async () => {
    selectDestination(destinationRow());
    const res = await call([CRED], 'POST', url, {});
    expect(res.status).toBe(400);
    expect(res.body.details.fields[0]).toMatchObject({
      path: 'previous_credential_ref',
      code: 'invalid_state',
    });
  });

  it('retires an elapsed previous credential without confirmation', async () => {
    selectDestination(retiring());
    const res = await call([CRED], 'POST', url, {});
    expect(res.status).toBe(200);
    expect(res.body.item).toMatchObject({
      previous_credential_ref: null,
      previous_credential_retire_after: null,
      rotation_status: 'none',
      version: 7,
    });
    expect(
      mockAdapter.execute.mock.calls
        .map(([s]) => String(s))
        .some((s) => s.includes('credential_secret_metadata'))
    ).toBe(true);
    expect(auditWrite).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        severity: 'warn',
        metadata: expect.objectContaining({
          forced: false,
          backend: 'd1_encrypted_table',
          retired_credential_ref: D1_REF,
        }),
      })
    );
  });

  it('requires confirmation to force-retire before the overlap elapsed', async () => {
    const retireAfter = Date.now() + 60_000;
    selectDestination(retiring({ previous_credential_retire_after: retireAfter }));
    const denied = await call([CRED], 'POST', url, { confirmation: 'x' });
    expect(denied.status).toBe(400);
    expect(denied.body.details.fields[0].message).toBe(
      'Confirmation must be "RETIRE CREDENTIAL archive".'
    );
    expect(mockAdapter.execute).not.toHaveBeenCalled();

    const forced = await call([CRED], 'POST', url, { confirmation: 'RETIRE CREDENTIAL archive' });
    expect(forced.status).toBe(200);
    expect(forced.body.item).toMatchObject({
      rotation_status: 'none',
      previous_credential_ref: null,
    });
    expect(auditWrite).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        severity: 'critical',
        metadata: expect.objectContaining({
          forced: true,
          previous_credential_retire_after: retireAfter,
        }),
      })
    );
  });

  it('keeps the state when a non-elapsed retirement is not forced by a missing retire_after of 0', async () => {
    selectDestination(
      retiring({ previous_credential_retire_after: null, rotation_status: 'retiring' })
    );
    const res = await call([CRED], 'POST', url, {});
    expect(res.status).toBe(200);
    expect(res.body.item.rotation_status).toBe('retiring');
    expect(res.body.item.previous_credential_ref).toBe(D1_REF);
  });

  it('reports backend_unavailable for unknown schemes or a missing root key', async () => {
    selectDestination(retiring({ previous_credential_ref: 'extsecret://vault/x#v1' }));
    const ext = await call([CRED], 'POST', url, {});
    expect(ext.status).toBe(400);
    expect(ext.body.details.fields[0]).toMatchObject({
      path: 'backend',
      code: 'backend_unavailable',
    });
    selectDestination(retiring());
    const noKey = await call([CRED], 'POST', url, {}, {});
    expect(noKey.body.details.fields[0].code).toBe('backend_unavailable');
    selectDestination(retiring({ previous_credential_ref: 'r2secret://admin-secrets/x#v1' }));
    const r2 = await call([CRED], 'POST', url, {});
    expect(r2.body.details.fields[0].code).toBe('backend_unavailable');
  });
});
