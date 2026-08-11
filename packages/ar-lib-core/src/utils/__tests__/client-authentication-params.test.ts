import { describe, expect, it } from 'vitest';
import { parseOAuthClientAuthenticationParams } from '../client-authentication';

function basic(username: string, password: string): string {
  return `Basic ${btoa(`${encodeURIComponent(username)}:${encodeURIComponent(password)}`)}`;
}

describe('parseOAuthClientAuthenticationParams', () => {
  it('rejects a Basic username that conflicts with body client_id', () => {
    expect(
      parseOAuthClientAuthenticationParams({
        clientId: 'body-client',
        authorizationHeader: basic('basic-client', 'secret'),
      })
    ).toMatchObject({ ok: false, error: 'invalid_client' });
  });

  it('accepts a matching body client_id as an identifier alongside Basic authentication', () => {
    expect(
      parseOAuthClientAuthenticationParams({
        clientId: 'same-client',
        authorizationHeader: basic('same-client', 'secret'),
      })
    ).toEqual({
      ok: true,
      credentials: {
        clientId: 'same-client',
        clientSecret: 'secret',
        clientAssertion: undefined,
        clientAssertionType: undefined,
        presentation: {
          basic: true,
          clientSecretPost: false,
          clientAssertion: false,
          clientAssertionType: undefined,
        },
      },
    });
  });

  it('rejects multiple client authentication methods', () => {
    expect(
      parseOAuthClientAuthenticationParams({
        clientId: 'client',
        clientSecret: 'posted-secret',
        authorizationHeader: basic('client', 'basic-secret'),
      })
    ).toMatchObject({ ok: false, error: 'invalid_client' });
  });
});
