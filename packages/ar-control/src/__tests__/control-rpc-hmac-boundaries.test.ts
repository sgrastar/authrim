import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ControlEnv, ControlRpcProps } from '../types';

const mocks = vi.hoisted(() => ({
  initialize: vi.fn(),
  activate: vi.fn(),
  beginVerification: vi.fn(),
  claimNext: vi.fn(),
  checkpoint: vi.fn(),
  completeGrace: vi.fn(),
  getRotation: vi.fn(),
  publish: vi.fn(),
}));

vi.mock('../lookup-hmac-key-state', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lookup-hmac-key-state')>()),
  LookupHmacKeyStateService: class {
    initialize = mocks.initialize;
    activate = mocks.activate;
    beginVerification = mocks.beginVerification;
    claimNext = mocks.claimNext;
    checkpoint = mocks.checkpoint;
    completeGrace = mocks.completeGrace;
    getRotation = mocks.getRotation;
  },
}));
vi.mock('../lookup-hmac-key-state-publisher', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lookup-hmac-key-state-publisher')>()),
  LookupHmacKeyStatePublisher: class {
    publishEnvironment = mocks.publish;
  },
}));

import ControlWorker from '../index';

const MUTATION = { operationId: 'rotation-a', ownerId: 'owner-a', fencingToken: 7 };

