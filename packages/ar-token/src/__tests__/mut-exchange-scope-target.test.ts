/**
 * Token Exchange: the scope granted (requested ∩ subject ∩ client policy) and the audience and
 * resource the exchanged token is for.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SERVICE_CLIENT,
  TARGET,
  baseClient,
  body,
  clientSubject,
  exchangeContext,
  expectError,
  issuedClaims,
  keyEnv,
  m,
  resetExchange,
  settingsOverrides,
  userSubject,
} from './helpers/mut-exchange-harness';

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const h = await import('./helpers/mut-exchange-harness');
  return h.mockCore(await importOriginal());
});
vi.mock('../external-id-jag-verifier', async () =>
  (await import('./helpers/mut-exchange-harness')).mockJagVerifier()
);

import { tokenHandler } from '../token';

async function exchange(bodyOverrides: Record<string, unknown> = {}): Promise<Response> {
  return tokenHandler(exchangeContext(bodyOverrides, { env: await keyEnv() }));
}

function useClient(overrides: Record<string, unknown>): void {
  m.getClientCached.mockImplementation(async (_c: unknown, _e: unknown, id: string) =>
    id === SERVICE_CLIENT ? baseClient(overrides) : null
  );
}

async function grantedScope(response: Response): Promise<unknown> {
  expect(response.status).toBe(200);
  const scope = (await body(response)).scope;
  expect(issuedClaims().scope).toBe(scope);
  return scope;
}

const NOT_PERMITTED = 'Requested scope is not permitted for this token exchange';

describe('granted scope', () => {
  beforeEach(() => resetExchange());

  it('never grants a requested scope the subject token does not carry', async () => {
    expect(await grantedScope(await exchange({ scope: 'openid email' }))).toBe('openid');
  });

  it('inherits the subject scope, ignoring repeated spaces', async () => {
    useClient({ allowed_scopes: undefined });
    m.parseToken.mockReturnValue(userSubject({ scope: 'openid  profile' }));
    expect(await grantedScope(await exchange())).toBe('openid profile');
  });

  it('lets the subject scope stand when the client has no scope policy', async () => {
    useClient({ allowed_scopes: undefined });
    expect(await grantedScope(await exchange({ scope: 'profile' }))).toBe('profile');
  });

  it('bounds a subject token without scope by the client policy', async () => {
    m.parseToken.mockReturnValue(clientSubject({ scope: undefined }));
    expect(await grantedScope(await exchange({ scope: 'profile' }))).toBe('profile');
  });

  it('grants nothing to a subject token without scope when the client has no policy', async () => {
    useClient({ allowed_scopes: undefined });
    m.parseToken.mockReturnValue(clientSubject({ scope: undefined }));
    await expectError(await exchange({ scope: 'profile' }), 400, 'invalid_scope', NOT_PERMITTED);
  });

  it('grants nothing to an ID token without scope', async () => {
    settingsOverrides.tokens = {
      'tokens.exchange_allowed_subject_token_types': 'access_token,id_token',
    };
    m.parseToken.mockReturnValue(
      userSubject({ token_use: undefined, scope: undefined, authrim_subject_account: true })
    );
    await expectError(
      await exchange({ subject_token_type: 'urn:ietf:params:oauth:token-type:id_token' }),
      400,
      'invalid_scope',
      NOT_PERMITTED
    );
  });

  it('refuses when nothing requested survives the intersection', async () => {
    await expectError(await exchange({ scope: 'admin' }), 400, 'invalid_scope', NOT_PERMITTED);
  });
});

describe('audience and resource', () => {
  beforeEach(() => resetExchange());

  it('uses the client default resource, then its default audience', async () => {
    useClient({ default_resource: TARGET });
    expect((await exchange({ audience: undefined })).status).toBe(200);
    expect(issuedClaims().aud).toBe(TARGET);
    expect(issuedClaims()).not.toHaveProperty('resource');

    m.createAccessToken.mockClear();
    useClient({ default_audience: 'https://other.example.com' });
    expect((await exchange({ audience: undefined })).status).toBe(200);
    expect(issuedClaims().aud).toBe('https://other.example.com');
  });

  it('refuses a request with no target when the client has no default', async () => {
    useClient({ default_resource: '', default_audience: '' });
    await expectError(
      await exchange({ audience: undefined }),
      400,
      'invalid_target',
      'No target resource is configured for this access token'
    );
  });

  it('puts a single resource in both aud and resource', async () => {
    expect((await exchange({ audience: undefined, resource: TARGET })).status).toBe(200);
    expect(issuedClaims()).toMatchObject({ aud: TARGET, resource: TARGET });
  });

  it.each([[[]], [undefined]])(
    'allows any target when the client lists no resources (%j)',
    async (allowed) => {
      useClient({ allowed_token_exchange_resources: allowed });
      expect((await exchange({ audience: 'https://anywhere.example' })).status).toBe(200);
      expect(issuedClaims().aud).toBe('https://anywhere.example');
    }
  );

  it('names every target that is not allowed', async () => {
    await expectError(
      await exchange({ audience: ['https://a.example', TARGET, 'https://b.example'] }),
      403,
      'invalid_target',
      'Requested audience/resource not allowed: https://a.example, https://b.example'
    );
  });

  it.each([
    ['ftp://files.example/x', 'must be an absolute URI with http or https scheme'],
    ['https://service.example.com/#frag', 'must not include a fragment component'],
    ['not a uri', 'must be a valid absolute URI'],
  ])('refuses the resource %s', async (resource, reason) => {
    await expectError(
      await exchange({ resource }),
      400,
      'invalid_request',
      `resource '${resource}' ${reason}`
    );
  });
});
