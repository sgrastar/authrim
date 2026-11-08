import { describe, expect, it, vi } from 'vitest';

const revokeUser = vi.hoisted(() => vi.fn());
vi.mock('../services/user-token-revocation', () => ({
  revokeUserLinkedIdentityTokens: revokeUser,
}));

import worker, { ExternalIdpAdminEntrypoint } from '../index';

const props = {
  caller: 'ar-management',
  environmentId: 'test',
  audience: 'authrim-external-idp-admin-v1',
};
const env = { AUTHRIM_ENVIRONMENT_NAME: 'test', ENABLE_RATE_LIMIT: 'false' } as never;
const context = (p: unknown = props) =>
  ({
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
    props: p,
  }) as unknown as ExecutionContext;
const entry = (p: unknown = props, e: unknown = env) =>
  new ExternalIdpAdminEntrypoint(context(p), e as never);
const get = (path: string) => new Request(`https://external-idp${path}`);

describe('public bridge fetch', () => {
  it.each([
    '/api/admin/external-providers',
    '/api/admin/external-providers/p1',
    '/api/admin/external-token-refresh/config',
    '/api/admin/anything',
    '/api/admin',
    // Spellings a router could still resolve to an admin route.
    '/api/%61dmin/external-providers',
    '//api/admin/external-providers',
    '/API/Admin/external-providers',
    '/api/admin%2Fexternal-providers',
    '/api/%E0%A4%A/admin',
  ])('refuses %s with 404 before any handler or auth', async (path) => {
    const response = await worker.fetch(get(path), env, context());
    expect(response.status).toBe(404);
  });

  it('still serves public routes', async () => {
    const response = await worker.fetch(get('/health'), env, context());
    expect(response.status).not.toBe(404);
  });
});

describe('ExternalIdpAdminEntrypoint', () => {
  it.each([
    ['missing props', null],
    ['wrong caller', { ...props, caller: 'ar-auth' }],
    ['wrong audience', { ...props, audience: 'other' }],
    ['wrong environment', { ...props, environmentId: 'prod' }],
    ['missing environment', { ...props, environmentId: undefined }],
  ])('refuses %s with 403', async (_name, p) => {
    const response = await entry(p).fetch(get('/api/admin/external-providers'));
    expect(response.status).toBe(403);
  });

  it('fails closed when the Worker has no environment name', async () => {
    const response = await entry(props, {}).fetch(get('/api/admin/external-providers'));
    expect(response.status).toBe(403);
  });

  it.each([
    '/api/admin/other',
    '/api/admin/external-providers-evil',
    '/api/external/providers',
    '/health',
  ])('refuses path %s outside the allowed admin prefixes', async (path) => {
    const response = await entry().fetch(get(path));
    expect(response.status).toBe(404);
  });

  it('serves an allowed path with correct props (reaches the admin auth middleware)', async () => {
    const response = await entry().fetch(get('/api/admin/external-providers'));
    // Not refused by the entrypoint: the request reached the app, whose own admin auth (no
    // credentials were forwarded) and tenant checks still apply.
    const body = await response.text();
    expect(body).not.toContain('"access_denied"');
    expect(body).not.toContain('"not_found"');
    expect(response.status).toBeGreaterThanOrEqual(400);
  });
});

describe('ExternalIdpAdminEntrypoint.revokeUserLinkedIdentityTokens', () => {
  const input = {
    schemaVersion: 1 as const,
    tenantId: 'tenant-a',
    userId: 'user-1',
    timeoutMs: 500,
  };

  it.each([
    ['missing props', null],
    ['wrong caller', { ...props, caller: 'ar-auth' }],
    ['wrong audience', { ...props, audience: 'other' }],
    ['wrong environment', { ...props, environmentId: 'prod' }],
  ])('refuses %s before reading anything', async (_name, p) => {
    revokeUser.mockReset();
    await expect(entry(p).revokeUserLinkedIdentityTokens(input)).rejects.toThrow('access_denied');
    expect(revokeUser).not.toHaveBeenCalled();
  });

  it('fails closed when the Worker has no environment name', async () => {
    revokeUser.mockReset();
    await expect(entry(props, {}).revokeUserLinkedIdentityTokens(input)).rejects.toThrow(
      'access_denied'
    );
    expect(revokeUser).not.toHaveBeenCalled();
  });

  it("passes only the caller's input to the revocation", async () => {
    const answer = { schemaVersion: 1, identities: [] };
    revokeUser.mockReset().mockResolvedValue(answer);

    await expect(entry().revokeUserLinkedIdentityTokens(input)).resolves.toBe(answer);

    expect(revokeUser).toHaveBeenCalledWith(env, input);
  });
});
