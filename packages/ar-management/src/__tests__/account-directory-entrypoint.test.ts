import { describe, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';
import { AccountDirectoryEntrypoint } from '../account-directory-entrypoint';

function worker(
  props: Record<string, unknown>,
  env: Partial<Env> = {}
): AccountDirectoryEntrypoint {
  return new AccountDirectoryEntrypoint(
    { props } as ConstructorParameters<typeof AccountDirectoryEntrypoint>[0],
    {
      AUTHRIM_ENVIRONMENT_NAME: 'test',
      ...env,
    } as Env
  );
}

describe('AccountDirectoryEntrypoint', () => {
  it('rejects unauthorized or cross-environment caller props before storage access', async () => {
    const get = vi.fn(async () => null);
    await expect(
      worker(
        {
          caller: 'ar-auth',
          environmentId: 'test',
          audience: 'authrim-account-directory-v1',
        },
        { TENANT_RUNTIME_REGISTRY: { get } as unknown as KVNamespace }
      ).publishAccountDirectory({})
    ).rejects.toThrow('account_directory_rpc_caller_unauthorized');
    await expect(
      worker({
        caller: 'ar-management',
        environmentId: 'other',
        audience: 'authrim-account-directory-v1',
      }).publishAccountDirectory({})
    ).rejects.toThrow('account_directory_rpc_caller_unauthorized');
    expect(get).not.toHaveBeenCalled();
  });

  it('exposes only stable validation codes and redacts unexpected details', async () => {
    const authorized = {
      caller: 'ar-management',
      environmentId: 'test',
      audience: 'authrim-account-directory-v1',
    };
    await expect(worker(authorized).publishAccountDirectory({})).rejects.toThrow(
      'invalid_directory_publication_shape'
    );

    const throwingInput = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('provider secret detail');
        },
      }
    );
    await expect(worker(authorized).publishAccountDirectory(throwingInput)).rejects.toThrow(
      'account_directory_internal_error'
    );
  });
});
