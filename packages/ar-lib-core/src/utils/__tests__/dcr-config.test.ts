import { afterEach, describe, expect, it } from 'vitest';
import { clearDCRSettingsCache, getAllDCRSettings, getDCRSetting } from '../dcr-config';

function createKv(value: string | null) {
  return {
    get: async () => value,
  };
}

describe('dcr-config', () => {
  afterEach(() => {
    clearDCRSettingsCache();
  });

  it('prefers SETTINGS over legacy AUTHRIM_CONFIG', async () => {
    const env = {
      SETTINGS: createKv(
        JSON.stringify({
          'dcr.enabled': true,
          'dcr.require_initial_access_token': true,
        })
      ),
      AUTHRIM_CONFIG: createKv(
        JSON.stringify({
          'dcr.enabled': false,
          'dcr.require_initial_access_token': false,
        })
      ),
    } as any;

    await expect(getDCRSetting('dcr.enabled', env, 'default')).resolves.toBe(true);
    await expect(getDCRSetting('dcr.require_initial_access_token', env, 'default')).resolves.toBe(
      true
    );
  });

  it('falls back to AUTHRIM_CONFIG when SETTINGS has no entry', async () => {
    const env = {
      SETTINGS: createKv(null),
      AUTHRIM_CONFIG: createKv(
        JSON.stringify({
          'dcr.enabled': true,
          'dcr.scope_restriction_enabled': true,
        })
      ),
    } as any;

    await expect(getDCRSetting('dcr.enabled', env, 'default')).resolves.toBe(true);
    await expect(getDCRSetting('dcr.scope_restriction_enabled', env, 'default')).resolves.toBe(
      true
    );
  });

  it('falls back to env/default values when KV has no override', async () => {
    const env = {
      SETTINGS: createKv(null),
      AUTHRIM_CONFIG: createKv(null),
      DCR_ENABLED: 'true',
    } as any;

    await expect(getDCRSetting('dcr.enabled', env, 'default')).resolves.toBe(true);
    await expect(getAllDCRSettings(env, 'default')).resolves.toEqual({
      'dcr.enabled': true,
      'dcr.require_initial_access_token': true,
      'dcr.scope_restriction_enabled': false,
      'dcr.allow_duplicate_software_id': false,
    });
  });
});
