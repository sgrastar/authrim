import { describe, expect, it } from 'vitest';
import {
  getPublishedOIDCSigningAlgorithms,
  idTokenSigningAlgorithmRefusal,
  resolveIDTokenSigningAlgorithm,
  resolveUserInfoSigningAlgorithm,
  resolveAuthorizationResponseSigningAlgorithm,
} from '../oidc-signing';

describe('OIDC signing policy', () => {
  it('defaults ID Tokens to RS256 and unsigned UserInfo to JSON', () => {
    expect(resolveIDTokenSigningAlgorithm({})).toBe('RS256');
    expect(resolveUserInfoSigningAlgorithm({}, false)).toBe('none');
    expect(resolveUserInfoSigningAlgorithm({}, true)).toBe('RS256');
  });

  it('accepts only implemented client-selectable algorithms', () => {
    expect(resolveIDTokenSigningAlgorithm({ id_token_signed_response_alg: 'ES256' })).toBe('ES256');
    expect(resolveIDTokenSigningAlgorithm({ id_token_signed_response_alg: 'PS256' })).toBe('PS256');
    expect(() =>
      resolveUserInfoSigningAlgorithm({ userinfo_signed_response_alg: 'RS512' }, false)
    ).toThrow('Unsupported UserInfo signing algorithm');
  });

  it("signs with the tenant's algorithm unless the app may and does choose another", () => {
    const tenantES256 = { algorithm: 'ES256', appsMayChoose: true } as const;
    const lockedES256 = { algorithm: 'ES256', appsMayChoose: false } as const;
    expect(resolveIDTokenSigningAlgorithm({}, tenantES256)).toBe('ES256');
    expect(
      resolveIDTokenSigningAlgorithm({ id_token_signed_response_alg: 'PS256' }, tenantES256)
    ).toBe('PS256');
    expect(
      resolveIDTokenSigningAlgorithm({ id_token_signed_response_alg: 'PS256' }, lockedES256)
    ).toBe('ES256');
    expect(() =>
      resolveIDTokenSigningAlgorithm({ id_token_signed_response_alg: 'HS256' }, lockedES256)
    ).toThrow('Unsupported ID Token signing algorithm');
  });

  it('refuses to register another algorithm while the tenant signs every ID token alike', () => {
    const locked = { algorithm: 'ES256', appsMayChoose: false } as const;
    const open = { algorithm: 'ES256', appsMayChoose: true } as const;
    for (const value of [undefined, null, '']) {
      expect(idTokenSigningAlgorithmRefusal(value, locked)).toBeNull();
    }
    expect(idTokenSigningAlgorithmRefusal('ES256', locked)).toBeNull();
    expect(idTokenSigningAlgorithmRefusal('PS256', locked)).toMatch(/must be ES256/);
    expect(idTokenSigningAlgorithmRefusal('PS256', open)).toBeNull();
    expect(idTokenSigningAlgorithmRefusal('RS512', open)).toMatch(/must be one of/);
  });

  it('signs an encrypted UserInfo response as the app signs its ID tokens, unless it says', () => {
    expect(resolveUserInfoSigningAlgorithm({}, true, 'PS256')).toBe('PS256');
    expect(
      resolveUserInfoSigningAlgorithm({ userinfo_signed_response_alg: 'none' }, true, 'PS256')
    ).toBe('PS256');
    expect(
      resolveUserInfoSigningAlgorithm({ userinfo_signed_response_alg: 'ES256' }, true, 'PS256')
    ).toBe('ES256');
    expect(resolveUserInfoSigningAlgorithm({}, false, 'PS256')).toBe('none');
  });

  it('defaults JARM to RS256 but permits a profile default and a client ES256 choice', () => {
    expect(resolveAuthorizationResponseSigningAlgorithm({})).toBe('RS256');
    expect(resolveAuthorizationResponseSigningAlgorithm({}, 'ES256')).toBe('ES256');
    expect(
      resolveAuthorizationResponseSigningAlgorithm(
        { authorization_signed_response_alg: 'ES256' },
        'RS256'
      )
    ).toBe('ES256');
    expect(
      resolveAuthorizationResponseSigningAlgorithm({
        authorization_signed_response_alg: 'PS256',
      })
    ).toBe('PS256');
  });

  it('advertises only algorithms backed by matching public JWKS keys', () => {
    expect(
      getPublishedOIDCSigningAlgorithms([
        { kty: 'RSA', use: 'sig', alg: 'RS256', n: 'n', e: 'AQAB' },
        { kty: 'EC', use: 'sig', alg: 'ES256', crv: 'P-256', x: 'x', y: 'y' },
        { kty: 'RSA', use: 'sig', alg: 'PS256', n: 'n', e: 'AQAB' },
      ])
    ).toEqual(['RS256', 'ES256', 'PS256']);
  });
});
