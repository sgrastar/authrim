import { describe, expect, it } from 'vitest';
import { FIRST_PARTY_AAGUID_AUTHENTICATORS } from './aaguid-first-party';
import { findAaguidMetadata, normalizeAaguid, resolveAaguidAuthenticator } from './aaguid-metadata';

describe('first-party AAGUID entries', () => {
  it('only uses lower-case canonical UUID keys', () => {
    for (const key of Object.keys(FIRST_PARTY_AAGUID_AUTHENTICATORS)) {
      expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(normalizeAaguid(key)).toBe(key);
    }
  });

  it('wins over the community table for the same AAGUID', () => {
    const key = '6f1c5e2a-7b4d-4e8f-9a3c-2d5b8e1f0a47';
    const community = { [key]: { name: 'Community name' } };
    expect(findAaguidMetadata(key, FIRST_PARTY_AAGUID_AUTHENTICATORS, community)?.name).toBe(
      'Authrim Keyring'
    );
    expect(findAaguidMetadata(key, {}, community)?.name).toBe('Community name');
  });
});

describe('AAGUID authenticator display metadata', () => {
  it('knows Authrim Keyring with its app icon', () => {
    const metadata = resolveAaguidAuthenticator('6F1C5E2A-7B4D-4E8F-9A3C-2D5B8E1F0A47');

    expect(metadata).toMatchObject({ name: 'Authrim Keyring', known: true });
    expect(metadata?.icon_light).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(metadata?.icon_dark).toBe(metadata?.icon_light);
  });

  it('resolves known authenticator metadata with icons', () => {
    const metadata = resolveAaguidAuthenticator('08987058-CADC-4B81-B6E1-30DE50DCBE96');

    expect(metadata).toMatchObject({
      aaguid: '08987058-cadc-4b81-b6e1-30de50dcbe96',
      name: 'Windows Hello',
      known: true,
    });
    expect(metadata?.icon_light).toMatch(/^data:image\/svg\+xml;base64,/);
  });

  it('returns display-safe unknown metadata for unmapped AAGUIDs', () => {
    expect(resolveAaguidAuthenticator('11111111-1111-1111-1111-111111111111')).toEqual({
      aaguid: '11111111-1111-1111-1111-111111111111',
      name: null,
      icon_dark: null,
      icon_light: null,
      known: false,
    });
  });

  it('suppresses empty and zero AAGUIDs', () => {
    expect(normalizeAaguid(null)).toBeNull();
    expect(resolveAaguidAuthenticator('00000000-0000-0000-0000-000000000000')).toBeNull();
  });
});
