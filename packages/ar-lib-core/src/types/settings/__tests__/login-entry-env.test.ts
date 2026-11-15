import { describe, expect, it } from 'vitest';
import { readSettingEnvValue } from '../../../utils/settings-manager';
import { LOGIN_ENTRY_SETTINGS_META } from '../login-entry';

describe('login-entry environment fallbacks', () => {
  const key = 'login-entry.require_common_discovery_before_login' as const;
  const read = (value: string) =>
    readSettingEnvValue(
      { LOGIN_ENTRY_REQUIRE_COMMON_DISCOVERY_BEFORE_LOGIN: value },
      LOGIN_ENTRY_SETTINGS_META[key]
    );

  it('reads booleans strictly, so a typo falls back to the default (also what the console shows)', () => {
    expect(read('true')).toBe(true);
    expect(read(' 1 ')).toBe(true);
    expect(read('FALSE')).toBe(false);
    expect(read(' 0 ')).toBe(false);
    for (const bad of ['treu', 'yes', '', 'no']) expect(read(bad)).toBeUndefined();
  });

  it('refuses an invalid mode', () => {
    const meta = LOGIN_ENTRY_SETTINGS_META['login-entry.mode'];
    expect(readSettingEnvValue({ LOGIN_ENTRY_MODE: 'tenant_only' }, meta)).toBe('tenant_only');
    expect(readSettingEnvValue({ LOGIN_ENTRY_MODE: 'everything' }, meta)).toBeUndefined();
  });
});
