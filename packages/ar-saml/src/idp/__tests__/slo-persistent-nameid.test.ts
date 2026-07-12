import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env, SAMLSPConfig } from '@authrim/ar-lib-core';
import { NAMEID_FORMATS } from '../../common/constants';

const mockGetSamlUserInfoById = vi.hoisted(() => vi.fn());

vi.mock('../../common/user-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../common/user-store')>()),
  getSamlUserInfoById: mockGetSamlUserInfoById,
}));

import { resolveIdPLogoutNameID } from '../slo';

describe('resolveIdPLogoutNameID', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSamlUserInfoById.mockResolvedValue({ id: 'user-without-email' });
  });

  it('reuses an existing persistent NameID for a user without email', async () => {
    const registry = persistentRegistry(
      JSON.stringify({ version: 1, nameId: 'existing-persistent-nameid' })
    );

    await expect(
      resolveIdPLogoutNameID(
        {
          PAIRWISE_SALT: 'test-pairwise-salt',
          KV: registry,
        } as unknown as Env,
        'tenant-a',
        'user-without-email',
        spConfig()
      )
    ).resolves.toBe('existing-persistent-nameid');
    expect(registry.put).not.toHaveBeenCalled();
  });

  it('does not mint a new persistent NameID during logout', async () => {
    const registry = persistentRegistry(null);

    await expect(
      resolveIdPLogoutNameID(
        {
          PAIRWISE_SALT: 'test-pairwise-salt',
          KV: registry,
        } as unknown as Env,
        'tenant-a',
        'user-without-email',
        spConfig()
      )
    ).rejects.toThrow('AllowCreate=false');
    expect(registry.put).not.toHaveBeenCalled();
  });
});

function persistentRegistry(existing: string | null) {
  return {
    get: vi.fn().mockResolvedValue(existing),
    put: vi.fn().mockResolvedValue(undefined),
  };
}

function spConfig(): Pick<SAMLSPConfig, 'entityId' | 'nameIdFormat'> {
  return {
    entityId: 'https://sp.example.com/saml',
    nameIdFormat: NAMEID_FORMATS.PERSISTENT,
  };
}
