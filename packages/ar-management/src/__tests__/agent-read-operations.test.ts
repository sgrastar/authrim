import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { ADMIN_PERMISSIONS, type AdminAuthContext, type Env } from '@authrim/ar-lib-core';

const mocks = vi.hoisted(() => ({
  auth: {
    userId: 'admin-1',
    actorType: 'agent',
    authMethod: 'bearer',
    tenantId: 'tenant-1',
    roles: [],
    permissions: ['*'],
  } as AdminAuthContext,
  usersList: vi.fn(),
  userGet: vi.fn(),
  clientsList: vi.fn(),
  clientGet: vi.fn(),
  auditList: vi.fn(),
  coreQueryOne: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    adminAuthMiddleware: () => async (c: any, next: () => Promise<void>) => {
      c.set('adminAuth', mocks.auth);
      await next();
    },
    createAuthContextFromHono: () => ({
      coreAdapter: { queryOne: mocks.coreQueryOne },
    }),
  };
});

vi.mock('../admin-users', () => ({
  adminUsersListHandler: mocks.usersList,
  adminUserGetHandler: mocks.userGet,
}));
vi.mock('../admin-clients', () => ({
  adminClientsListHandler: mocks.clientsList,
  adminClientGetHandler: mocks.clientGet,
}));
vi.mock('../routes/admin-management/admin-audit', () => ({ listAdminAuditLogs: mocks.auditList }));

import { agentReadOperationsRouter } from '../routes/admin-management/agent-read-operations';

function json(body: unknown, status = 200) {
  return Response.json(body, { status });
}

function app() {
  const result = new Hono<{ Bindings: Env }>();
  result.route('/api/admin/agent-read', agentReadOperationsRouter as never);
  return result;
}

