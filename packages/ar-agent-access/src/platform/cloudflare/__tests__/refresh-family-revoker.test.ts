import { describe, expect, it, vi } from 'vitest';
import { CloudflareRefreshFamilyRevoker } from '../refresh-family-revoker';

describe('CloudflareRefreshFamilyRevoker', () => {
  it('locates the DO with the captured JTI but revokes by immutable family ID', async () => {
    const revokeFamilyRpc = vi.fn().mockResolvedValue(undefined);
    const idFromName = vi.fn((name: string) => name);
    const get = vi.fn(() => ({ revokeFamilyRpc }));
    const env = {
      REFRESH_TOKEN_ROTATOR: { idFromName, get },
    } as never;
    const revoker = new CloudflareRefreshFamilyRevoker(env);

    await revoker.revoke({
      tenantId: 'tenant-1',
      clientId: 'client-1',
      familyId: 'family-immutable-1',
      familyJti: 'v1_7_rt_original-jti',
      reason: 'grant_revoked',
    });

    expect(idFromName).toHaveBeenCalledOnce();
    expect(get).toHaveBeenCalledOnce();
    expect(revokeFamilyRpc).toHaveBeenCalledWith('family-immutable-1', 'grant_revoked');
  });
});
