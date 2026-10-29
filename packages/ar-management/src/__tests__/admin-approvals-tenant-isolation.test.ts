import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import {
  ApprovalRequestApprovalRepository,
  ApprovalRequestRepository,
  ElevationGrantRepository,
  canonicalizeApprovalScope,
  type DatabaseAdapter,
  type Env,
} from '@authrim/ar-lib-core';
import { adminApprovalsRouter } from '../routes/admin-management/admin-approvals';
import { openAdminDatabase, sqliteAdapter } from './helpers/admin-authority-fixture';
import type { SQLiteDatabase } from './test-sqlite';

/**
 * An approval request belongs to one tenant. The Admin of another tenant must not be able to read,
 * decide, cancel, or revoke a grant of it by naming its public ID: these run the real approvals
 * router and the real admin-auth middleware on the real Admin schema, with two tenants in it.
 */

const APPROVER_PERMISSIONS = [
  'admin:approvals:read',
  'admin:approvals:detail:read',
  'admin:approvals:write',
  'admin:approvals:approve',
  'admin:approvals:grant:issue',
];

interface ResponseJson {
  status?: string;
  error?: string;
  raw?: string;
  requester_subject_id?: string;
  expires_at?: number;
  approvals?: Array<{ expires_at: number }>;
}

let counter = 0;

function signInTo(db: SQLiteDatabase, tenantId: string): { userId: string; cookie: string } {
  counter += 1;
  const userId = `admin-${tenantId}-${counter}`;
  const sessionId = `session-${tenantId}-${counter}`;
  const roleId = `role-approver-${tenantId}-${counter}`;
  const now = Date.now();
  db.prepare(
    `INSERT INTO admin_users (id, tenant_id, email, is_active, status, created_at, updated_at)
     VALUES (?, ?, ?, 1, 'active', ?, ?)`
  ).run(userId, tenantId, `${userId}@example.test`, now, now);
  db.prepare(
    `INSERT INTO admin_sessions (id, tenant_id, admin_user_id, created_at, expires_at, mfa_verified)
     VALUES (?, ?, ?, ?, ?, 0)`
  ).run(sessionId, tenantId, userId, now, now + 3_600_000);
  db.prepare(
    `INSERT INTO admin_roles (id, tenant_id, name, permissions_json, hierarchy_level, role_type, is_system, inherits_from, created_at, updated_at)
     VALUES (?, ?, ?, ?, 50, 'custom', 0, NULL, ?, ?)`
  ).run(roleId, tenantId, `approver_${counter}`, JSON.stringify(APPROVER_PERMISSIONS), now, now);
  db.prepare(
    `INSERT INTO admin_role_assignments (id, tenant_id, admin_user_id, admin_role_id, scope_type, scope_id, created_at)
     VALUES (?, ?, ?, ?, 'tenant', ?, ?)`
  ).run(`${userId}-assignment`, tenantId, userId, roleId, tenantId, now);
  // Signing in takes one of the standard roles; the custom role above carries the approvals.
  db.prepare(
    `INSERT INTO admin_role_assignments (id, tenant_id, admin_user_id, admin_role_id, scope_type, scope_id, created_at)
     VALUES (?, ?, ?, 'role_viewer', 'tenant', ?, ?)`
  ).run(`${userId}-viewer`, tenantId, userId, tenantId, now);
  return { userId, cookie: `authrim_admin_session=${sessionId}` };
}

async function seedRequest(adapter: DatabaseAdapter, tenantId: string, requester: string) {
  const requests = new ApprovalRequestRepository(adapter);
  const approvals = new ApprovalRequestApprovalRepository(adapter);
  const grants = new ElevationGrantRepository(adapter);
  const scope = canonicalizeApprovalScope({
    version: 1,
    surface: 'admin_audit',
    action: 'detail_read',
    tenant_id: tenantId,
    resource_class: 'admin_audit_detail',
    resource_ids: ['log-1'],
    detail_classes: ['before_after_metadata'],
    investigation_id: `inv_${tenantId}`,
    redaction_level: 'masked',
  });
  const request = await requests.createApprovalRequest({
    tenant_id: tenantId,
    investigation_id: `inv_${tenantId}`,
    requester_subject_type: 'admin_user',
    requester_subject_id: requester,
    target_subject_type: 'tenant_resource',
    target_subject_id: 'log-1',
    request_surface: 'admin_audit',
    requested_action: 'detail_read',
    redaction_level: 'masked',
    scope_json: scope.normalized,
    scope_canonical: scope.canonical,
    reason_code: 'support_case',
    policy_preset: 'support_case_default',
    expires_at: Date.now() + 15 * 60_000,
  });
  const approval = await approvals.createApproval({
    approval_request_id: request.id,
    step_key: 'operator-1',
    side: 'admin_operator',
    subject_type: 'admin_user',
    subject_id: null,
    expires_at: request.expires_at,
  });
  const grant = await grants.createElevationGrant({
    approval_request_id: request.id,
    tenant_id: tenantId,
    target_audience: 'admin_api',
    resource_class: 'admin_audit_detail',
    redaction_level: 'masked',
    scope_json: scope.normalized,
    scope_canonical: scope.canonical,
    requester_subject_type: 'admin_user',
    requester_subject_id: requester,
    actor_subject_type: 'admin_user',
    actor_subject_id: requester,
    expires_at: request.expires_at,
  });
  return { request, approval, grant };
}

