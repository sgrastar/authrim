import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ControlEnv, ControlRpcProps } from '../types';

const mocks = vi.hoisted(() => ({
  permit: vi.fn(),
  boundary: vi.fn(),
  lookup: vi.fn(),
  hmac: vi.fn(),
  plugin: vi.fn(),
  scan: vi.fn(),
  verify: vi.fn(),
  drain: vi.fn(),
  provisioningReady: vi.fn(),
}));
vi.mock('../tenant-backup-mutation-permits', async (original) => ({
  ...(await original<typeof import('../tenant-backup-mutation-permits')>()),
  controlTenantMutationPermit: mocks.permit,
}));
vi.mock('../tenant-backup-boundary', () => ({ controlTenantBackupBoundary: mocks.boundary }));
vi.mock('../lookup-registry-publisher', async (original) => ({
  ...(await original<typeof import('../lookup-registry-publisher')>()),
  LookupRegistryPublisher: class {
    publishEnvironment = mocks.lookup;
  },
}));
vi.mock('../lookup-hmac-key-state-publisher', async (original) => ({
  ...(await original<typeof import('../lookup-hmac-key-state-publisher')>()),
  LookupHmacKeyStatePublisher: class {
    publishEnvironment = mocks.hmac;
  },
}));
vi.mock('../plugin-runner-registry-publisher', async (original) => ({
  ...(await original<typeof import('../plugin-runner-registry-publisher')>()),
  PluginRunnerRegistryPublisher: class {
    publishEnvironment = mocks.plugin;
  },
}));
vi.mock('../r2-bucket-metrics', async (original) => ({
  ...(await original<typeof import('../r2-bucket-metrics')>()),
  scanControlR2BucketMetrics: mocks.scan,
}));
vi.mock('../signing-key-candidate-verifier', async (original) => ({
  ...(await original<typeof import('../signing-key-candidate-verifier')>()),
  SigningKeyCandidateVerifier: class {
    reconcile = mocks.verify;
  },
}));
vi.mock('../lookup-hmac-candidate-verifier', async (original) => ({
  ...(await original<typeof import('../lookup-hmac-candidate-verifier')>()),
  LookupHmacCandidateVerifier: class {
    reconcile = mocks.verify;
  },
}));
vi.mock('../tenant-disaster-recovery', async (original) => ({
  ...(await original<typeof import('../tenant-disaster-recovery')>()),
  TenantDisasterRecoveryService: class {
    reconcileDrain = mocks.drain;
  },
}));
vi.mock('../repository', async (original) => ({
  ...(await original<typeof import('../repository')>()),
  D1ControlRepository: class {
    hasReadyAutomaticProvisioning = mocks.provisioningReady;
  },
}));
import ControlWorker, { SAML_DR_CONTROL_SURFACE } from '../index';

