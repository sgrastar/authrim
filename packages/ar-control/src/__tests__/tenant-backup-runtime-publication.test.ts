import { beforeEach, expect, it, vi } from 'vitest';
import type { ControlEnv, ControlRpcProps } from '../types';

const mocks = vi.hoisted(() => ({
  lookup: vi.fn(),
  hmac: vi.fn(),
  plugin: vi.fn(),
}));

vi.mock('../lookup-registry-publisher', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lookup-registry-publisher')>()),
  LookupRegistryPublisher: class {
    publishEnvironment = mocks.lookup;
  },
}));
vi.mock('../lookup-hmac-key-state-publisher', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lookup-hmac-key-state-publisher')>()),
  LookupHmacKeyStatePublisher: class {
    publishEnvironment = mocks.hmac;
  },
}));
vi.mock('../plugin-runner-registry-publisher', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../plugin-runner-registry-publisher')>()),
  PluginRunnerRegistryPublisher: class {
    publishEnvironment = mocks.plugin;
  },
}));

import ControlWorker from '../index';

function worker(props: Partial<ControlRpcProps> = {}) {
  return new ControlWorker(
    {
      props: {
        caller: 'ar-management',
        environmentId: 'test-restore',
        audience: 'authrim-control-v1',
        ...props,
      },
    } as ConstructorParameters<typeof ControlWorker>[0],
    { CONTROL_DB: {} as D1Database } as ControlEnv
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.lookup.mockResolvedValue({
    environmentId: 'test-restore',
    generation: 2,
    status: 'published',
  });
  mocks.hmac.mockResolvedValue({
    environmentId: 'test-restore',
    generation: 3,
    stateRevision: 1,
    status: 'resumed',
  });
  mocks.plugin.mockResolvedValue({
    environmentId: 'test-restore',
    generation: 4,
    status: 'unchanged',
  });
});

it('publishes every runtime snapshot before backup restore activation', async () => {
  await expect(worker().publishTenantBackupRuntimeState()).resolves.toEqual({
    lookupRegistry: { environmentId: 'test-restore', generation: 2, status: 'published' },
    lookupHmacKeyState: {
      environmentId: 'test-restore',
      generation: 3,
      stateRevision: 1,
      status: 'resumed',
    },
    pluginRunnerRegistry: {
      environmentId: 'test-restore',
      generation: 4,
      status: 'unchanged',
    },
  });
  expect(mocks.lookup).toHaveBeenCalledWith('test-restore');
  expect(mocks.hmac).toHaveBeenCalledWith('test-restore');
  expect(mocks.plugin).toHaveBeenCalledWith('test-restore');
});

it('rejects publication without an authorized service-binding caller', async () => {
  await expect(
    worker({
      caller: undefined,
      environmentId: undefined,
      audience: undefined,
    }).publishTenantBackupRuntimeState()
  ).rejects.toThrow('control_rpc_caller_unauthorized');
  expect(mocks.lookup).not.toHaveBeenCalled();
});
