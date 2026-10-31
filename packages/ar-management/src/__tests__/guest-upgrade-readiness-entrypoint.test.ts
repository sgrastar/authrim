import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';
const delivery = vi.hoisted(() => vi.fn());
vi.mock('@authrim/ar-lib-core', () => ({ isNotificationDeliveryAvailable: delivery }));
import { GuestUpgradeReadinessEntrypoint } from '../guest-upgrade-readiness-entrypoint';
function worker(
  props = {
    caller: 'ar-userinfo',
    environmentId: 'test',
    audience: 'authrim-guest-upgrade-readiness-v1',
  },
  secret = 's'.repeat(32)
) {
  return new GuestUpgradeReadinessEntrypoint(
    { props } as unknown as ConstructorParameters<typeof GuestUpgradeReadinessEntrypoint>[0],
    { AUTHRIM_ENVIRONMENT_NAME: 'test', OTP_HMAC_SECRET: secret } as Env
  );
}
describe('read-only upgrade delivery readiness', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delivery.mockResolvedValue(true);
  });
  it('reports only tenant and readiness without secret material', async () => {
    expect(await worker().read('tenant-a')).toEqual({ tenantId: 'tenant-a', email: true });
    expect(delivery).toHaveBeenCalledWith(expect.anything(), {
      owner: 'tenant',
      tenantId: 'tenant-a',
    });
  });
  it.each([undefined, null, 123, {}, [], '', 'tenant/other', 'a'.repeat(257)])(
    'rejects malformed tenant identifiers (%j) before delivery access',
    async (tenantId) => {
      await expect(worker().read(tenantId as string)).rejects.toThrow(
        'guest_upgrade_readiness_unauthorized'
      );
      expect(delivery).not.toHaveBeenCalled();
    }
  );
  it('requires both the OTP secret and an available delivery provider', async () => {
    expect((await worker(undefined, 'short').read('tenant-a')).email).toBe(false);
    expect(delivery).not.toHaveBeenCalled();
    delivery.mockResolvedValue(false);
    expect((await worker().read('tenant-a')).email).toBe(false);
  });
  it.each([
    { caller: 'ar-auth', environmentId: 'test', audience: 'authrim-guest-upgrade-readiness-v1' },
    {
      caller: 'ar-userinfo',
      environmentId: 'other',
      audience: 'authrim-guest-upgrade-readiness-v1',
    },
  ])('rejects unbound callers %j', async (props) => {
    await expect(worker(props).read('tenant-a')).rejects.toThrow(
      'guest_upgrade_readiness_unauthorized'
    );
    expect(delivery).not.toHaveBeenCalled();
  });
});
