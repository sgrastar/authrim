import { describe, expect, it } from 'vitest';

import { directTokenHandler, isDirectAuthClientChannelAllowed } from '../direct-auth';

describe('Direct Auth compatibility endpoints', () => {
  it('returns a fatal compatibility error from the legacy token endpoint', async () => {
    const response = await directTokenHandler({} as never);
    const body = (await response.json()) as {
      error: string;
      error_description: string;
      error_uri?: string;
    };

    expect(response.status).toBe(400);
    expect(body.error).toBe('legacy_endpoint_not_supported');
    expect(body.error_description).toContain('supported');
    expect(body.error_uri).toMatch(/^https:\/\//);
    expect(body).not.toHaveProperty('access_token');
    expect(body).not.toHaveProperty('session');
    expect(body).not.toHaveProperty('user');
  });
});

describe('Direct Auth channel metadata policy', () => {
  it('allows native clients to use the native channel by default', () => {
    expect(isDirectAuthClientChannelAllowed({ application_type: 'native' }, 'native')).toBe(true);
  });

  it('rejects native clients on browser channel unless explicitly allowed', () => {
    expect(isDirectAuthClientChannelAllowed({ application_type: 'native' }, 'browser')).toBe(false);
    expect(
      isDirectAuthClientChannelAllowed(
        { application_type: 'native', allowed_channels: ['browser'] },
        'browser'
      )
    ).toBe(true);
  });

  it('rejects web clients on native channel unless explicitly allowed', () => {
    expect(isDirectAuthClientChannelAllowed({ application_type: 'web' }, 'native')).toBe(false);
    expect(
      isDirectAuthClientChannelAllowed(
        { application_type: 'web', allowed_channels: ['native'] },
        'native'
      )
    ).toBe(true);
  });

  it('treats native_channel_allowed=false as an explicit native-channel denial', () => {
    expect(
      isDirectAuthClientChannelAllowed(
        { application_type: 'native', native_channel_allowed: false },
        'native'
      )
    ).toBe(false);
    expect(
      isDirectAuthClientChannelAllowed(
        {
          application_type: 'native',
          native_channel_allowed: false,
          allowed_channels: ['native'],
        },
        'native'
      )
    ).toBe(false);
  });
});
