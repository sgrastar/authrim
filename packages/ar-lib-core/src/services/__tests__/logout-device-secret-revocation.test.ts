import { describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '../../db/adapter';
import {
  normalizeDeviceSecretLogoutScope,
  revokeDeviceSecretsForLogoutScope,
} from '../logout-device-secret-revocation';

function createAdapter(overrides: Partial<DatabaseAdapter> = {}): DatabaseAdapter {
  return {
    query: vi.fn().mockResolvedValue([]),
    queryOne: vi.fn().mockResolvedValue(null),
    execute: vi.fn().mockResolvedValue({ success: true, rowsAffected: 0 }),
    transaction: vi.fn(),
    batch: vi.fn().mockResolvedValue([]),
    isHealthy: vi.fn().mockResolvedValue({ healthy: true, latencyMs: 1, type: 'mock' }),
    getType: vi.fn().mockReturnValue('mock'),
    close: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as DatabaseAdapter;
}

describe('logout device_secret revocation scope', () => {
  it('defaults unknown scope values to group', () => {
    expect(normalizeDeviceSecretLogoutScope(undefined)).toBe('group');
    expect(normalizeDeviceSecretLogoutScope('tenant')).toBe('group');
    expect(normalizeDeviceSecretLogoutScope('local')).toBe('local');
  });

  it('local scope revokes the current same-client installation only', async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ success: true, rowsAffected: 1 })
      .mockResolvedValueOnce({ success: true, rowsAffected: 1 })
      .mockResolvedValueOnce({ success: true, rowsAffected: 0 });
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('FROM device_installations')) {
        return [
          {
            id: 'inst-current',
            user_id: 'user-1',
            client_id: 'client-a',
            trust_group_id: 'tg-a',
            linked_device_secret_id: 'ds-current',
            session_id: 'sid-1',
          },
        ];
      }
      if (sql.includes('FROM device_secrets')) {
        return [
          {
            id: 'ds-current',
            user_id: 'user-1',
            client_id: 'client-a',
            trust_group_id: 'tg-a',
            installation_id: 'inst-current',
            session_id: 'sid-1',
          },
        ];
      }
      return [];
    });
    const adapter = createAdapter({ query, execute });

    const result = await revokeDeviceSecretsForLogoutScope({
      adapter,
      tenantId: 'default',
      sessionIds: ['sid-1'],
      clientId: 'client-a',
      scope: 'local',
      reason: 'logout',
      callerAuthMode: 'session',
    });

    expect(result).toMatchObject({
      scope: 'local',
      clientId: 'client-a',
      trustGroupId: 'tg-a',
      revokedDeviceSecrets: 1,
      revokedInstallations: 1,
      matchedInstallations: 1,
      callerAuthMode: 'session',
    });
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE device_installations'),
      expect.arrayContaining(['logout', 'default', 'sid-1', 'client-a'])
    );
  });

  it('group scope revokes installations in the resolved trust group', async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ success: true, rowsAffected: 2 })
      .mockResolvedValueOnce({ success: true, rowsAffected: 2 })
      .mockResolvedValueOnce({ success: true, rowsAffected: 0 });
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('FROM device_installations') && sql.includes('session_id IN')) {
        return [
          {
            id: 'inst-current',
            user_id: 'user-1',
            client_id: 'client-a',
            trust_group_id: 'tg-a',
            linked_device_secret_id: 'ds-current',
            session_id: 'sid-1',
          },
        ];
      }
      if (sql.includes('FROM device_installations') && sql.includes('trust_group_id = ?')) {
        return [
          {
            id: 'inst-current',
            user_id: 'user-1',
            client_id: 'client-a',
            trust_group_id: 'tg-a',
            linked_device_secret_id: 'ds-current',
            session_id: 'sid-1',
          },
          {
            id: 'inst-sibling',
            user_id: 'user-1',
            client_id: 'client-b',
            trust_group_id: 'tg-a',
            linked_device_secret_id: 'ds-sibling',
            session_id: 'sid-2',
          },
        ];
      }
      if (sql.includes('FROM device_secrets')) {
        return [];
      }
      return [];
    });
    const adapter = createAdapter({ query, execute });

    const result = await revokeDeviceSecretsForLogoutScope({
      adapter,
      tenantId: 'default',
      sessionIds: ['sid-1'],
      clientId: 'client-a',
      scope: 'group',
      reason: 'logout',
    });

    expect(result).toMatchObject({
      scope: 'group',
      userId: 'user-1',
      clientId: 'client-a',
      trustGroupId: 'tg-a',
      revokedDeviceSecrets: 2,
      revokedInstallations: 2,
      matchedInstallations: 2,
    });
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE device_secrets'),
      expect.arrayContaining(['logout', 'ds-current', 'ds-sibling'])
    );
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining('trust_group_id = ?'),
      expect.arrayContaining(['default', 'user-1', 'tg-a'])
    );
  });

  it('global scope revokes all active user installations in the tenant', async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ success: true, rowsAffected: 3 })
      .mockResolvedValueOnce({ success: true, rowsAffected: 3 })
      .mockResolvedValueOnce({ success: true, rowsAffected: 0 });
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('FROM device_installations') && sql.includes('session_id IN')) {
        return [
          {
            id: 'inst-current',
            user_id: 'user-1',
            client_id: 'client-a',
            trust_group_id: 'tg-a',
            linked_device_secret_id: 'ds-current',
            session_id: 'sid-1',
          },
        ];
      }
      if (sql.includes('FROM device_installations') && sql.includes('user_id = ?')) {
        return [
          { id: 'inst-current', user_id: 'user-1', linked_device_secret_id: 'ds-current' },
          { id: 'inst-sibling', user_id: 'user-1', linked_device_secret_id: 'ds-sibling' },
          { id: 'inst-other', user_id: 'user-1', linked_device_secret_id: 'ds-other' },
        ];
      }
      return [];
    });
    const adapter = createAdapter({ query, execute });

    const result = await revokeDeviceSecretsForLogoutScope({
      adapter,
      tenantId: 'default',
      sessionIds: ['sid-1'],
      clientId: 'client-a',
      scope: 'global',
      reason: 'logout',
    });

    expect(result).toMatchObject({
      scope: 'global',
      userId: 'user-1',
      revokedDeviceSecrets: 3,
      revokedInstallations: 3,
      matchedInstallations: 3,
    });
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE device_installations'),
      expect.arrayContaining(['default', 'user-1'])
    );
  });

  it('falls back to legacy device_secret session revocation when installation table is absent', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('FROM device_installations')) {
        throw new Error('no such table: device_installations');
      }
      return [
        {
          id: 'ds-legacy',
          user_id: 'user-1',
          session_id: 'sid-1',
        },
      ];
    });
    const execute = vi.fn(async (sql: string) => {
      if (sql.includes('UPDATE device_installations')) {
        throw new Error('no such table: device_installations');
      }
      return { success: true, rowsAffected: 1 };
    });
    const adapter = createAdapter({ query, execute });

    const result = await revokeDeviceSecretsForLogoutScope({
      adapter,
      tenantId: 'default',
      sessionIds: ['sid-1'],
      scope: 'local',
      reason: 'logout',
    });

    expect(result).toMatchObject({
      scope: 'local',
      revokedDeviceSecrets: 1,
      revokedInstallations: 0,
      matchedInstallations: 0,
    });
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE device_secrets'),
      expect.arrayContaining(['logout', 'default', 'sid-1'])
    );
  });
});
