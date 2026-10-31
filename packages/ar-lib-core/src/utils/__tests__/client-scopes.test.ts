import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CLIENT_AUTHORIZATION_SCOPES,
  getClientAllowedScopes,
  parseScopeList,
} from '../client-scopes';
import { isDeviceCodePublicClient } from '../client-authentication';

describe('parseScopeList', () => {
  it('splits on any whitespace and drops empty entries', () => {
    expect(parseScopeList(' openid \t profile\nemail  ')).toEqual(['openid', 'profile', 'email']);
    expect(parseScopeList('')).toEqual([]);
    expect(parseScopeList(undefined)).toEqual([]);
    expect(parseScopeList(null)).toEqual([]);
  });
});

describe('getClientAllowedScopes', () => {
  it('prefers requestable_scopes, then allowed_scopes, then the registered scope', () => {
    expect(
      getClientAllowedScopes({
        requestable_scopes: ['a'],
        allowed_scopes: ['b'],
        scope: 'c',
      })
    ).toEqual(['a']);
    expect(getClientAllowedScopes({ allowed_scopes: ['b'], scope: 'c' })).toEqual(['b']);
    expect(getClientAllowedScopes({ scope: 'c d' })).toEqual(['c', 'd']);
  });

  it('skips empty lists', () => {
    expect(
      getClientAllowedScopes({ requestable_scopes: [], allowed_scopes: [], scope: 'c' })
    ).toEqual(['c']);
  });

  it('falls back to the OpenID Connect defaults, as a copy', () => {
    const scopes = getClientAllowedScopes({});
    expect(scopes).toEqual([...DEFAULT_CLIENT_AUTHORIZATION_SCOPES]);
    scopes.push('x');
    expect(getClientAllowedScopes({})).toEqual(['openid', 'profile', 'email']);
  });
});

describe('isDeviceCodePublicClient', () => {
  it.each([
    [{ token_endpoint_auth_method: 'none' }, true],
    [{ token_endpoint_auth_method: 'none', client_secret_hash: 'h' }, true],
    // a legacy record with neither method nor secret authenticates as confidential at the token
    // endpoint (and so fails there), so it is not public for the device grant
    [{}, false],
    [{ client_secret_hash: 'h' }, false],
    [{ token_endpoint_auth_method: 'client_secret_basic' }, false],
    [{ token_endpoint_auth_method: 'client_secret_post' }, false],
    [{ token_endpoint_auth_method: 'client_secret_jwt' }, false],
    [{ token_endpoint_auth_method: 'private_key_jwt' }, false],
  ] as const)('%j is public: %s', (client, expected) => {
    expect(isDeviceCodePublicClient(client as never)).toBe(expected);
  });
});
