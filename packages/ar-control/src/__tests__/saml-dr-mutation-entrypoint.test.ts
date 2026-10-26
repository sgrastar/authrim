import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SamlDrMutationEntrypoint,
  SAML_DR_MUTATION_CALLERS,
  runControlSamlDrOperation,
  type SamlDrMutationProps,
} from '../saml-dr-mutation-entrypoint';
import { samlDrWaitUntil } from '@authrim/ar-lib-core/services/tenant-portability/saml-dr-writer';
import type { ControlEnv } from '../types';

const permit = vi.hoisted(() => vi.fn());
vi.mock('../tenant-backup-mutation-permits', () => ({ controlTenantMutationPermit: permit }));
function worker(props: Partial<SamlDrMutationProps> = {}, environmentId = 'test') {
  return new SamlDrMutationEntrypoint(
    {
      props: {
        caller: 'ar-auth',
        audience: 'authrim-saml-dr-mutation-v1',
        environmentId: 'test',
        ...props,
      },
    } as ConstructorParameters<typeof SamlDrMutationEntrypoint>[0],
    { AUTHRIM_ENVIRONMENT_NAME: environmentId, CONTROL_DB: {} } as ControlEnv
  );
}
beforeEach(() => {
  permit.mockReset();
});
describe('narrow SAML DR Control admission', () => {
  it.each(SAML_DR_MUTATION_CALLERS)('admits only an environment permit for %s', async (caller) => {
    permit.mockResolvedValue({ admitted: true });
    const request = { permitId: 'test-permit' };
    await expect(
      worker({ caller }).acquireEnvironmentBackupMutationPermit(request)
    ).resolves.toEqual({ admitted: true });
    expect(permit).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: 'environment',
        caller,
        environmentId: 'test',
        request,
        action: 'acquire',
      })
    );
    await worker({ caller }).completeEnvironmentBackupMutationPermit(request);
    expect(permit).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'complete' }));
  });
  it.each([
    { caller: 'unknown-worker' },
    { audience: 'authrim-control-v1' },
    { environmentId: 'other' },
  ])('rejects mismatched service binding identity %j', async (props) => {
    await expect(
      worker(props as Partial<SamlDrMutationProps>).acquireEnvironmentBackupMutationPermit({})
    ).rejects.toThrow('control_rpc_caller_unauthorized');
    expect(permit).not.toHaveBeenCalled();
  });
  it('exposes no HTTP operation and redacts internal errors', async () => {
    expect(worker().fetch().status).toBe(404);
    permit.mockRejectedValue(new Error('private-database-value'));
    await expect(worker().acquireEnvironmentBackupMutationPermit({})).rejects.toThrow(
      'saml_dr_writer_unavailable'
    );
    expect('permit' in worker()).toBe(false);
  });
});

describe('Control local admission adapter', () => {
  const environment = () =>
    ({
      ENABLE_SAML_DR_EXPORT: 'true',
      AUTHRIM_ENVIRONMENT_NAME: 'test',
      CONTROL_DB: {},
    }) as ControlEnv;
  it('keeps default-off behavior and never calls a permit binding', async () => {
    const env = {} as ControlEnv;
    await expect(runControlSamlDrOperation(env, async (same) => same === env)).resolves.toBe(true);
    expect(permit).not.toHaveBeenCalled();
  });
  it.each([undefined, '', 'bad/environment'])(
    'rejects missing or invalid local environment identity %j before writing',
    async (id) => {
      const operation = vi.fn();
      await expect(
        runControlSamlDrOperation({ ...environment(), AUTHRIM_ENVIRONMENT_NAME: id }, operation)
      ).rejects.toThrow('saml_dr_writer_unavailable');
      expect(operation).not.toHaveBeenCalled();
      expect(permit).not.toHaveBeenCalled();
    }
  );
  it('uses local Control storage and one permit for nested operations', async () => {
    permit.mockResolvedValue({ admitted: true });
    const env = environment();
    await expect(
      runControlSamlDrOperation(env, async (covered) =>
        runControlSamlDrOperation(covered, async () => 'done')
      )
    ).resolves.toBe('done');
    expect(permit.mock.calls.map(([call]) => (call as { action: string }).action)).toEqual([
      'acquire',
      'complete',
    ]);
    expect(permit).toHaveBeenCalledWith(
      expect.objectContaining({
        database: env.CONTROL_DB,
        caller: 'ar-control',
        environmentId: 'test',
        scope: 'environment',
      })
    );
  });
  it('holds the permit through deferred work after the foreground operation fails', async () => {
    permit.mockResolvedValue({ admitted: true });
    let finish!: () => void;
    const effect = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const waitUntil = vi.fn();
    const result = runControlSamlDrOperation(environment(), async () => {
      samlDrWaitUntil({ waitUntil }, effect);
      throw new Error('foreground_failed');
    });
    const observed = expect(result).rejects.toThrow('foreground_failed');
    await vi.waitFor(() => expect(waitUntil).toHaveBeenCalledOnce());
    expect(permit.mock.calls.map(([call]) => (call as { action: string }).action)).toEqual([
      'acquire',
    ]);
    finish();
    await observed;
    expect(permit.mock.calls.map(([call]) => (call as { action: string }).action)).toEqual([
      'acquire',
      'complete',
    ]);
  });
});