function worker(props: Partial<ControlRpcProps> = {}) {
  const env = {
    AUTHRIM_ENVIRONMENT_NAME: 'test',
    CONTROL_DB: {} as D1Database,
  } as ControlEnv;
  const control = new ControlWorker(
    {
      props: {
        caller: 'ar-management',
        audience: 'authrim-control-v1',
        environmentId: 'test',
        ...props,
      },
      waitUntil: vi.fn(),
    } as unknown as ConstructorParameters<typeof ControlWorker>[0],
    env
  );
  return { control, env };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe('Control Lookup HMAC RPC boundaries', () => {
  it('rejects a non-Management caller before activating a key', async () => {
    await expect(
      worker({ caller: 'ar-lib-core' }).control.activateLookupHmacRotation(MUTATION)
    ).rejects.toThrow('control_rpc_caller_unauthorized');
    expect(mocks.activate).not.toHaveBeenCalled();
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it('rejects extra mutation fields before changing or publishing key state', async () => {
    await expect(
      worker().control.activateLookupHmacRotation({ ...MUTATION, tenantId: 'other' })
    ).rejects.toThrow('invalid_lookup_hmac_rotation_mutation');
    expect(mocks.activate).not.toHaveBeenCalled();
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it('activates a key before publishing the new environment state', async () => {
    const result = { operationId: 'rotation-a', state: 'active' };
    mocks.activate.mockResolvedValue(result);
    mocks.publish.mockResolvedValue({ generation: 9 });

    await expect(worker().control.activateLookupHmacRotation(MUTATION)).resolves.toEqual(result);

    expect(mocks.activate).toHaveBeenCalledExactlyOnceWith('test', MUTATION);
    expect(mocks.publish).toHaveBeenCalledExactlyOnceWith('test');
    expect(mocks.activate.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.publish.mock.invocationCallOrder[0]
    );
  });

  it('does not publish when activation fails, and masks the backend error', async () => {
    mocks.activate.mockRejectedValue(new Error('private key-store conflict'));

    await expect(worker().control.activateLookupHmacRotation(MUTATION)).rejects.toThrow(
      'control_internal_error'
    );
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it('does not report activation as successful when publication fails', async () => {
    mocks.activate.mockResolvedValue({ operationId: 'rotation-a', state: 'active' });
    mocks.publish.mockRejectedValue(new Error('private R2 response'));

    await expect(worker().control.activateLookupHmacRotation(MUTATION)).rejects.toThrow(
      'control_internal_error'
    );
    expect(mocks.activate).toHaveBeenCalledOnce();
    expect(mocks.publish).toHaveBeenCalledOnce();
  });

  it('returns no claim and skips publication when there is no pending rotation', async () => {
    mocks.claimNext.mockResolvedValue(null);

    await expect(
      worker().control.claimNextLookupHmacRotation({ ownerId: 'owner-a' })
    ).resolves.toBeNull();

    expect(mocks.claimNext).toHaveBeenCalledExactlyOnceWith('test', 'owner-a');
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it('publishes an acquired rotation claim before returning it', async () => {
    const claim = { operationId: 'rotation-a', ownerId: 'owner-a' };
    mocks.claimNext.mockResolvedValue(claim);
    mocks.publish.mockResolvedValue({ generation: 10 });

    await expect(
      worker().control.claimNextLookupHmacRotation({ ownerId: 'owner-a' })
    ).resolves.toEqual(claim);

    expect(mocks.claimNext).toHaveBeenCalledExactlyOnceWith('test', 'owner-a');
    expect(mocks.publish).toHaveBeenCalledExactlyOnceWith('test');
    expect(mocks.claimNext.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.publish.mock.invocationCallOrder[0]
    );
  });

  it('rejects a forged owner field before claiming a rotation', async () => {
    await expect(
      worker().control.claimNextLookupHmacRotation({ ownerId: 'owner-a', environmentId: 'other' })
    ).rejects.toThrow('invalid_lookup_hmac_rotation_claim');
    expect(mocks.claimNext).not.toHaveBeenCalled();
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it('rejects malformed initialization metadata before service and publication', async () => {
    await expect(worker().control.initializeLookupHmacKeyState({ current: {} })).rejects.toThrow(
      'invalid_lookup_hmac_key_metadata'
    );
    expect(mocks.initialize).not.toHaveBeenCalled();
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it('begins verification before publishing and stops if the transition fails', async () => {
    const result = { operationId: 'rotation-a', state: 'verifying' };
    mocks.beginVerification.mockResolvedValue(result);
    mocks.publish.mockResolvedValue({ generation: 11 });

    await expect(worker().control.beginLookupHmacRotationVerification(MUTATION)).resolves.toEqual(
      result
    );
    expect(mocks.beginVerification).toHaveBeenCalledExactlyOnceWith('test', MUTATION);
    expect(mocks.publish).toHaveBeenCalledExactlyOnceWith('test');
    expect(mocks.beginVerification.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.publish.mock.invocationCallOrder[0]
    );

    vi.clearAllMocks();
    mocks.beginVerification.mockRejectedValue(new Error('private verification failure'));
    await expect(worker().control.beginLookupHmacRotationVerification(MUTATION)).rejects.toThrow(
      'control_internal_error'
    );
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it('requires an exact checkpoint request before writing it', async () => {
    await expect(
      worker().control.checkpointLookupHmacRotation({ ...MUTATION, checkpoint: {} })
    ).rejects.toThrow('invalid_lookup_hmac_rotation_checkpoint');
    expect(mocks.checkpoint).not.toHaveBeenCalled();
  });

  it('completes grace before publishing and returns the committed result', async () => {
    const result = { operationId: 'rotation-a', state: 'completed' };
    mocks.completeGrace.mockResolvedValue(result);
    mocks.publish.mockResolvedValue({ generation: 12 });

    await expect(worker().control.completeLookupHmacRotationGrace(MUTATION)).resolves.toEqual(
      result
    );
    expect(mocks.completeGrace).toHaveBeenCalledExactlyOnceWith('test', MUTATION);
    expect(mocks.publish).toHaveBeenCalledExactlyOnceWith('test');
    expect(mocks.completeGrace.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.publish.mock.invocationCallOrder[0]
    );
  });

  it('does not expose a secret-bearing rotation view', async () => {
    mocks.getRotation.mockResolvedValue({ operationId: 'rotation-a', secretValue: 'private-key' });

    await expect(
      worker().control.getLookupHmacRotation({ operationId: 'rotation-a' })
    ).rejects.toThrow('control_internal_error');
    expect(mocks.getRotation).toHaveBeenCalledExactlyOnceWith('test', 'rotation-a');
  });
});
