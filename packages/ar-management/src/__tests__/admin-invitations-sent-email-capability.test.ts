/**
 * The admin_sent_email capability on admin invitations: while it is off, an invitation delivered by
 * e-mail (create and resend) is refused before anything is written or queued, and an invitation
 * whose code is handed back in the response (no e-mail) keeps working.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core';

const { adapter, notifier, repo, audit, gate, capability } = vi.hoisted(() => ({
  gate: vi.fn(async (): Promise<Response | null> => null),
  capability: vi.fn<() => Promise<'on' | 'off' | 'unknown'>>(),
  adapter: {
    query: vi.fn(),
    queryOne: vi.fn(),
    execute: vi.fn<(sql: string, params?: unknown[]) => Promise<{ rowsAffected: number }>>(),
    batch:
      vi.fn<
        (
          statements: Array<{ sql: string; params?: unknown[] }>
        ) => Promise<Array<{ rowsAffected: number }>>
      >(),
  },
  notifier: { send: vi.fn<(input: { body: string }) => Promise<{ success: boolean }>>() },
  repo: { findByEmail: vi.fn(), getRole: vi.fn(), effective: vi.fn() },
  audit: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getTenantCapabilityState: capability,
    requireDedicatedAdminDatabaseAdapter: vi.fn(() => adapter),
    // The code handoff switch is on.
    resolvePlatformSettingsWithSources: vi.fn(async () => ({
      values: { 'admin_invitations.code_handoff_enabled': true },
    })),
    AdminUserRepository: class {
      findByEmail = repo.findByEmail;
    },
    AdminRoleRepository: class {
      getRole = repo.getRole;
      getEffectivePermissions = repo.effective;
    },
    produceNotificationDelivery: vi.fn(
      async (_env: unknown, input: { payload: { body: string } }) => {
        await notifier.send(input.payload);
        return { delivery: 'delivered' };
      }
    ),
    adminAuthMiddleware:
      () =>
      async (
        c: {
          req: { header: (name: string) => string | undefined };
          set: (key: string, value: unknown) => void;
        },
        next: () => Promise<void>
      ) => {
        const list = (name: string) => (c.req.header(name) ?? '').split(',').filter(Boolean);
        c.set('adminAuth', {
          userId: 'actor_1',
          authMethod: c.req.header('x-test-auth-method') ?? 'session',
          permissions: list('x-test-permissions'),
          globalPermissions: list('x-test-global-permissions'),
          tenantScope: list('x-test-tenant-scope'),
          roles: ['admin'],
          hierarchyLevel: Number(c.req.header('x-test-hierarchy-level') ?? '100'),
        });
        c.set('tenantId', 'tenant_123');
        await next();
      },
    getTenantIdFromContext: vi.fn((c: { get: (key: string) => unknown }) => c.get('tenantId')),
  };
});
vi.mock('../admin-shared', () => ({ writeAdminAuditLog: audit }));
vi.mock('../admin-step-up-gate', () => ({ requireAdminStepUp: gate }));

import { ADMIN_PERMISSIONS } from '@authrim/ar-lib-core';
import { adminInvitationsRouter } from '../routes/admin-management/admin-invitations';

const HANDOFF = ADMIN_PERMISSIONS.ADMIN_INVITATION_CODE_HANDOFF;
const WRITE = [
  ADMIN_PERMISSIONS.ADMIN_USERS_READ,
  ADMIN_PERMISSIONS.ADMIN_USERS_WRITE,
  ADMIN_PERMISSIONS.ADMIN_ROLES_WRITE,
];
/** A tenant admin: writes invitations, by session, with no global authority. */
const TENANT_ADMIN_HEADERS = {
  'x-test-permissions': WRITE.join(','),
  'x-test-tenant-scope': 'tenant_123',
  'x-test-hierarchy-level': '100',
};
/** A global machine holding the handoff permission (a provisioning portal). */
const PORTAL_HEADERS = {
  'x-test-auth-method': 'machine_access_token',
  'x-test-permissions': [...WRITE, HANDOFF].join(','),
  'x-test-global-permissions': [...WRITE, HANDOFF].join(','),
  'x-test-tenant-scope': '*',
  'x-test-hierarchy-level': '0',
};
/** A human with the global wildcard: platform authority. */
const PLATFORM_HEADERS = {
  'x-test-permissions': ['*', ...WRITE].join(','),
  'x-test-global-permissions': '*',
  'x-test-tenant-scope': '*',
  'x-test-hierarchy-level': '100',
};

const ROLE = {
  id: 'role_ar_tenant_admin',
  tenant_id: 'tenant_123',
  name: 'ar_tenant_admin',
  display_name: 'Administrator',
  hierarchy_level: 10,
  is_system: false,
  permissions: ['admin:users:read'],
};
const PENDING_EMAIL_INVITATION = {
  id: 'invitation_1',
  tenant_id: 'tenant_123',
  email: 'admin@example.com',
  name: null,
  code_hash: 'previous-code-hash',
  code_delivery: 'email',
  status: 'pending',
  admin_role_id: ROLE.id,
  role_name: ROLE.name,
  role_display_name: ROLE.display_name,
  scope_type: 'tenant',
  scope_id: 'tenant_123',
  role_expires_at: null,
  ip_restriction_enabled: 0,
  allowed_ip_ranges_json: '[]',
  expires_at: Date.now() + 60_000,
  last_sent_at: Date.now(),
  last_delivery_status: 'sent',
  accepted_at: null,
  created_by: 'actor_1',
  created_at: Date.now(),
  updated_at: Date.now(),
};

const ENV = {
  DB_ADMIN: {},
  DEFAULT_TENANT_ID: 'tenant_123',
  ADMIN_UI_URL: 'https://admin.example.com',
} as unknown as Env;

