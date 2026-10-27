import { exportJWK, generateKeyPair, type JWK } from 'jose';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { RuntimeSmokeEntrypoint, type RuntimeSmokeEntrypointEnv } from '../RuntimeSmokeEntrypoint';
import { hasTenantBackupMutationCoverage } from '../../services/tenant-portability/covered-mutation';
import { signRuntimeSmokeRequest } from '../../services/control-plane/runtime-smoke-rpc';
import {
  logIcebergReadinessAttemptDigest,
  probeLogIcebergReadiness,
} from '../../services/log-iceberg-readiness';
vi.mock('../../services/log-iceberg-readiness', async (original) => ({
  ...(await original<typeof import('../../services/log-iceberg-readiness')>()),
  probeLogIcebergReadiness: vi.fn(async () => ({ state: 'pending' })),
}));
let privateJwk: JWK, publicJwks: string;
beforeAll(async () => {
  const pair = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  privateJwk = { ...(await exportJWK(pair.privateKey)), kid: 'smoke-key', alg: 'EdDSA' };
  publicJwks = JSON.stringify({
    keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'smoke-key', alg: 'EdDSA' }],
  });
});
beforeEach(() => {
  vi.mocked(probeLogIcebergReadiness).mockReset().mockResolvedValue({ state: 'pending' });
});
afterEach(() => vi.unstubAllGlobals());
const attempt = {
  attemptId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  startedAt: new Date().toISOString(),
  deploymentFingerprint: 'd'.repeat(64),
};
function worker(
  caller = 'ar-control',
  target = 'test-ar-management',
  extra: Partial<RuntimeSmokeEntrypointEnv> = {}
) {
  return new RuntimeSmokeEntrypoint(
    {
      props: {
        caller,
        audience: 'authrim-runtime-smoke-v1',
        environmentId: 'test',
        targetWorker: target,
      },
    } as ConstructorParameters<typeof RuntimeSmokeEntrypoint>[0],
    {
      AUTHRIM_ENVIRONMENT_NAME: 'test',
      AUTHRIM_WORKER_SCRIPT_NAME: target,
      CONTROL_SMOKE_VERIFYING_PUBLIC_JWKS: publicJwks,
      AUTHRIM_LOG_ARCHIVE_MODE: 'scheduled',
      AUTHRIM_LOG_ARCHIVE_STORAGE_GENERATION: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      AUTHRIM_LOG_ARCHIVE_SCHEMA_VERSION: '1',
      AUTHRIM_LOG_ARCHIVE_ACTIVATED_AT: '2026-10-27T00:00:00.000Z',
      AUTHRIM_LOG_ARCHIVE_ACCOUNT_ID: 'a'.repeat(32),
      AUTHRIM_LOG_ARCHIVE_BUCKET: 'authrim-test',
      AUTHRIM_LOG_ARCHIVE_CATALOG_URI: `https://catalog.cloudflarestorage.com/${'a'.repeat(32)}/authrim-test`,
      AUTHRIM_LOG_ARCHIVE_WAREHOUSE: `${'a'.repeat(32)}_authrim-test`,
      AUTHRIM_LOG_ARCHIVE_NAMESPACE: 'authrim',
      AUTHRIM_LOG_ARCHIVE_TABLE: 'logs_v1',
      AUTHRIM_LOG_ARCHIVE_TABLE_UUID: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      AUTHRIM_LOG_ARCHIVE_PHYSICAL_FINGERPRINT: 'f'.repeat(64),
      AUTHRIM_LOG_ARCHIVE_DB_RETENTION_DAYS: '7',
      AUTHRIM_LOG_ARCHIVE_EXPORT_INTERVAL_MINUTES: '5',
      ...extra,
    }
  );
}
async function token(operationId?: string) {
  operationId ??= `log_archive_probe_v1:${await logIcebergReadinessAttemptDigest(attempt)}`;
  return signRuntimeSmokeRequest({
    privateJwk,
    keyId: 'smoke-key',
    request: {
      environmentId: 'test',
      operationId,
      attempt: 1,
      targetWorker: 'test-ar-management',
      bindingRef: operationId.startsWith('log_archive_probe_v1:')
        ? 'LOG_ARCHIVE'
        : 'TEST_TDB_DEFAULT_CORE',
      expectedMigrationGeneration: 1,
      dataRole: 'tenant_core/default',
      residencyPartition: 'platform',
    },
  });
}
describe('private log archive bootstrap probe authority', () => {
  it('uses only Control props and an attempt-bound signature; HTTP stays unavailable', async () => {
    const entry = worker();
    expect(entry.fetch().status).toBe(404);
    await entry.probeLogArchive({ token: await token(), attempt });
    expect(probeLogIcebergReadiness).toHaveBeenCalledOnce();
  });
  it('requires the environment permit only after verifying the signed probe purpose', async () => {
    const control = {
      acquireEnvironmentBackupMutationPermit: vi.fn(async () => ({ admitted: false })),
      completeEnvironmentBackupMutationPermit: vi.fn(async () => {}),
    };
    const entry = worker('ar-control', 'test-ar-management', {
      ENABLE_SAML_DR_EXPORT: 'true',
      SAML_DR_MUTATION_CONTROL: control,
    });
    await expect(
      entry.probeLogArchive({ token: await token('ordinary-db-smoke'), attempt })
    ).rejects.toThrow('scope_denied');
    expect(control.acquireEnvironmentBackupMutationPermit).not.toHaveBeenCalled();
    await expect(entry.probeLogArchive({ token: await token(), attempt })).rejects.toThrow(
      'probe_failed'
    );
    expect(control.acquireEnvironmentBackupMutationPermit).toHaveBeenCalledOnce();
    expect(probeLogIcebergReadiness).not.toHaveBeenCalled();
  });
  it('observes caught R2 uncertainty inside the signed probe instead of completing replication', async () => {
    const requests: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init: RequestInit) => {
        const body: unknown = JSON.parse(typeof init.body === 'string' ? init.body : '{}');
        if (!body || typeof body !== 'object' || !('payload' in body) || !('action' in body))
          throw new Error('invalid authority request');
        requests.push(String(body.action));
        return Response.json(body.payload);
      })
    );
    const put = vi.fn(async () => {
      throw new Error('unknown R2 outcome');
    });
    const bucket = { get: vi.fn(), put, delete: vi.fn() };
    const control = {
      acquireEnvironmentBackupMutationPermit: vi.fn(async () => ({ admitted: true })),
      completeEnvironmentBackupMutationPermit: vi.fn(async () => {}),
    };
    const entry = worker('ar-control', 'test-ar-management', {
      ENABLE_SAML_DR_EXPORT: 'true',
      SAML_DR_MUTATION_CONTROL: control,
      AUTHRIM_REPLICATION_WRITER: JSON.stringify({
        version: 2,
        endpoint: 'https://authority.example.test/replication/v1/rpc',
        credentialId: 'writer-a',
        pairId: 'pair-a',
        environmentId: 'test',
        deploymentId: 'cf-a',
        epoch: 1,
        generationId: 'gen-a',
      }),
      AUTHRIM_REPLICATION_WRITER_SECRET: 'a'.repeat(64),
      LOG_ARCHIVE: bucket as unknown as R2Bucket,
    });
    vi.mocked(probeLogIcebergReadiness).mockImplementationOnce(async (covered) => {
      expect(hasTenantBackupMutationCoverage(covered, { environment: true })).toBe(true);
      expect(covered.LOG_ARCHIVE).not.toBe(bucket);
      try {
        await covered.LOG_ARCHIVE?.put('readiness-proof', 'x');
      } catch {
        /* provider return does not prove rollback */
      }
      return { state: 'pending' };
    });
    await expect(entry.probeLogArchive({ token: await token(), attempt })).rejects.toThrow(
      'probe_failed'
    );
    expect(put).toHaveBeenCalledOnce();
    expect(requests).toEqual(['environmentEnter']);
    expect(control.completeEnvironmentBackupMutationPermit).toHaveBeenCalledOnce();
  });
  it('rejects ordinary callers, another Worker target, another signed purpose, and caller-selected tenant scope', async () => {
    const valid = await token();
    await expect(worker('ar-auth').probeLogArchive({ token: valid, attempt })).rejects.toThrow(
      'unauthorized'
    );
    await expect(
      worker('ar-control', 'test-ar-auth').probeLogArchive({ token: valid, attempt })
    ).rejects.toThrow('target_denied');
    await expect(
      worker().probeLogArchive({ token: await token('ordinary-db-smoke'), attempt })
    ).rejects.toThrow('scope_denied');
    await expect(
      worker().probeLogArchive({ token: valid, attempt: { ...attempt, tenantId: 'tenant-a' } })
    ).rejects.toThrow('attempt_invalid');
    await expect(
      worker().probeLogArchive({
        token: valid,
        attempt: { ...attempt, deploymentFingerprint: 'e'.repeat(64) },
      })
    ).rejects.toThrow('scope_denied');
    expect(probeLogIcebergReadiness).not.toHaveBeenCalled();
  });
});
