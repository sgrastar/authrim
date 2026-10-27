import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LogArchiveWriteEntrypoint } from '../LogArchiveWriteEntrypoint';
import type { Env } from '../../types/env';
import {
  createLogIcebergWritePort,
  type LogArchiveWriteServiceBinding,
} from '../../services/log-iceberg-runtime';
import { hasTenantBackupMutationCoverage } from '../../services/tenant-portability/covered-mutation';

vi.mock('../../services/log-iceberg-config', async (original) => ({
  ...(await original<typeof import('../../services/log-iceberg-config')>()),
  resolveLogIcebergConfig: vi.fn(),
  assertLogIcebergActivated: vi.fn(),
}));
vi.mock('../../services/log-iceberg-runtime', async (original) => ({
  ...(await original<typeof import('../../services/log-iceberg-runtime')>()),
  createLogIcebergWritePort: vi.fn(),
}));
const reservation = {
  tenantId: 'tenant-a',
  eventId: `sia:v1:${'a'.repeat(64)}`,
  logicalHmac: 'b'.repeat(64),
  failedAt: 1234,
};
const replication = {
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
};
function fixture(extra: Partial<Env> = {}, caller = 'ar-management') {
  const control = {
    acquireEnvironmentBackupMutationPermit: vi.fn(async () => ({ admitted: true })),
    completeEnvironmentBackupMutationPermit: vi.fn(async () => {}),
  };
  const env = {
    AUTHRIM_ENVIRONMENT_NAME: 'test',
    ENABLE_SAML_DR_EXPORT: 'true',
    SAML_DR_MUTATION_CONTROL: control,
    ...extra,
  } as Env;
  const entry = new LogArchiveWriteEntrypoint(
    {
      props: { caller, audience: 'authrim-log-archive-v1', environmentId: 'test' },
      waitUntil: vi.fn(),
    } as ConstructorParameters<typeof LogArchiveWriteEntrypoint>[0],
    env
  );
  return { env, entry, control };
}
function port(): LogArchiveWriteServiceBinding {
  return {
    registerPiiPurgeScope: vi.fn(async () => {}),
    resolveTenantKey: vi.fn(async () => 'key-a'),
    readPolicyArtifact: vi.fn(async () => null),
    reserveCorePublication: vi.fn(async () => ({
      sourceToken: crypto.randomUUID(),
      state: 'prepared',
    })),
    prepareCorePublication: vi.fn(async () => {}),
    publishCorePublication: vi.fn(async () => ({ state: 'published' })),
    reconcileCorePublications: vi.fn(async () => ({ published: 0, aborted: 0, retained: 0 })),
    reserveSignInAttempt: vi.fn(async () => ({ failedAt: reservation.failedAt })),
    commitSignInAttempt: vi.fn(async () => {}),
    writeRecords: vi.fn(async () => ({ stored: 1, queued: 0 })),
    preparePipelineReferences: vi.fn(async () => []),
    dispatchPipelineReferences: vi.fn(async () => {}),
  };
}
beforeEach(() => {
  vi.mocked(createLogIcebergWritePort).mockReset();
});
afterEach(() => vi.unstubAllGlobals());

describe('internal log RPC environment admission', () => {
  it('refuses new writes before constructing a port when draining, preserving readonly separation', async () => {
    const f = fixture(),
      p = port();
    vi.mocked(createLogIcebergWritePort).mockReturnValue(p);
    f.control.acquireEnvironmentBackupMutationPermit.mockResolvedValue({ admitted: false });
    await expect(f.entry.reserveSignInAttempt(reservation)).rejects.toThrow(
      'backup_mutation_unavailable'
    );
    expect(createLogIcebergWritePort).not.toHaveBeenCalled();
    await expect(f.entry.resolveTenantKey('tenant-a')).resolves.toBe('key-a');
    expect(f.control.acquireEnvironmentBackupMutationPermit).toHaveBeenCalledTimes(1);
  });
  it('constructs the writer from the covered environment and observes caught native DB write uncertainty', async () => {
    const run = vi.fn(async () => {
      throw new Error('unknown DB outcome');
    });
    const db = { prepare: vi.fn(() => ({ run })), batch: vi.fn() };
    const f = fixture({ ...replication, DB: db as unknown as D1Database });
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
    vi.mocked(createLogIcebergWritePort).mockImplementation((covered) => {
      expect(hasTenantBackupMutationCoverage(covered, { environment: true })).toBe(true);
      expect(covered.DB).not.toBe(db);
      const p = port();
      p.reserveSignInAttempt = async () => {
        const source = covered.DB as D1Database;
        try {
          await source.prepare('INSERT INTO observed VALUES(1)').run();
        } catch {
          /* application catch cannot manufacture rollback proof */
        }
        return { failedAt: reservation.failedAt };
      };
      return p;
    });
    await expect(f.entry.reserveSignInAttempt(reservation)).rejects.toThrow(
      'replication_writer_outcome_unknown'
    );
    expect(run).toHaveBeenCalledOnce();
    expect(requests).toEqual(['environmentEnter']);
    expect(f.control.completeEnvironmentBackupMutationPermit).toHaveBeenCalledOnce();
  });
  it('does not skip a replication authority refusal or authenticate an unlisted caller', async () => {
    const f = fixture(replication);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ error: 'draining' }, { status: 409 }))
    );
    await expect(f.entry.reserveSignInAttempt(reservation)).rejects.toThrow();
    expect(createLogIcebergWritePort).not.toHaveBeenCalled();
    expect(() => fixture({}, 'unlisted-worker').entry.registerPiiPurgeScope('tenant-a')).toThrow(
      'log_iceberg_rpc_caller_denied'
    );
  });
});
