import { describe, expect, it, vi } from 'vitest';
import { KeyManagerPublicEntrypoint } from '../KeyManagerPublicEntrypoint';
import type { Env } from '../../types/env';

function createEntrypoint() {
  const getAllOIDCPublicKeysRpc = vi.fn(async () => [{ kty: 'RSA', kid: 'public-key' }]);
  const getByName = vi.fn(() => ({ getAllOIDCPublicKeysRpc }));
  const env = {
    KEY_MANAGER: { getByName },
  } as unknown as Env;
  const entrypoint = new KeyManagerPublicEntrypoint({} as ExecutionContext, env);

  return { entrypoint, getByName, getAllOIDCPublicKeysRpc };
}

describe('KeyManagerPublicEntrypoint', () => {
  it('returns only public keys from the tenant KeyManager instance', async () => {
    const { entrypoint, getByName, getAllOIDCPublicKeysRpc } = createEntrypoint();

    await expect(entrypoint.getAllPublicKeys('tenant-a')).resolves.toEqual([
      { kty: 'RSA', kid: 'public-key' },
    ]);
    expect(getByName).toHaveBeenCalledWith('tenant-a-v3');
    expect(getAllOIDCPublicKeysRpc).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed tenant identifiers before touching KeyManager', async () => {
    const { entrypoint, getByName } = createEntrypoint();

    await expect(entrypoint.getAllPublicKeys('../tenant-a')).rejects.toThrow('invalid_tenant_id');
    expect(getByName).not.toHaveBeenCalled();
  });

  it('does not expose private-key or key-mutation methods', () => {
    const { entrypoint } = createEntrypoint();
    const exposed = entrypoint as unknown as Record<string, unknown>;

    expect(exposed.getActiveKeyWithPrivateRpc).toBeUndefined();
    expect(exposed.rotateKeysRpc).toBeUndefined();
    expect(exposed.importKey).toBeUndefined();
  });
});
