import { describe, expect, it, vi } from 'vitest';
import { tokenNamesNonLocalSubject, tokenTenantClaim } from '../check-access-token';
import { authenticateCheckApiRequest, checkContractOf } from '../check-auth';

function jwt(): string {
  const part = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${part({ alg: 'RS256' })}.${part({ sub: 'u' })}.c2ln`;
}

describe('tokenTenantClaim', () => {
  it('reads the trimmed tenant_id claim, else none (the issuer is not mapped to a tenant)', () => {
    expect(tokenTenantClaim({ tenant_id: ' tenant-a ', iss: 'https://tenant-b.example.com' })).toBe(
      'tenant-a'
    );
    expect(tokenTenantClaim({ iss: 'https://tenant-b.example.com' })).toBeNull();
    expect(tokenTenantClaim({ tenant_id: '  ' })).toBeNull();
  });
});

describe('tokenNamesNonLocalSubject', () => {
  const user = { sub: 'user-1', token_use: 'access', jti: 'j1', client_id: 'app' };

  it('accepts a local end-user account', () => {
    expect(tokenNamesNonLocalSubject(user)).toBe(false);
  });

  it.each([
    ['a token exchange of an external subject', { ...user, authrim_subject_issuer: 'https://x' }],
    ['a client_credentials token', { ...user, sub: 'client:app' }],
    ['a machine principal', { ...user, sub: 'machine:m1' }],
    ['an admin agent principal', { ...user, sub: 'admin_user:a1' }],
    ['no sub', { ...user, sub: undefined }],
  ])('refuses %s', (_label, claims) => {
    expect(tokenNamesNonLocalSubject(claims)).toBe(true);
  });
});

describe('check-auth with an access token verifier', () => {
  it('uses the verifier, reports the self contract and the token’s own sub', async () => {
    const verifier = vi.fn(async () => ({
      valid: true,
      subjectId: 'user-real',
      tokenSubject: 'pairwise-sub',
      clientId: 'app',
      tenantId: 'tenant-a',
    }));
    const token = jwt();
    const auth = await authenticateCheckApiRequest(`Bearer ${token}`, {
      db: {} as never,
      accessTokenVerifier: verifier,
    });
    expect(verifier).toHaveBeenCalledWith(token, 'Bearer');
    expect(auth).toMatchObject({
      authenticated: true,
      method: 'access_token',
      subjectId: 'user-real',
      tokenSubject: 'pairwise-sub',
      tenantId: 'tenant-a',
      allowedOperations: ['check', 'batch'],
    });
    expect(checkContractOf(auth)).toBe('self');
  });

  it.each([
    ['invalid_tenant', 401],
    ['invalid_audience', 401],
    ['non_account_subject', 401],
    ['invalid_client', 401],
    ['temporarily_unavailable', 503],
  ])('maps a %s failure to %i', async (error, statusCode) => {
    const auth = await authenticateCheckApiRequest(`Bearer ${jwt()}`, {
      db: {} as never,
      accessTokenVerifier: async () => ({ valid: false, error }),
    });
    expect(auth).toMatchObject({ authenticated: false, statusCode });
  });

  it('reports the server contract for the policy secret', async () => {
    const auth = await authenticateCheckApiRequest('Bearer secret', {
      db: {} as never,
      policyApiSecret: 'secret',
    });
    expect(checkContractOf(auth)).toBe('server');
  });
});
