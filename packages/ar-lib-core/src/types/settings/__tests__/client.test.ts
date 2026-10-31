import { describe, expect, it } from 'vitest';
import { CLIENT_DEFAULTS, CLIENT_SETTINGS_META } from '../client';

describe('CLIENT_SETTINGS_META', () => {
  it('keeps only per-app settings (the registration metadata lives elsewhere)', () => {
    // The app's registration metadata (grant types, URIs, channels, token policy) lives in the
    // client registration, not in the settings catalog.
    // The app's default audience and resource are columns of the registration, not settings.
    expect(Object.keys(CLIENT_SETTINGS_META).sort()).toEqual([
      'client.app_login_enabled',
      'client.sso_enabled',
    ]);
    expect(Object.keys(CLIENT_DEFAULTS).sort()).toEqual(Object.keys(CLIENT_SETTINGS_META).sort());
    expect(CLIENT_DEFAULTS['client.sso_enabled']).toBe(false);
  });
});