function send(method: string, path: string, headers: Record<string, string>, body?: unknown) {
  const app = new Hono<{ Bindings: Env }>();
  app.route('/api/admin/admin-invitations', adminInvitationsRouter);
  return app.request(
    `/api/admin/admin-invitations${path}`,
    {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    ENV
  );
}

const emailBody = (extra: Record<string, unknown> = {}) => ({
  email: 'new.admin@example.com',
  role_id: ROLE.id,
  ...extra,
});
const handoffBody = () => emailBody({ code_delivery: 'response' });

function nothingWrittenOrSent() {
  expect(adapter.execute).not.toHaveBeenCalled();
  expect(adapter.batch).not.toHaveBeenCalled();
  expect(notifier.send).not.toHaveBeenCalled();
  expect(gate).not.toHaveBeenCalled();
  expect(audit).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  gate.mockReset();
  gate.mockResolvedValue(null);
  capability.mockResolvedValue('on');
  repo.findByEmail.mockResolvedValue(null);
  repo.getRole.mockResolvedValue(ROLE);
  repo.effective.mockResolvedValue(ROLE.permissions);
  adapter.queryOne.mockResolvedValue(null);
  adapter.query.mockResolvedValue([]);
  adapter.execute.mockResolvedValue({ rowsAffected: 1 });
  adapter.batch.mockResolvedValue([{ rowsAffected: 1 }, { rowsAffected: 0 }]);
  notifier.send.mockResolvedValue({ success: true });
  audit.mockResolvedValue(undefined);
});

describe('creating an admin invitation while admin_sent_email is off', () => {
  it('refuses an invitation delivered by e-mail (the default) with 403 capability_disabled, writing and sending nothing', async () => {
    capability.mockResolvedValue('off');
    for (const body of [emailBody(), emailBody({ code_delivery: 'email' })]) {
      const response = await send('POST', '', TENANT_ADMIN_HEADERS, body);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        error: 'capability_disabled',
        capability: 'admin_sent_email',
      });
    }
    nothingWrittenOrSent();
  });

  it('answers 503 with Retry-After when the switch cannot be read, writing and sending nothing', async () => {
    capability.mockResolvedValue('unknown');
    const response = await send('POST', '', TENANT_ADMIN_HEADERS, emailBody());
    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBeTruthy();
    expect(await response.json()).toMatchObject({ error: 'temporarily_unavailable' });
    nothingWrittenOrSent();
  });

  it('still creates an invitation whose code is handed over in the response, and sends no e-mail', async () => {
    capability.mockResolvedValue('off');
    const response = await send('POST', '', PORTAL_HEADERS, handoffBody());
    const body = await response.json<Record<string, unknown>>();
    expect(response.status).toBe(201);
    expect(body).toMatchObject({ email_sent: false, code_delivery: 'response' });
    expect(typeof body.code).toBe('string');
    expect(notifier.send).not.toHaveBeenCalled();
    expect(
      adapter.execute.mock.calls.some(([sql]) => sql.includes('INSERT INTO admin_invitations'))
    ).toBe(true);
  });

  it('sends the e-mail while on', async () => {
    const response = await send('POST', '', TENANT_ADMIN_HEADERS, emailBody());
    expect(response.status).toBe(201);
    expect(notifier.send).toHaveBeenCalledOnce();
  });

  it('lets a caller with global platform authority send while off', async () => {
    capability.mockResolvedValue('off');
    const response = await send('POST', '', PLATFORM_HEADERS, emailBody());
    expect(response.status).toBe(201);
    expect(notifier.send).toHaveBeenCalledOnce();
  });
});

describe('resending an admin invitation while admin_sent_email is off', () => {
  it('refuses the e-mail resend with 403 capability_disabled, changing and sending nothing', async () => {
    capability.mockResolvedValue('off');
    adapter.queryOne.mockResolvedValue(PENDING_EMAIL_INVITATION);
    const response = await send('POST', '/invitation_1/resend', TENANT_ADMIN_HEADERS);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: 'capability_disabled',
      capability: 'admin_sent_email',
    });
    nothingWrittenOrSent();
  });

  it('answers 503 with Retry-After when the switch cannot be read', async () => {
    capability.mockResolvedValue('unknown');
    adapter.queryOne.mockResolvedValue(PENDING_EMAIL_INVITATION);
    const response = await send('POST', '/invitation_1/resend', TENANT_ADMIN_HEADERS);
    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBeTruthy();
    nothingWrittenOrSent();
  });

  it('resends by e-mail while on', async () => {
    adapter.queryOne.mockResolvedValue(PENDING_EMAIL_INVITATION);
    const response = await send('POST', '/invitation_1/resend', TENANT_ADMIN_HEADERS);
    expect(response.status).toBe(200);
    expect(notifier.send).toHaveBeenCalledOnce();
  });

  it('lets a caller with global platform authority resend while off', async () => {
    capability.mockResolvedValue('off');
    adapter.queryOne.mockResolvedValue(PENDING_EMAIL_INVITATION);
    const response = await send('POST', '/invitation_1/resend', PLATFORM_HEADERS);
    expect(response.status).toBe(200);
    expect(notifier.send).toHaveBeenCalledOnce();
  });

  it('still resends a handoff invitation (a new code in the response, no e-mail) while off', async () => {
    capability.mockResolvedValue('off');
    adapter.queryOne.mockResolvedValue({
      ...PENDING_EMAIL_INVITATION,
      code_delivery: 'response',
    });
    const response = await send('POST', '/invitation_1/resend', PORTAL_HEADERS, {
      code_delivery: 'response',
    });
    expect(response.status).toBe(200);
    expect(notifier.send).not.toHaveBeenCalled();
  });
});
