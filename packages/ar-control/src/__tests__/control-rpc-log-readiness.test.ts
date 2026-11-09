import {
  logIcebergReadinessAttemptDigest,
  type LogIcebergReadinessResult,
} from '@authrim/ar-lib-core/services/log-iceberg-readiness';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ControlWorker from '../index';
import type { ControlEnv, ControlRpcProps } from '../types';

const mocks = vi.hoisted(() => ({
  admit: vi.fn(),
  advanceBootstrap: vi.fn(),
  advanceLog: vi.fn(),
  release: vi.fn(),
  readInventory: vi.fn(),
}));

vi.mock('../bootstrap-accelerator', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../bootstrap-accelerator')>()),
  admitInitialBootstrapAcceleration: mocks.admit,
  advanceInitialBootstrap: mocks.advanceBootstrap,
  releaseInitialBootstrapAcceleration: mocks.release,
}));
vi.mock('../log-archive-readiness', () => ({ advanceLogArchiveReadiness: mocks.advanceLog }));
vi.mock('../environment-replication-inventory', () => ({
  readControlEnvironmentReplicationInventory: mocks.readInventory,
}));

const ATTEMPT = {
  attemptId: '12345678-1234-4123-8123-123456789abc',
  startedAt: '2026-11-09T00:00:00.000Z',
  deploymentFingerprint: 'a'.repeat(64),
};

function worker(props: Partial<ControlRpcProps> = {}, overrides: Partial<ControlEnv> = {}) {
  const env = {
    AUTHRIM_ENVIRONMENT_NAME: 'test',
    CONTROL_DB: {} as D1Database,
    ...overrides,
  } as ControlEnv;
  const control = new ControlWorker(
    {
      props: {
        caller: 'ar-management',
        audience: 'authrim-control-v1',
        environmentId: 'test',
        ...props,
      },
    } as ConstructorParameters<typeof ControlWorker>[0],
    env
  );
  return { control, env };
}

