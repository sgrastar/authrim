/**
 * The access token audience a grant resolves from resource / audience parameters and the client's
 * defaults (resolveAccessTokenAudience), driven through the client_credentials grant, which
 * refuses a resource and an audience that name different targets.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockContext } from './helpers/mocks';
import {
  SERVICE_CLIENT,
  TARGET,
  baseClient,
  body,
  expectError,
  issuedClaims,
  keyEnv,
  m,
  resetExchange,
} from './helpers/mut-exchange-harness';

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const h = await import('./helpers/mut-exchange-harness');
  return h.mockCore(await importOriginal());
});
vi.mock('../external-id-jag-verifier', async () =>
  (await import('./helpers/mut-exchange-harness')).mockJagVerifier()
);

import { tokenHandler } from '../token';

const OTHER = 'https://other.example.com';

async function clientCredentials(params: Record<string, string | undefined>): Promise<Response> {
  const form: Record<string, string> = {
    grant_type: 'client_credentials',
    client_id: SERVICE_CLIENT,
    client_secret: 'top-secret',
  };
  for (const [key, value] of Object.entries(params)) if (value !== undefined) form[key] = value;
  return tokenHandler(createMockContext({ method: 'POST', body: form, env: await keyEnv() }));
}

function useClient(overrides: Record<string, unknown>): void {
  m.getClientCached.mockImplementation(async (_c: unknown, _e: unknown, id: string) =>
    id === SERVICE_CLIENT
      ? baseClient({ client_credentials_allowed: true, allowed_scopes: undefined, ...overrides })
      : null
  );
}

async function issuedAudience(response: Response): Promise<unknown> {
  expect(response.status).toBe(200);
  return issuedClaims().aud;
}

describe('access token audience (client_credentials)', () => {
  beforeEach(() => {
    resetExchange();
    m.protocolSettings.mockResolvedValue({ oidc: { clientCredentials: { enabled: true } } });
    m.loadTenantProfileCached.mockResolvedValue({
      allows_client_credentials: true,
      max_token_ttl_seconds: 3600,
    });
    useClient({});
  });

  it('issues for the requested audience', async () => {
    const response = await clientCredentials({ audience: TARGET });
    expect(await issuedAudience(response)).toBe(TARGET);
    expect(issuedClaims().sub).toBe(`client:${SERVICE_CLIENT}`);
    expect((await body(response)).token_type).toBe('Bearer');
  });

  it('issues for the requested resource, trimmed', async () => {
    expect(await issuedAudience(await clientCredentials({ resource: `  ${TARGET} ` }))).toBe(
      TARGET
    );
  });

  it('accepts a resource and an audience naming the same target', async () => {
    expect(
      await issuedAudience(await clientCredentials({ resource: TARGET, audience: ` ${TARGET}` }))
    ).toEqual([TARGET, TARGET]);
  });

  it('refuses a resource and an audience naming different targets', async () => {
    await expectError(
      await clientCredentials({ resource: TARGET, audience: OTHER }),
      400,
      'invalid_target',
      'resource and audience identify different access token targets'
    );
  });

  it('treats a blank parameter as absent and uses the client default resource', async () => {
    useClient({ default_resource: TARGET });
    expect(await issuedAudience(await clientCredentials({ resource: '   ', audience: '' }))).toBe(
      TARGET
    );
  });

  it('uses the client default audience when there is no default resource', async () => {
    useClient({ default_resource: '', default_audience: OTHER });
    expect(await issuedAudience(await clientCredentials({}))).toBe(OTHER);
  });

  it('refuses when there is no target and no usable default', async () => {
    useClient({ default_resource: '', default_audience: '' });
    await expectError(
      await clientCredentials({}),
      400,
      'invalid_target',
      'No target resource is configured for this access token'
    );
  });

  it('refuses a target the client may not use, and allows any without a list', async () => {
    await expectError(
      await clientCredentials({ audience: 'https://elsewhere.example' }),
      400,
      'invalid_target',
      'Requested audience/resource not allowed: https://elsewhere.example'
    );
    useClient({ allowed_token_exchange_resources: [] });
    expect(
      await issuedAudience(await clientCredentials({ audience: 'https://elsewhere.example' }))
    ).toBe('https://elsewhere.example');
  });

  it('caps the access token lifetime at the tenant profile maximum', async () => {
    m.loadTenantProfileCached.mockResolvedValue({
      allows_client_credentials: true,
      max_token_ttl_seconds: 900,
    });
    const response = await clientCredentials({ audience: TARGET });
    expect((await body(response)).expires_in).toBe(900);
    expect(m.createAccessToken.mock.calls[0][3]).toBe(900);
  });
});
