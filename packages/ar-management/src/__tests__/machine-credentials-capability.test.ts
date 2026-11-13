/**
 * The machine_credentials capability on the machine access routes: while it is off, nothing that
 * issues or widens a machine credential is written (create, rotate, re-enable, and a change of
 * permissions, tenants or validity); revoking, disabling, deleting, reading and renaming stay.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core';

const { mockRepo, capability, audit } = vi.hoisted(() => ({
  capability: vi.fn<() => Promise<'on' | 'off' | 'unknown'>>(),
  audit: vi.fn(),
  mockRepo: {
    listPrincipals: vi.fn(),
    findPrincipalById: vi.fn(),
    findPrincipalByClientId: vi.fn(),
    getPrincipalRevision: vi.fn(),
    getCredentialRevision: vi.fn(),
    createPrincipalWithGrant: vi.fn(),
    updatePrincipalWithGrant: vi.fn(),
    createCredentialWithGrant: vi.fn(),
    updateCredentialWithGrant: vi.fn(),
    rotateCredential: vi.fn(),
    updatePrincipal: vi.fn(),
    findCredentialById: vi.fn(),
    updateCredential: vi.fn(),
    deleteCredential: vi.fn(),
    deletePrincipal: vi.fn(),
    getPrincipalPermissions: vi.fn(),
    getPrincipalTenantScopes: vi.fn(),
    getCredentialPermissions: vi.fn(),
    getCredentialTenantScopes: vi.fn(),
    listCredentials: vi.fn(),
  },
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getTenantCapabilityState: capability,
    adminAuthMiddleware: vi.fn(
      () =>
        async (
          c: {
            req: { header: (name: string) => string | undefined };
            set: (key: string, value: unknown) => void;
          },
          next: () => Promise<void>
        ) => {
          const permissions = (c.req.header('X-Admin-Permissions') || '')
            .split(',')
            .map((entry) => entry.trim())
            .filter(Boolean);
          const tenantScope = (c.req.header('X-Admin-Tenant-Scope') || 'tenant-a').split(',');
          c.set('adminAuth', {
            userId: 'admin-1',
            authMethod: 'session',
            actorType: 'human',
            actorId: 'admin-1',
            roles: [],
            permissions,
            globalPermissions: tenantScope.includes('*') ? permissions : [],
            tenantId: 'tenant-a',
            tenantScope,
          });
          c.set('tenantId', 'tenant-a');
          return next();
        }
    ),
    requireDedicatedAdminDatabaseAdapter: vi.fn(() => ({})),
    AdminMachineAccessRepository: vi.fn(function MockRepository() {
      return mockRepo;
    }),
  };
});
vi.mock('../admin-step-up-gate', () => ({
  requireAdminStepUp: vi.fn(async () => null),
  refuseAdminFreshAuth: vi.fn(),
}));
vi.mock('../admin-shared', () => ({ writeAdminAuditLog: audit }));

import { machineAccessRouter } from '../routes/admin-management/machine-access';

const BASE = '/api/admin/machine-access';
const TENANT_ADMIN = 'admin:machine_access:*,admin:agent_grants:*';
const PLATFORM_ADMIN = '*';

function request(
  method: string,
  path: string,
  body?: unknown,
  who: { permissions: string; scope: string } = { permissions: TENANT_ADMIN, scope: 'tenant-a' }
) {
  const app = new Hono<{ Bindings: Env }>();
  app.route(BASE, machineAccessRouter);
  return app.request(
    `${BASE}${path}`,
    {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Permissions': who.permissions,
        'X-Admin-Tenant-Scope': who.scope,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    {}
  );
}

const PRINCIPAL = {
  id: 'amp_1',
  clientId: 'portal',
  displayName: 'Portal',
  principalType: 'mcp_server',
  status: 'active',
  tokenTtlSeconds: 600,
};
const CREDENTIAL = { id: 'amk_1', principalId: 'amp_1', status: 'active' };

function nothingIssued() {
  expect(mockRepo.createPrincipalWithGrant).not.toHaveBeenCalled();
  expect(mockRepo.updatePrincipalWithGrant).not.toHaveBeenCalled();
  expect(mockRepo.createCredentialWithGrant).not.toHaveBeenCalled();
  expect(mockRepo.updateCredentialWithGrant).not.toHaveBeenCalled();
  expect(mockRepo.rotateCredential).not.toHaveBeenCalled();
  expect(mockRepo.updatePrincipal).not.toHaveBeenCalled();
  expect(mockRepo.updateCredential).not.toHaveBeenCalled();
  expect(audit).not.toHaveBeenCalled();
}

const ISSUING: Array<[string, string, string, unknown]> = [
  [
    'create a principal',
    'POST',
    '/principals',
    {
      client_id: 'portal',
      display_name: 'Portal',
      principal_type: 'mcp_server',
      permissions: ['admin:agent_grants:*'],
      tenant_scopes: [{ scope_mode: 'all' }],
    },
  ],
  [
    'create a credential',
    'POST',
    '/principals/amp_1/credentials',
    { kid: 'k1', display_name: 'k' },
  ],
  ['rotate a credential', 'POST', '/principals/amp_1/credentials/amk_1/rotate', {}],
  ['re-enable a principal', 'POST', '/principals/amp_1/enable', {}],
  [
    'change the permissions of a principal',
    'PATCH',
    '/principals/amp_1',
    { permissions: ['admin:agent_grants:*'] },
  ],
  [
    'change the tenants of a principal',
    'PATCH',
    '/principals/amp_1',
    { tenant_scopes: [{ scope_mode: 'all' }] },
  ],
  [
    'extend the expiry of a credential',
    'PATCH',
    '/principals/amp_1/credentials/amk_1',
    { expires_at: 4102444800000 },
  ],
  [
    'change the permissions of a credential (narrowing included)',
    'PATCH',
    '/principals/amp_1/credentials/amk_1',
    { permissions: [] },
  ],
  [
    'make a credential usable again',
    'PATCH',
    '/principals/amp_1/credentials/amk_1',
    { status: 'active' },
  ],
];

describe('machine_credentials capability on the machine access routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capability.mockResolvedValue('on');
    mockRepo.getPrincipalPermissions.mockResolvedValue(['admin:agent_grants:*']);
    mockRepo.getPrincipalTenantScopes.mockResolvedValue([
      { scopeMode: 'allow', tenantId: 'tenant-a' },
    ]);
    mockRepo.getCredentialPermissions.mockResolvedValue(['admin:agent_grants:*']);
    mockRepo.getCredentialTenantScopes.mockResolvedValue([
      { scopeMode: 'allow', tenantId: 'tenant-a' },
    ]);
    mockRepo.listCredentials.mockResolvedValue([]);
    mockRepo.getPrincipalRevision.mockResolvedValue('p-rev');
    mockRepo.getCredentialRevision.mockResolvedValue('c-rev');
    mockRepo.findPrincipalByClientId.mockResolvedValue(null);
    mockRepo.findPrincipalById.mockResolvedValue({ ...PRINCIPAL, status: 'disabled' });
    mockRepo.findCredentialById.mockResolvedValue(CREDENTIAL);
    mockRepo.listPrincipals.mockResolvedValue([PRINCIPAL]);
  });

  describe.each(ISSUING)('while off: %s', (_name, method, path, body) => {
    it('is refused with 403 capability_disabled and writes nothing', async () => {
      capability.mockResolvedValue('off');
      const res = await request(method, path, body);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({
        error: 'capability_disabled',
        capability: 'machine_credentials',
      });
      nothingIssued();
    });

    it('answers 503 with Retry-After when the switch cannot be read, and writes nothing', async () => {
      capability.mockResolvedValue('unknown');
      const res = await request(method, path, body);
      expect(res.status).toBe(503);
      expect(res.headers.get('Retry-After')).toBeTruthy();
      expect(await res.json()).toMatchObject({ error: 'temporarily_unavailable' });
      nothingIssued();
    });
  });

  it('refuses nothing for a caller without the write permission before the capability (own refusal)', async () => {
    capability.mockResolvedValue('off');
    const res = await request('POST', '/principals', {}, { permissions: 'x', scope: 'tenant-a' });
    expect(res.status).toBe(403);
    expect(await res.json()).not.toMatchObject({ error: 'capability_disabled' });
  });

  it('creates a principal while on', async () => {
    mockRepo.createPrincipalWithGrant.mockResolvedValue(PRINCIPAL);
    mockRepo.findPrincipalById.mockResolvedValue(PRINCIPAL);
    const res = await request('POST', '/principals', ISSUING[0][3], {
      permissions: `admin:machine_access:read,admin:machine_access:write,admin:agent_grants:*`,
      scope: '*',
    });
    expect(res.status).toBe(201);
    expect(mockRepo.createPrincipalWithGrant).toHaveBeenCalledOnce();
  });

  it('lets a caller with global platform authority issue while off', async () => {
    capability.mockResolvedValue('off');
    mockRepo.createPrincipalWithGrant.mockResolvedValue(PRINCIPAL);
    mockRepo.findPrincipalById.mockResolvedValue(PRINCIPAL);
    const res = await request('POST', '/principals', ISSUING[0][3], {
      permissions: PLATFORM_ADMIN,
      scope: '*',
    });
    expect(res.status).toBe(201);
    expect(mockRepo.createPrincipalWithGrant).toHaveBeenCalledOnce();
  });

  describe('while off, what narrows or only describes stays possible', () => {
    beforeEach(() => capability.mockResolvedValue('off'));

    it('lists and reads', async () => {
      mockRepo.listPrincipals.mockResolvedValue([]);
      expect((await request('GET', '/principals')).status).toBe(200);
      expect((await request('GET', '/principals/amp_1')).status).toBe(200);
    });

    it('renames a principal (no change of permissions or tenants)', async () => {
      mockRepo.updatePrincipalWithGrant.mockResolvedValue(PRINCIPAL);
      mockRepo.findPrincipalById.mockResolvedValue(PRINCIPAL);
      const res = await request('PATCH', '/principals/amp_1', { display_name: 'Renamed' });
      expect(res.status).toBe(200);
      expect(mockRepo.updatePrincipalWithGrant).toHaveBeenCalledOnce();
    });

    it('renames a credential and revokes one through PATCH', async () => {
      mockRepo.updateCredentialWithGrant.mockResolvedValue(CREDENTIAL);
      mockRepo.updateCredential.mockResolvedValue({ ...CREDENTIAL, status: 'revoked' });
      const rename = await request('PATCH', '/principals/amp_1/credentials/amk_1', {
        display_name: 'Renamed',
      });
      expect(rename.status).toBe(200);
      const revoke = await request('PATCH', '/principals/amp_1/credentials/amk_1', {
        status: 'revoked',
      });
      expect(revoke.status).toBe(200);
    });

    it('disables a principal, emergency-revokes a credential, deletes both', async () => {
      mockRepo.findPrincipalById.mockResolvedValue(PRINCIPAL);
      mockRepo.updatePrincipal.mockResolvedValue({ ...PRINCIPAL, status: 'disabled' });
      mockRepo.updateCredential.mockResolvedValue({ ...CREDENTIAL, status: 'revoked' });
      mockRepo.deleteCredential.mockResolvedValue(true);
      mockRepo.deletePrincipal.mockResolvedValue(true);
      const everything = await Promise.all([
        request('POST', '/principals/amp_1/disable', { reason: 'incident' }),
        request('POST', '/principals/amp_1/credentials/amk_1/emergency-revoke', {}),
        request('DELETE', '/principals/amp_1/credentials/amk_1'),
        request('DELETE', '/principals/amp_1'),
      ]);
      expect(everything.map((res) => res.status)).toEqual([200, 200, 200, 200]);
    });
  });
});
