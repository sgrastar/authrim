import { describe, expect, it } from 'vitest';
import {
  getPublishedOIDCSigningAlgorithms,
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
    expect(() => resolveIDTokenSigningAlgorithm({ id_token_signed_response_alg: 'PS256' })).toThrow(
      'Unsupported ID Token signing algorithm'
    );
    expect(() =>
      resolveUserInfoSigningAlgorithm({ userinfo_signed_response_alg: 'RS512' }, false)
    ).toThrow('Unsupported UserInfo signing algorithm');
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
    expect(() =>
      resolveAuthorizationResponseSigningAlgorithm({
        authorization_signed_response_alg: 'PS256',
      })
    ).toThrow('Unsupported authorization response signing algorithm');
  });

  it('advertises only algorithms backed by matching public JWKS keys', () => {
    expect(
      getPublishedOIDCSigningAlgorithms([
        { kty: 'RSA', use: 'sig', alg: 'RS256', n: 'n', e: 'AQAB' },
        { kty: 'EC', use: 'sig', alg: 'ES256', crv: 'P-256', x: 'x', y: 'y' },
        { kty: 'RSA', use: 'sig', alg: 'PS256', n: 'n', e: 'AQAB' },
      ])
    ).toEqual(['RS256', 'ES256']);
  });
});
