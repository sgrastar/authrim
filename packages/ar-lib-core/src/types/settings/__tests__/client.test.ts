import { describe, expect, it } from 'vitest';
import { CLIENT_DEFAULTS, CLIENT_SETTINGS_META } from '../client';

describe('CLIENT_SETTINGS_META', () => {
  it('keeps only per-app settings the runtime reads', () => {
    // The app's registration metadata (grant types, URIs, channels, token policy) lives in the
    // client registration, not in the settings catalog.
    expect(Object.keys(CLIENT_SETTINGS_META).sort()).toEqual([
      'client.app_login_enabled',
      'client.default_audience',
      'client.default_resource',
      'client.sso_enabled',
    ]);
    expect(CLIENT_DEFAULTS['client.default_resource']).toBe('');
    expect(CLIENT_DEFAULTS['client.sso_enabled']).toBe(false);
  });
});