function worker(overrides: Partial<ControlEnv> = {}, props: Partial<ControlRpcProps> = {}) {
  const prepare = vi.fn(() => {
    throw new Error('source_database_accessed');
  });
  const waitUntil = vi.fn();
  const env = {
    ENABLE_SAML_DR_EXPORT: 'true',
    AUTHRIM_ENVIRONMENT_NAME: 'test',
    CONTROL_DB: { prepare },
    ...overrides,
  } as ControlEnv;
  const value = new ControlWorker(
    {
      props: {
        caller: 'ar-management',
        audience: 'authrim-control-v1',
        environmentId: 'test',
        ...props,
      },
      waitUntil,
    } as unknown as ConstructorParameters<typeof ControlWorker>[0],
    env
  );
  return { value, prepare, waitUntil };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.permit.mockResolvedValue({ admitted: false });
  mocks.boundary.mockResolvedValue({ accepted: true });
  mocks.lookup.mockResolvedValue({ generation: 1 });
  mocks.hmac.mockResolvedValue({ generation: 1 });
  mocks.plugin.mockResolvedValue({ generation: 1 });
  mocks.scan.mockResolvedValue(undefined);
  mocks.verify.mockResolvedValue(undefined);
  mocks.drain.mockResolvedValue(undefined);
  mocks.provisioningReady.mockResolvedValue(false);
});
describe('Control SAML DR writer boundary', () => {
  it('catalogues every public method, with no callable private bypass', () => {
    const actual = Object.getOwnPropertyNames(ControlWorker.prototype)
      .filter((name) => name !== 'constructor')
      .sort();
    const names = Object.values(SAML_DR_CONTROL_SURFACE).flat();
    expect(new Set(names).size).toBe(names.length);
    expect(names.sort()).toEqual(actual);
  });
  it.each(SAML_DR_CONTROL_SURFACE.guarded.filter((name) => name !== 'fetch'))(
    'rejects %s before source writes when a boundary is held',
    async (name) => {
      const instance = worker();
      const callable = instance.value[name] as (input?: unknown) => Promise<unknown>;
      await expect(callable.call(instance.value)).rejects.toThrow('backup_mutation_unavailable');
      expect(instance.prepare).not.toHaveBeenCalled();
      expect(mocks.permit).toHaveBeenCalledOnce();
      expect(mocks.permit).toHaveBeenCalledWith(
        expect.objectContaining({ caller: 'ar-control', scope: 'environment', action: 'acquire' })
      );
      expect(mocks.lookup).not.toHaveBeenCalled();
      expect(mocks.hmac).not.toHaveBeenCalled();
      expect(mocks.plugin).not.toHaveBeenCalled();
    }
  );
  it('rejects bootstrap mutation HTTP with 503 while inspection HTTP stays available', async () => {
    const { value, prepare } = worker();
    expect(
      (
        await value.fetch(
          new Request('https://control.test/api/internal/control/bootstrap/advance', {
            method: 'POST',
          })
        )
      ).status
    ).toBe(503);
    expect((await value.fetch(new Request('https://control.test/unknown'))).status).toBe(404);
    expect(prepare).not.toHaveBeenCalled();
    expect(mocks.permit).toHaveBeenCalledOnce();
  });
  it('rejects mismatched binding environment before taking a local permit', async () => {
    const { value } = worker({}, { environmentId: 'other' });
    await expect(value.publishTenantBackupRuntimeState()).rejects.toThrow(
      'control_rpc_caller_unauthorized'
    );
    expect(mocks.permit).not.toHaveBeenCalled();
  });
  it('keeps boundary bookkeeping available and always selects strict mode when opted in', async () => {
    const { value } = worker();
    await expect(value.tenantBackupSnapshotBoundary({ action: 'release' })).resolves.toEqual({
      accepted: true,
    });
    expect(mocks.permit).not.toHaveBeenCalled();
    expect(mocks.boundary).toHaveBeenCalledWith(
      expect.objectContaining({ strictIncompletePermits: true })
    );
  });
  it('waits for all concurrent publications even when one fails first', async () => {
    mocks.permit.mockResolvedValue({ admitted: true });
    let finish!: () => void;
    mocks.lookup.mockRejectedValue(new Error('source_failure'));
    mocks.hmac.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      })
    );
    const instance = worker();
    const pending = instance.value.publishTenantBackupRuntimeState();
    const result = expect(pending).rejects.toThrow('control_internal_error');
    await vi.waitFor(() => expect(instance.waitUntil).toHaveBeenCalledTimes(3));
    expect(mocks.permit.mock.calls.map(([call]) => (call as { action: string }).action)).toEqual([
      'acquire',
    ]);
    finish();
    await result;
    expect(mocks.permit.mock.calls.map(([call]) => (call as { action: string }).action)).toEqual([
      'acquire',
      'complete',
    ]);
  });
  it('does not release scheduled admission after startup failure while an earlier task still writes', async () => {
    mocks.permit.mockResolvedValue({ admitted: true });
    let finish!: () => void;
    mocks.scan.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      })
    );
    mocks.provisioningReady.mockRejectedValue(new Error('startup_failed'));
    const instance = worker({
      AUTHRIM_AUTOMATIC_PROVISIONING: 'true',
      CLOUDFLARE_D1_API_TOKEN: 'local-d1',
      CLOUDFLARE_WORKERS_API_TOKEN: 'local-workers',
    });
    const pending = instance.value.scheduled();
    const result = expect(pending).rejects.toThrow('startup_failed');
    await vi.waitFor(() => expect(mocks.provisioningReady).toHaveBeenCalledOnce());
    expect(instance.waitUntil).toHaveBeenCalledTimes(4);
    expect(mocks.permit.mock.calls.map(([call]) => (call as { action: string }).action)).toEqual([
      'acquire',
    ]);
    finish();
    await result;
    expect(mocks.permit.mock.calls.map(([call]) => (call as { action: string }).action)).toEqual([
      'acquire',
      'complete',
    ]);
  });
});
