import { describe, expect, it } from 'vitest';
import { CLIENT_DEFAULTS, CLIENT_SETTINGS_META } from '../client';

describe('CLIENT_SETTINGS_META', () => {
  it('defines Phase 1 client policy metadata defaults', () => {
    expect(CLIENT_SETTINGS_META['client.trust_group'].visibility).toBe('admin');
    expect(CLIENT_SETTINGS_META['client.browser_public_client_mode'].enum).toEqual([
      '',
      'strict',
      'cookie_fallback',
      'legacy',
    ]);
    expect(CLIENT_SETTINGS_META['client.browser_refresh_token_policy'].enum).toEqual([
      'disabled',
      'dpop_bound',
    ]);

    expect(CLIENT_DEFAULTS['client.trust_group']).toBe('');
    expect(CLIENT_DEFAULTS['client.browser_public_client_mode']).toBe('');
    expect(CLIENT_DEFAULTS['client.browser_refresh_token_policy']).toBe('disabled');
    expect(CLIENT_DEFAULTS['client.native_sso_enabled']).toBe(true);
    expect(CLIENT_DEFAULTS['client.native_channel_allowed']).toBe(true);
    expect(CLIENT_DEFAULTS['client.allowed_channels']).toBe('');
    expect(CLIENT_DEFAULTS['client.default_resource']).toBe('');
  });
});
