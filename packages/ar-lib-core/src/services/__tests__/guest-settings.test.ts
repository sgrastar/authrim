import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../../types/env';
import { resolveGuestSettings } from '../guest-settings';
import { createSettingsManager } from '../../utils/settings-manager';
import { ACCOUNT_LIFECYCLE_CATEGORY_META } from '../../types/settings/account-lifecycle';

function settingsEnv(values: Map<string, string>): Pick<Env, 'SETTINGS'> {
  return {
    SETTINGS: {
      get: vi.fn(async (key: string) => values.get(key) ?? null),
    } as unknown as Env['SETTINGS'],
  };
}

describe('guest settings', () => {
  it('defaults to login disabled, upgrade enabled and no automatic deletion', async () => {
    expect(await resolveGuestSettings({}, 'tenant-1')).toMatchObject({
      loginEnabled: false,
      policy: { deletionAfterDays: null, upgradeEnabled: true, upgradeHoldMinutes: 10 },
      upgradeMethods: ['email', 'passkey'],
    });
  });

  it('keeps login and upgrade uses independent, rereads stops and isolates tenants', async () => {
    const values = new Map<string, string>();
    const env = settingsEnv(values);
    values.set(
      'settings:tenant:tenant-1:authentication-methods',
      JSON.stringify({
        'authentication-methods.guest.login_enabled': true,
        'authentication-methods.passkey.guest_upgrade_enabled': false,
        'authentication-methods.email_otp.login_enabled': false,
      })
    );
    values.set(
      'settings:tenant:tenant-1:account-lifecycle',
      JSON.stringify({
        'account-lifecycle.guest.deletion_enabled': true,
        'account-lifecycle.guest.deletion_after_days': 7,
      })
    );
    expect(await resolveGuestSettings(env, 'tenant-1')).toMatchObject({
      loginEnabled: true,
      upgradeMethods: ['email'],
      policy: { deletionAfterDays: 7 },
    });
    values.set(
      'settings:tenant:tenant-1:account-lifecycle',
      JSON.stringify({ 'account-lifecycle.guest.upgrade_enabled': false })
    );
    expect((await resolveGuestSettings(env, 'tenant-1')).policy.upgradeEnabled).toBe(false);
    expect(await resolveGuestSettings(env, 'tenant-2')).toMatchObject({
      loginEnabled: false,
      policy: { deletionAfterDays: null, upgradeEnabled: true },
    });
  });

  it.each(['[]', 'null', '{bad'])('fails closed for malformed settings %s', async (value) => {
    const env = settingsEnv(new Map([['settings:tenant:t1:account-lifecycle', value]]));
    await expect(resolveGuestSettings(env, 't1')).rejects.toThrow('settings_read_failed');
  });

  it('does not enable upgrades on a KV outage', async () => {
    const env = settingsEnv(new Map());
    vi.mocked(env.SETTINGS!.get).mockRejectedValue(new Error('unavailable'));
    await expect(resolveGuestSettings(env, 't1')).rejects.toThrow('settings_read_failed');
  });

  it.each([0, -1, 0.5, 3651, NaN, Infinity])(
    'rejects invalid retention at the settings boundary: %s',
    (days) => {
      const manager = createSettingsManager({ env: {} });
      manager.registerCategory(ACCOUNT_LIFECYCLE_CATEGORY_META);
      expect(
        manager.validate('account-lifecycle', {
          'account-lifecycle.guest.deletion_after_days': days,
        }).valid
      ).toBe(false);
    }
  );

  it.each([0, 1.5, 61])('rejects invalid hold minutes at the settings boundary: %s', (minutes) => {
    const manager = createSettingsManager({ env: {} });
    manager.registerCategory(ACCOUNT_LIFECYCLE_CATEGORY_META);
    expect(
      manager.validate('account-lifecycle', {
        'account-lifecycle.guest.upgrade_hold_minutes': minutes,
      }).valid
    ).toBe(false);
  });
});