describe('Agent-safe Management read operations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth = {
      userId: 'admin-1',
      actorType: 'agent',
      authMethod: 'bearer',
      tenantId: 'tenant-1',
      roles: [],
      permissions: ['*'],
    };
  });

  it('masks user PII and never returns credential or custom-field values', async () => {
    mocks.userGet.mockResolvedValue(
      json({
        user: {
          id: 'user-1',
          tenant_id: 'tenant-1',
          email: 'alice@example.com',
          name: 'Alice Admin',
          phone_number: '+819012345678',
          status: 'active',
        },
        passkeys: [{ credential_id: 'credential-secret', device_name: 'Alice laptop' }],
        totp_credentials: [{ id: 'totp-1', label: 'private label' }],
        customFields: [{ field_name: 'employee_secret', field_value: 'classified' }],
        missing_required_fields: [{ field_key: 'department', label: 'Department' }],
      })
    );
    const response = await app().request(
      '/api/admin/agent-read/users/user-1',
      undefined,
      {} as Env
    );
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain('a***@example.com');
    expect(text).not.toContain('alice@example.com');
    expect(text).not.toContain('credential-secret');
    expect(text).not.toContain('classified');
    expect(JSON.parse(text)).toMatchObject({
      authentication_factors: { passkey_count: 1, totp_count: 1 },
    });
  });

  it('rejects a cross-tenant owner response instead of disclosing it', async () => {
    mocks.clientGet.mockResolvedValue(
      json({
        client: { client_id: 'client-1', tenant_id: 'tenant-2', client_secret_hash: 'secret' },
      })
    );
    const response = await app().request(
      '/api/admin/agent-read/clients/client-1',
      undefined,
      {} as Env
    );
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain('secret');
  });

  it('passes a percent-encoded HTTPS CIMD client ID to the owner handler intact', async () => {
    const clientId = 'https://claude.ai/oauth/claude-code-client-metadata';
    mocks.clientGet.mockImplementation(async (context) => {
      expect(context.req.param('id')).toBe(clientId);
      return json({
        client: {
          client_id: clientId,
          tenant_id: 'tenant-1',
          client_name: 'Claude Code',
          updated_at: 100,
        },
      });
    });
    const response = await app().request(
      `/api/admin/agent-read/clients/${encodeURIComponent(clientId)}`,
      undefined,
      {} as Env
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ client: { client_id: clientId } });
  });

  it('removes contact PII and secret fields from client lists', async () => {
    mocks.clientsList.mockResolvedValue(
      json({
        clients: [
          {
            client_id: 'client-1',
            tenant_id: 'tenant-1',
            client_name: 'Example',
            contacts: ['owner@example.com'],
            client_secret_hash: 'hash-secret',
            redirect_uris: ['https://example.com/callback'],
          },
        ],
        pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
      })
    );
    const response = await app().request('/api/admin/agent-read/clients', undefined, {} as Env);
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).toContain('client-1');
    expect(text).not.toContain('owner@example.com');
    expect(text).not.toContain('hash-secret');
  });

  it('allowlists audit fields and omits detail metadata and Admin email', async () => {
    mocks.auditList.mockResolvedValue(
      json({
        items: [
          {
            id: 'audit-1',
            action: 'client.updated',
            resource_id: 'user-stable-id',
            actor_id: 'admin-stable-id',
            admin_email: 'admin@example.com',
            actor_display_name: 'Alice Admin',
            metadata: { token: 'raw-token' },
            before: { secret: 'old-secret' },
          },
        ],
        page: 1,
        limit: 20,
        total: 1,
      })
    );
    const response = await app().request(
      '/api/admin/agent-read/admin-audit-log',
      undefined,
      {} as Env
    );
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).not.toContain('admin@example.com');
    expect(text).not.toContain('user-stable-id');
    expect(text).not.toContain('admin-stable-id');
    expect(text).not.toContain('raw-token');
    expect(text).not.toContain('old-secret');
  });

  it('computes session posture in Core DB without loading identifying session fields', async () => {
    mocks.coreQueryOne.mockResolvedValue({
      total_sessions: 3,
      active_sessions: 2,
      expired_sessions: 1,
      oldest_created_at: 1_750_000_000,
      newest_last_accessed_at: 1_750_000_100,
      next_expiration_at: 1_750_000_200,
      latest_expiration_at: 1_750_000_300,
    });

    const response = await app().request(
      '/api/admin/agent-read/session-posture',
      undefined,
      {} as Env
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toMatchObject({
      snapshot: { total_sessions: 3, active_sessions: 2, expired_sessions: 1 },
    });
    const [sql, params] = mocks.coreQueryOne.mock.calls[0] as [string, unknown[]];
    expect(sql).not.toMatch(/(?:user_id|email|ip_address|user_agent|SELECT \*)/u);
    expect(params.at(-1)).toBe('tenant-1');
  });

  it('fails closed when aggregate session counts are inconsistent', async () => {
    mocks.coreQueryOne.mockResolvedValue({
      total_sessions: 2,
      active_sessions: 2,
      expired_sessions: 1,
      oldest_created_at: null,
      newest_last_accessed_at: null,
      next_expiration_at: null,
      latest_expiration_at: null,
    });
    const response = await app().request(
      '/api/admin/agent-read/session-posture',
      undefined,
      {} as Env
    );
    expect(response.status).toBe(502);
  });

  it('rejects unknown query fields before invoking owner APIs', async () => {
    const response = await app().request(
      '/api/admin/agent-read/users?sql=select',
      undefined,
      {} as Env
    );
    expect(response.status).toBe(400);
    expect(mocks.usersList).not.toHaveBeenCalled();
  });

  it('requires the underlying Admin read permission even on the internal route', async () => {
    mocks.auth = { ...mocks.auth, permissions: [ADMIN_PERMISSIONS.CLIENTS_READ] };
    const response = await app().request('/api/admin/agent-read/users', undefined, {} as Env);
    expect(response.status).toBe(403);
  });
});