function request(
  body: unknown,
  options: { authorization?: string; action?: string | null; method?: string } = {}
) {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (options.authorization !== null) {
    headers.set('Authorization', options.authorization ?? 'Bearer a.b.c');
  }
  if (options.action !== null) {
    headers.set('X-Authrim-Bootstrap-Action', options.action ?? 'log_archive_readiness');
  }
  return new Request('https://control.internal/api/internal/control/bootstrap/advance', {
    method: options.method ?? 'POST',
    headers,
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
}

async function admitLogAttempt(probeDigest?: string) {
  const claims = {
    iss: 'authrim-setup:test',
    aud: 'authrim-control:test',
    iat: 100,
    exp: 115,
    jti: 'proof-a',
    purpose: 'log_archive_readiness' as const,
    environmentId: 'test',
    probeDigest: probeDigest ?? (await logIcebergReadinessAttemptDigest(ATTEMPT)),
  };
  mocks.admit.mockResolvedValue({ state: 'acquired', claims });
  return claims;
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.release.mockResolvedValue(undefined);
});

describe('Control log archive readiness HTTP boundary', () => {
  it('rejects malformed bearer tokens and unknown actions before admission', async () => {
    const { control } = worker();
    const noToken = await control.fetch(request(ATTEMPT, { authorization: 'Basic abc' }));
    const wrongAction = await control.fetch(request(ATTEMPT, { action: 'cleanup' }));

    expect(noToken.status).toBe(401);
    expect(noToken.headers.get('WWW-Authenticate')).toBe('Bearer');
    expect(noToken.headers.get('Cache-Control')).toBe('no-store');
    expect(wrongAction.status).toBe(400);
    expect(mocks.admit).not.toHaveBeenCalled();
    expect(mocks.advanceLog).not.toHaveBeenCalled();
  });

  it('does not accept a rejected proof or release a lease it never acquired', async () => {
    const { control } = worker();
    mocks.admit.mockRejectedValue(new Error('private signature details'));

    const response = await control.fetch(request(ATTEMPT));

    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toBe('Bearer');
    expect(mocks.release).not.toHaveBeenCalled();
    expect(mocks.advanceLog).not.toHaveBeenCalled();
  });

  it('does not probe or release a lease held by another request', async () => {
    const { control } = worker();
    mocks.admit.mockResolvedValue({ state: 'busy' });

    const response = await control.fetch(request(ATTEMPT));

    expect(response.status).toBe(202);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(mocks.advanceLog).not.toHaveBeenCalled();
    expect(mocks.release).not.toHaveBeenCalled();
  });

  it.each([
    ['malformed JSON', '{'],
    ['extra caller-controlled field', { ...ATTEMPT, tenantId: 'other' }],
    ['invalid attempt identifier', { ...ATTEMPT, attemptId: '../other' }],
  ])('rejects %s after admission and always releases the lease', async (_name, body) => {
    const { control, env } = worker();
    const claims = await admitLogAttempt();

    const response = await control.fetch(request(body));

    expect(response.status).toBe(503);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('X-Authrim-Error-Code')).toBe(
      'bootstrap_accelerator_advance_failed'
    );
    expect(mocks.advanceLog).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledExactlyOnceWith({ env, claims });
  });

  it('binds the request body to the signed digest before contacting Management', async () => {
    const { control, env } = worker();
    const claims = await admitLogAttempt('b'.repeat(64));

    const response = await control.fetch(request(ATTEMPT));

    expect(response.status).toBe(503);
    expect(response.headers.get('X-Authrim-Error-Code')).toBe(
      'runtime_smoke_log_archive_scope_denied'
    );
    expect(mocks.advanceLog).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledExactlyOnceWith({ env, claims });
  });

  it.each(['pending', 'ready'] as const)(
    'returns a no-store %s proof and releases the lease after the probe',
    async (state) => {
      const { control, env } = worker();
      const claims = await admitLogAttempt();
      const proof: LogIcebergReadinessResult = {
        ...ATTEMPT,
        state,
        mode: 'pipeline',
        generation: 'generation-a',
        schemaVersion: 1,
        keyVersion: 1,
        tableUuid: 'table-a',
        physicalFingerprint: 'b'.repeat(64),
        eventId: 'event-a',
        snapshotId: state === 'ready' ? 'snapshot-a' : null,
        checkedAt: '2026-11-09T00:00:01.000Z',
      };
      mocks.advanceLog.mockResolvedValue(proof);

      const response = await control.fetch(request(ATTEMPT));

      expect(response.status).toBe(state === 'ready' ? 200 : 202);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(await response.json()).toEqual(proof);
      expect(mocks.admit).toHaveBeenCalledExactlyOnceWith({
        env,
        proof: 'a.b.c',
        purpose: 'log_archive_readiness',
      });
      expect(mocks.advanceLog).toHaveBeenCalledExactlyOnceWith(env, ATTEMPT);
      expect(mocks.release).toHaveBeenCalledExactlyOnceWith({ env, claims });
    }
  );

  it('redacts unexpected probe errors and still releases the lease', async () => {
    const { control, env } = worker();
    const claims = await admitLogAttempt();
    mocks.advanceLog.mockRejectedValue(new Error('private provider response'));

    const response = await control.fetch(request(ATTEMPT));

    expect(response.status).toBe(503);
    expect(response.headers.get('X-Authrim-Error-Code')).toBe(
      'bootstrap_accelerator_advance_failed'
    );
    expect(await response.text()).toBe('');
    expect(mocks.release).toHaveBeenCalledExactlyOnceWith({ env, claims });
  });
});

describe('Control environment inventory RPC boundary', () => {
  it('accepts only management in the matching environment with an exact empty input', async () => {
    const { control, env } = worker();
    const inventory = { environmentId: 'test', workers: [] };
    mocks.readInventory.mockResolvedValue(inventory);

    await expect(control.getEnvironmentReplicationInventory({})).resolves.toBe(inventory);
    expect(mocks.readInventory).toHaveBeenCalledExactlyOnceWith(env.CONTROL_DB, 'test');

    await expect(
      worker({ caller: 'ar-lib-core' }).control.getEnvironmentReplicationInventory({})
    ).rejects.toThrow('control_rpc_caller_unauthorized');
    await expect(
      worker({ environmentId: 'other' }).control.getEnvironmentReplicationInventory({})
    ).rejects.toThrow('control_rpc_caller_unauthorized');
    await expect(control.getEnvironmentReplicationInventory({ tenantId: 'other' })).rejects.toThrow(
      'invalid_replication_environment_inventory'
    );
    expect(mocks.readInventory).toHaveBeenCalledTimes(1);
  });

  it('masks repository exceptions without leaking private details', async () => {
    const { control } = worker();
    mocks.readInventory.mockRejectedValue(new Error('private tenant database ID'));

    await expect(control.getEnvironmentReplicationInventory({})).rejects.toThrow(
      'control_internal_error'
    );
  });
});