function setup() {
  const db = openAdminDatabase();
  const adapter = sqliteAdapter(db);
  const app = new Hono<{ Bindings: Env }>();
  app.use('*', async (c, next) => {
    (c as unknown as { set(key: string, value: unknown): void }).set(
      'tenantId',
      c.req.header('X-Tenant-Id') ?? 'tenant-a'
    );
    await next();
  });
  app.route('/api/admin/approvals', adminApprovalsRouter);
  const call = async (
    cookie: string,
    tenantId: string,
    method: string,
    path: string,
    body: unknown = {}
  ) => {
    const response = await app.request(
      `/api/admin/approvals${path}`,
      {
        method,
        headers: { 'content-type': 'application/json', 'X-Tenant-Id': tenantId, Cookie: cookie },
        ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
      },
      { DB_ADMIN: adapter } as unknown as Env
    );
    const text = await response.text();
    let json: ResponseJson = {};
    try {
      json = JSON.parse(text) as ResponseJson;
    } catch {
      json = { raw: text };
    }
    return { status: response.status, json };
  };
  return { db, adapter, call };
}

describe('approval requests are scoped to their tenant', () => {
  it('lets the Admin of the tenant decide its own request (control)', async () => {
    const { db, adapter, call } = setup();
    const requester = signInTo(db, 'tenant-b');
    const approver = signInTo(db, 'tenant-b');
    const seeded = await seedRequest(adapter, 'tenant-b', requester.userId);

    const res = await call(
      approver.cookie,
      'tenant-b',
      'POST',
      `/${seeded.request.public_request_id}/steps/${seeded.approval.id}/approve`
    );

    expect(res.status).toBe(200);
    expect(res.json.status).toBe('approved');
  });

  const crossTenantCalls: Array<{
    name: string;
    method: string;
    path: (s: Awaited<ReturnType<typeof seedRequest>>) => string;
    body?: unknown;
  }> = [
    { name: 'read', method: 'GET', path: (s) => `/${s.request.public_request_id}` },
    {
      name: 'approve',
      method: 'POST',
      path: (s) => `/${s.request.public_request_id}/steps/${s.approval.id}/approve`,
    },
    {
      name: 'deny',
      method: 'POST',
      path: (s) => `/${s.request.public_request_id}/steps/${s.approval.id}/deny`,
    },
    { name: 'cancel', method: 'POST', path: (s) => `/${s.request.public_request_id}/cancel` },
    {
      name: 'revoke a grant',
      method: 'POST',
      path: (s) => `/${s.request.public_request_id}/grants/${s.grant.public_grant_id}/revoke`,
    },
    {
      name: 'issue a subject token',
      method: 'POST',
      path: (s) =>
        `/${s.request.public_request_id}/grants/${s.grant.public_grant_id}/subject-token`,
      body: { client_id: 'client-1' },
    },
    {
      name: 'issue an approval artifact',
      method: 'POST',
      path: (s) => `/${s.request.public_request_id}/steps/${s.approval.id}/artifacts`,
    },
    {
      name: 'read the step guide',
      method: 'GET',
      path: (s) => `/${s.request.public_request_id}/steps/${s.approval.id}/guide`,
    },
    {
      name: 'remind',
      method: 'POST',
      path: (s) => `/${s.request.public_request_id}/steps/${s.approval.id}/remind`,
    },
    {
      name: 'resend',
      method: 'POST',
      path: (s) => `/${s.request.public_request_id}/steps/${s.approval.id}/resend`,
    },
    {
      name: 'read the evidence',
      method: 'GET',
      path: (s) => `/${s.request.public_request_id}/evidence`,
    },
    {
      name: 'read the receipts',
      method: 'GET',
      path: (s) => `/${s.request.public_request_id}/receipts`,
    },
  ];

  it.each(crossTenantCalls)(
    'answers 404 when the Admin of another tenant tries to $name',
    async ({ method, path, body }) => {
      const { db, adapter, call } = setup();
      const requester = signInTo(db, 'tenant-b');
      const outsider = signInTo(db, 'tenant-a');
      const seeded = await seedRequest(adapter, 'tenant-b', requester.userId);

      const res = await call(outsider.cookie, 'tenant-a', method, path(seeded), body);

      expect(res.status).toBe(404);
    }
  );

  it('leaves the request and its grant untouched after a cross-tenant decision', async () => {
    const { db, adapter, call } = setup();
    const requester = signInTo(db, 'tenant-b');
    const outsider = signInTo(db, 'tenant-a');
    const seeded = await seedRequest(adapter, 'tenant-b', requester.userId);

    await call(
      outsider.cookie,
      'tenant-a',
      'POST',
      `/${seeded.request.public_request_id}/steps/${seeded.approval.id}/approve`
    );
    await call(
      outsider.cookie,
      'tenant-a',
      'POST',
      `/${seeded.request.public_request_id}/grants/${seeded.grant.public_grant_id}/revoke`
    );

    const request = db
      .prepare('SELECT status FROM approval_requests WHERE id = ?')
      .get(seeded.request.id) as { status: string };
    const approval = db
      .prepare('SELECT status FROM approval_request_approvals WHERE id = ?')
      .get(seeded.approval.id) as { status: string };
    const grant = db
      .prepare('SELECT status, revoked_at FROM elevation_grants WHERE id = ?')
      .get(seeded.grant.id) as { status: string; revoked_at: number | null };
    expect(request.status).toBe('pending');
    expect(approval.status).toBe('pending');
    expect(grant.status).toBe('active');
    expect(grant.revoked_at).toBeNull();
  });
});
