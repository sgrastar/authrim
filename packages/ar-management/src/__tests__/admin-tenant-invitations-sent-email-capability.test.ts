/**
 * The admin_sent_email capability on sign-up invitations: while it is off, an invitation addressed
 * to an e-mail address (which is mailed) is refused before anything is stored or queued, and an
 * invitation without an address (nothing is mailed) is still created.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const mocks = vi.hoisted(() => ({
  queryOne: vi.fn(),
  query: vi.fn(),
  execute: vi.fn(),
  audit: vi.fn(),
  sendEmail: vi.fn(),
  capability: vi.fn<() => Promise<'on' | 'off' | 'unknown'>>(),
  prepareAlias: vi.fn(async () => undefined),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getTenantCapabilityState: mocks.capability,
    createAuthContextFromHono: () => ({
      coreAdapter: { queryOne: mocks.queryOne, query: mocks.query, execute: mocks.execute },
    }),
    createAuditLogFromContext: mocks.audit,
    produceNotificationDelivery: vi.fn(
      async (_env: unknown, input: { payload: unknown; intentId: string }) => {
        await mocks.sendEmail(input.payload);
        return { reference: { intentId: input.intentId }, delivery: 'delivered' };
      }
    ),
    getLogger: () => ({ module: () => ({ warn: vi.fn(), error: vi.fn() }) }),
  };
});
vi.mock('../single-tenant-guard', () => ({ ensureSupportedTenantId: vi.fn(async () => null) }));
vi.mock('../admin-tenant-access', () => ({
  requireTenantResourceAccess: vi.fn(async () => null),
  getAdminAuth: (c: { get: (key: string) => unknown }) => c.get('adminAuth'),
}));
vi.mock('../request-issuer', () => ({
  getCanonicalTenantBaseUrl: (_env: unknown, tenantId: string) =>
    `https://${tenantId}.example.test`,
}));
vi.mock('../tenant-alias-directory', () => ({
  resolveTenantDiscoveryAliasDirectoryInput: vi.fn(async (_env: unknown, input: object) => ({
    ...input,
    routeProjection: {},
  })),
  prepareTenantDiscoveryAliasDirectory: mocks.prepareAlias,
  activateTenantDiscoveryAliasDirectory: vi.fn(async () => undefined),
  ensureActiveTenantDiscoveryAliasDirectory: vi.fn(async () => undefined),
  disableTenantDiscoveryAliasDirectory: vi.fn(async () => undefined),
}));

import { createTenantInvitationHandler } from '../admin-tenant-invitations';

const TENANT_ADMIN = { adminId: 'admin-actor', hierarchyLevel: 80 };
const PLATFORM_ADMIN = {
  adminId: 'platform-actor',
  hierarchyLevel: 0,
  permissions: ['*'],
  globalPermissions: ['*'],
  tenantScope: ['*'],
};

function post(body: unknown, adminAuth: Record<string, unknown> = TENANT_ADMIN) {
  const instance = new Hono();
  instance.use('*', async (c, next) => {
    c.set('adminAuth' as never, adminAuth as never);
    await next();
  });
  instance.post('/tenants/:id/invitations', createTenantInvitationHandler as never);
  return instance.request(
    '/tenants/tenant-a/invitations',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    { EMAIL_FROM: 'noreply@example.test' }
  );
}

function nothingStoredOrSent() {
  expect(mocks.execute).not.toHaveBeenCalled();
  expect(mocks.prepareAlias).not.toHaveBeenCalled();
  expect(mocks.sendEmail).not.toHaveBeenCalled();
  expect(mocks.audit).not.toHaveBeenCalled();
}

describe('tenant sign-up invitations and the admin_sent_email capability', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.capability.mockResolvedValue('on');
    mocks.execute.mockResolvedValue({ rowsAffected: 1 });
    mocks.sendEmail.mockResolvedValue({ success: true });
    mocks.queryOne.mockImplementation(async (sql: string) =>
      sql.includes('FROM tenants') ? { id: 'tenant-a', name: 'Tenant A' } : null
    );
  });

  it('refuses an invitation addressed to an e-mail address while off, storing and sending nothing', async () => {
    mocks.capability.mockResolvedValue('off');
    const response = await post({ invited_email: 'user@example.test' });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: 'capability_disabled',
      capability: 'admin_sent_email',
    });
    nothingStoredOrSent();
  });

  it('answers 503 with Retry-After when the switch cannot be read, storing and sending nothing', async () => {
    mocks.capability.mockResolvedValue('unknown');
    const response = await post({ invited_email: 'user@example.test' });
    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBeTruthy();
    nothingStoredOrSent();
  });

  it('still creates an invitation with no address while off (nothing is mailed)', async () => {
    mocks.capability.mockResolvedValue('off');
    const response = await post({});
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ email_sent: false });
    expect(mocks.execute).toHaveBeenCalledOnce();
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it('mails the invitation while on', async () => {
    const response = await post({ invited_email: 'user@example.test' });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ email_sent: true });
    expect(mocks.sendEmail).toHaveBeenCalledOnce();
  });

  it('lets a caller with global platform authority mail while off', async () => {
    mocks.capability.mockResolvedValue('off');
    const response = await post({ invited_email: 'user@example.test' }, PLATFORM_ADMIN);
    expect(response.status).toBe(201);
    expect(mocks.sendEmail).toHaveBeenCalledOnce();
  });
});
