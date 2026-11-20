import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  routed: vi.fn(),
  query: vi.fn(),
  resolveAccount: vi.fn(),
  revoke: vi.fn(),
}));

vi.mock('../account-provisioning', () => ({ usesRoutedAccountStorage: m.routed }));
vi.mock('@authrim/ar-lib-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@authrim/ar-lib-core')>()),
  createAuthContextFromHono: () => ({ coreAdapter: { query: m.query } }),
  resolveAccountCoreDataContext: m.resolveAccount,
  ensureDatabaseAdapter: () => ({ query: m.query }),
  revokeDeviceSecretsForLogoutScope: m.revoke,
}));

import { revokeSessionDeviceSecrets } from '../logout-device-secrets';

const input = {
  tenantId: 't1',
  issuer: 'https://op.example.com',
  sessionId: '0_session_1',
  userId: 'user-1',
  scope: 'local',
  reason: 'logout',
  callerAuthMode: 'session',
} as never;

const c = { env: {} } as never;

function result(extra: Record<string, unknown> = {}) {
  return {
    scope: 'local',
    tenantId: 't1',
    sessionIds: [],
    revokedDeviceSecrets: 1,
    revokedInstallations: 0,
    matchedInstallations: 0,
    ...extra,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.routed.mockReturnValue(false);
  m.revoke.mockResolvedValue(result());
  m.query.mockImplementation(async (sql: string) =>
    sql.includes('FROM device_secrets')
      ? [{ session_id: '0_session_1', client_id: 'app', trust_group_id: null }]
      : []
  );
});

describe('revokeSessionDeviceSecrets', () => {
  it.each(['no such table: device_installations', 'D1_ERROR: device_installations missing'])(
    'treats a missing installations table (%s) as having none',
    async (message) => {
      m.query.mockImplementation(async (sql: string) => {
        if (sql.includes('device_installations')) throw new Error(message);
        return [{ session_id: '0_session_1', client_id: 'app', trust_group_id: null }];
      });
      const revoked = await revokeSessionDeviceSecrets(c, input);
      expect(revoked.revokedDeviceSecrets).toBe(1);
      expect(m.revoke).toHaveBeenCalledWith(
        expect.objectContaining({ scope: 'local', clientId: 'app', sessionIds: ['0_session_1'] })
      );
    }
  );

  it('fails on any other installations read error', async () => {
    m.query.mockImplementation(async (sql: string) => {
      if (sql.includes('device_installations')) throw new Error('D1_ERROR: timeout');
      return [];
    });
    await expect(revokeSessionDeviceSecrets(c, input)).rejects.toThrow('D1_ERROR: timeout');
    expect(m.revoke).not.toHaveBeenCalled();
  });

  it('reads a non-Error installations failure by its text', async () => {
    m.query
      .mockResolvedValueOnce([
        { session_id: '0_session_1', client_id: 'app', trust_group_id: null },
      ])
      .mockRejectedValueOnce('no such table');
    expect((await revokeSessionDeviceSecrets(c, input)).revokedDeviceSecrets).toBe(1);
  });

  describe('with routed account storage', () => {
    beforeEach(() => m.routed.mockReturnValue(true));

    it('revokes nothing for a session without a user', async () => {
      const revoked = await revokeSessionDeviceSecrets(c, {
        ...(input as object),
        userId: undefined,
      } as never);
      expect(revoked).toMatchObject({
        revokedDeviceSecrets: 0,
        sessionIds: ['0_session_1'],
        scope: 'local',
      });
      expect(m.resolveAccount).not.toHaveBeenCalled();
    });

    it('revokes nothing for a user without an account route', async () => {
      m.resolveAccount.mockRejectedValueOnce(new Error('account_data_route_not_found'));
      const revoked = await revokeSessionDeviceSecrets(c, input);
      expect(revoked).toEqual({
        scope: 'local',
        tenantId: 't1',
        userId: 'user-1',
        clientId: undefined,
        trustGroupId: undefined,
        sessionIds: ['0_session_1'],
        revokedDeviceSecrets: 0,
        revokedInstallations: 0,
        matchedInstallations: 0,
        callerAuthMode: 'session',
      });
      expect(m.resolveAccount).toHaveBeenCalledWith({}, { tenantId: 't1', accountId: 'user-1' });
      expect(m.revoke).not.toHaveBeenCalled();
    });

    it('fails when the account route cannot be read', async () => {
      m.resolveAccount.mockRejectedValueOnce(new Error('kv down'));
      await expect(revokeSessionDeviceSecrets(c, input)).rejects.toThrow('kv down');
    });

    it('refuses an account route of another user', async () => {
      m.resolveAccount.mockResolvedValueOnce({ legacyUserId: 'user-2', coreDb: {} });
      await expect(revokeSessionDeviceSecrets(c, input)).rejects.toThrow(
        'logout_device_secret_owner_mismatch'
      );
    });

    it("revokes in the account's database", async () => {
      m.resolveAccount.mockResolvedValueOnce({ legacyUserId: 'user-1', coreDb: {} });
      expect((await revokeSessionDeviceSecrets(c, input)).revokedDeviceSecrets).toBe(1);
    });
  });
});
