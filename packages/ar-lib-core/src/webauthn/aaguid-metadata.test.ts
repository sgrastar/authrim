import { describe, expect, it } from 'vitest';
import { normalizeAaguid, resolveAaguidAuthenticator } from './aaguid-metadata';

describe('AAGUID authenticator display metadata', () => {
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
