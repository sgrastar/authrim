import { describe, expect, it } from 'vitest';
import {
  buildExternalStartUrl,
  validateThirdPartyInitiatedIssuer,
} from '../handlers/initiate-login';

describe('third-party initiated login', () => {
  it('requires an exact HTTPS issuer match', () => {
    expect(validateThirdPartyInitiatedIssuer(undefined, 'https://op.example')).toBe(
      'iss is required'
    );
    expect(validateThirdPartyInitiatedIssuer('http://op.example', 'http://op.example')).toBe(
      'iss must use https'
    );
    expect(validateThirdPartyInitiatedIssuer('https://op.example/', 'https://op.example')).toBe(
      'iss does not match the configured provider issuer'
    );
    expect(
      validateThirdPartyInitiatedIssuer('https://op.example', 'https://op.example')
    ).toBeUndefined();
  });

  it('passes login_hint and a validated-later target_link_uri to the start flow', () => {
    const parameters = new URLSearchParams({
      iss: 'https://op.example',
      client_id: 'downstream-client',
      redirect_uri: 'https://rp.example/default',
      code_challenge: 'challenge',
      code_challenge_method: 'S256',
      login_hint: 'alice@example.com',
      target_link_uri: 'https://rp.example/target',
      ignored: 'not-forwarded',
    });
    const url = buildExternalStartUrl('https://rp.example', 'test/provider', {
      iss: parameters.get('iss') ?? undefined,
      loginHint: parameters.get('login_hint') ?? undefined,
      targetLinkUri: parameters.get('target_link_uri') ?? undefined,
      parameters,
    });

    expect(url.pathname).toBe('/auth/external/test%2Fprovider/start');
    expect(url.searchParams.get('client_id')).toBe('downstream-client');
    expect(url.searchParams.get('redirect_uri')).toBe('https://rp.example/target');
    expect(url.searchParams.get('login_hint')).toBe('alice@example.com');
    expect(url.searchParams.has('iss')).toBe(false);
    expect(url.searchParams.has('ignored')).toBe(false);
  });
});
