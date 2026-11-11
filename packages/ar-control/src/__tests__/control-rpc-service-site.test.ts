import { describe, expect, it } from 'vitest';
import ControlWorker from '../index';
import type { ControlEnv, ControlRpcProps } from '../types';

function worker(props: Partial<ControlRpcProps> = {}, overrides: Partial<ControlEnv> = {}) {
  const env = {
    AUTHRIM_ENVIRONMENT_NAME: 'test',
    CONTROL_DB: {} as D1Database,
    ...overrides,
  } as ControlEnv;
  return new ControlWorker(
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
}

const REQUEST = {
  desiredState: 'attached',
  workerName: 'my-site',
  idempotencyKey: 'key-1',
  requestedById: 'admin-1',
};

describe('service site binding RPC boundary', () => {
  it.each([{ caller: 'ar-plugin-runner' as const }, { audience: 'other' as never }])(
    'rejects an unauthorised caller %j',
    async (props) => {
      await expect(worker(props).getServiceSiteBindingStatus()).rejects.toThrow(
        'control_rpc_caller_unauthorized'
      );
      await expect(worker(props).requestServiceSiteBinding(REQUEST)).rejects.toThrow(
        'control_rpc_caller_unauthorized'
      );
    }
  );

  it('rejects a request with unexpected or missing fields', async () => {
    const control = worker({}, { AUTHRIM_AUTOMATIC_PROVISIONING: 'true' });
    await expect(control.requestServiceSiteBinding({ ...REQUEST, extra: true })).rejects.toThrow(
      'invalid_service_site_binding_request'
    );
    await expect(
      control.requestServiceSiteBinding({ desiredState: 'detached', idempotencyKey: 'key-1' })
    ).rejects.toThrow('invalid_service_site_binding_request');
    await expect(
      control.requestServiceSiteBinding({ ...REQUEST, desiredState: 'moved' })
    ).rejects.toThrow('invalid_service_site_binding_request');
  });

  it('refuses a change that nothing could apply', async () => {
    await expect(worker().requestServiceSiteBinding(REQUEST)).rejects.toThrow(
      'service_site_provider_mutation_unavailable'
    );
    await expect(
      worker({}, { AUTHRIM_AUTOMATIC_PROVISIONING: 'true' }).requestServiceSiteBinding(REQUEST)
    ).rejects.toThrow('service_site_provider_mutation_unavailable');
  });
});
