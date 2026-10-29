import { describe, expect, it, vi } from 'vitest';
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
import {
  openAdminDatabase,
  sqliteAdapter,
  type AdapterHooks,
} from './helpers/admin-authority-fixture';
import { ApprovalRequesterError, resolveApprovalRequester } from '../approval-request-preview';
import { ApprovalWorkflowPolicyError, applyApprovalDecisionForRequest } from '../approval-workflow';
import type { SQLiteDatabase } from './test-sqlite';

// Delivering the approver's notification needs a Durable Object; what is recorded about the
// attempt is not under test here.
vi.mock('../approval-notification-dispatch', () => ({
  dispatchApprovalNotification: vi.fn(async () => ({
    success: true,
    method: 'portal_confirm',
    transportChannel: 'portal_confirm',
    summary: { provider: 'test', delivery_status: 'recorded' },
    detail: { request: {}, response: {}, metadata: {} },
  })),
}));

/**
 * How an approval request is made and decided: who the requester is, how long it stays open,
 * that a decision is made once, and that two approvers finishing it together yield one grant.
 * The real approvals router and admin-auth middleware run on the real Admin schema.
 */

const TENANT = 'tenant-a';
const PERMISSIONS = [
  'admin:approvals:read',
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

function signIn(db: SQLiteDatabase): { userId: string; cookie: string } {
  counter += 1;
  const userId = `admin-${counter}`;
  const sessionId = `session-${counter}`;
  const roleId = `role-approver-${counter}`;
  const now = Date.now();
  db.prepare(
    `INSERT INTO admin_users (id, tenant_id, email, is_active, status, created_at, updated_at)
     VALUES (?, ?, ?, 1, 'active', ?, ?)`
  ).run(userId, TENANT, `${userId}@example.test`, now, now);
  db.prepare(
    `INSERT INTO admin_sessions (id, tenant_id, admin_user_id, created_at, expires_at, mfa_verified)
     VALUES (?, ?, ?, ?, ?, 0)`
  ).run(sessionId, TENANT, userId, now, now + 3_600_000);
  db.prepare(
    `INSERT INTO admin_roles (id, tenant_id, name, permissions_json, hierarchy_level, role_type, is_system, inherits_from, created_at, updated_at)
     VALUES (?, ?, ?, ?, 50, 'custom', 0, NULL, ?, ?)`
  ).run(roleId, TENANT, `approver_${counter}`, JSON.stringify(PERMISSIONS), now, now);
  for (const [suffix, role] of [
    ['custom', roleId],
    ['viewer', 'role_viewer'],
  ] as const) {
    db.prepare(
      `INSERT INTO admin_role_assignments (id, tenant_id, admin_user_id, admin_role_id, scope_type, scope_id, created_at)
       VALUES (?, ?, ?, ?, 'tenant', ?, ?)`
    ).run(`${userId}-${suffix}`, TENANT, userId, role, TENANT, now);
  }
  return { userId, cookie: `authrim_admin_session=${sessionId}` };
}

async function seed(
  adapter: DatabaseAdapter,
  input: { requester: string; surface?: string; expiresAt?: number; steps?: number }
) {
  const requests = new ApprovalRequestRepository(adapter);
  const approvals = new ApprovalRequestApprovalRepository(adapter);
  const surface = input.surface ?? 'admin_audit';
  const scope = canonicalizeApprovalScope({
    version: 1,
    surface,
    action: 'detail_read',
    tenant_id: TENANT,
    resource_class: 'admin_audit_detail',
    resource_ids: ['log-1'],
    investigation_id: 'inv_1',
    redaction_level: 'masked',
  });
  const expiresAt = input.expiresAt ?? Date.now() + 15 * 60_000;
  const request = await requests.createApprovalRequest({
    tenant_id: TENANT,
    investigation_id: 'inv_1',
    requester_subject_type: 'admin_user',
    requester_subject_id: input.requester,
    target_subject_type: 'tenant_resource',
    target_subject_id: 'log-1',
    request_surface: surface,
    requested_action: 'detail_read',
    redaction_level: 'masked',
    scope_json: scope.normalized,
    scope_canonical: scope.canonical,
    reason_code: 'support_case',
    policy_preset: 'support_case_default',
    expires_at: expiresAt,
  });
  const steps = [];
  for (let index = 0; index < (input.steps ?? 1); index += 1) {
    steps.push(
      await approvals.createApproval({
        approval_request_id: request.id,
        step_key: `operator-${index + 1}`,
        side: 'admin_operator',
        subject_type: 'admin_user',
        subject_id: null,
        expires_at: expiresAt,
      })
    );
  }
  return { request, steps };
}

function setup() {
  const db = openAdminDatabase();
  const hooks: AdapterHooks = {};
  const adapter = sqliteAdapter(db, hooks);
  const app = new Hono<{ Bindings: Env }>();
  app.use('*', async (c, next) => {
    (c as unknown as { set(key: string, value: unknown): void }).set('tenantId', TENANT);
    await next();
  });
  app.route('/api/admin/approvals', adminApprovalsRouter);
  const call = async (cookie: string, method: string, path: string, body: unknown = {}) => {
    const response = await app.request(
      `/api/admin/approvals${path}`,
      {
        method,
        headers: { 'content-type': 'application/json', 'X-Tenant-Id': TENANT, Cookie: cookie },
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
  const grantCount = (requestId: string) =>
    (
      db
        .prepare('SELECT count(*) AS n FROM elevation_grants WHERE approval_request_id = ?')
        .get(requestId) as { n: number }
    ).n;
  return { db, adapter, call, grantCount, hooks };
}

const createBody = (extra: Record<string, unknown> = {}) => ({
  target_subject_type: 'tenant_resource',
  target_subject_id: 'log-1',
  request_surface: 'admin_audit',
  requested_action: 'detail_read',
  resource_class: 'admin_audit_detail',
  reason_code: 'support_case',
  policy_preset: 'support_case_default',
  approvals: [{ step_key: 'operator-1', side: 'admin_operator', subject_type: 'admin_user' }],
  ...extra,
});

describe('who files an approval request, and until when', () => {
  it('files the request in the name of the signed-in admin', async () => {
    const { db, call } = setup();
    const admin = signIn(db);

    const res = await call(admin.cookie, 'POST', '', createBody());

    expect(res.status).toBe(201);
    expect(res.json.requester_subject_id).toBe(admin.userId);
  });

  it('refuses a request filed in someone else’s name', async () => {
    const { db, call } = setup();
    const admin = signIn(db);
    const other = signIn(db);

    const res = await call(
      admin.cookie,
      'POST',
      '',
      createBody({ requester_subject_id: other.userId })
    );

    expect(res.status).toBe(400);
    expect(db.prepare('SELECT count(*) AS n FROM approval_requests').get()).toEqual({ n: 0 });
  });

  it('does not let the caller keep a request open longer than the policy preset', async () => {
    const { db, call } = setup();
    const admin = signIn(db);
    const yearFromNow = Date.now() + 365 * 24 * 3_600_000;

    const res = await call(admin.cookie, 'POST', '', createBody({ expires_at: yearFromNow }));

    expect(res.status).toBe(201);
    // support_case_default: 15 minutes.
    expect(res.json.expires_at).toBeLessThanOrEqual(Date.now() + 15 * 60_000);
    expect(res.json.approvals?.[0]?.expires_at).toBeLessThanOrEqual(res.json.expires_at ?? 0);
  });

  it('lets the caller ask for a shorter time', async () => {
    const { db, call } = setup();
    const admin = signIn(db);
    const soon = Date.now() + 60_000;

    const res = await call(admin.cookie, 'POST', '', createBody({ expires_at: soon }));

    expect(res.status).toBe(201);
    expect(res.json.expires_at).toBe(soon);
  });

  it('refuses a deadline that has already passed', async () => {
    const { db, call } = setup();
    const admin = signIn(db);

    const res = await call(admin.cookie, 'POST', '', createBody({ expires_at: Date.now() - 1000 }));

    expect(res.status).toBe(400);
  });
});

describe('an approval is decided once, by someone other than the requester', () => {
  it.each(['admin_audit', 'webhook_payload', 'brand_new_surface'])(
    'refuses self-approval on the %s surface',
    async (surface) => {
      const { db, adapter, call, grantCount } = setup();
      const admin = signIn(db);
      const { request, steps } = await seed(adapter, { requester: admin.userId, surface });

      const res = await call(
        admin.cookie,
        'POST',
        `/${request.public_request_id}/steps/${steps[0].id}/approve`
      );

      expect(res.status).toBe(409);
      expect(res.json.error).toBe('self_approval_not_allowed');
      expect(grantCount(request.id)).toBe(0);
    }
  );

  it('lets another admin approve, and issues one grant', async () => {
    const { db, adapter, call, grantCount } = setup();
    const requester = signIn(db);
    const approver = signIn(db);
    const { request, steps } = await seed(adapter, { requester: requester.userId });

    const res = await call(
      approver.cookie,
      'POST',
      `/${request.public_request_id}/steps/${steps[0].id}/approve`
    );

    expect(res.status).toBe(200);
    expect(res.json.status).toBe('approved');
    expect(grantCount(request.id)).toBe(1);
  });

  it('does not turn a denial into an approval', async () => {
    const { db, adapter, call, grantCount } = setup();
    const requester = signIn(db);
    const approver = signIn(db);
    const { request, steps } = await seed(adapter, { requester: requester.userId });
    const path = `/${request.public_request_id}/steps/${steps[0].id}`;

    expect((await call(approver.cookie, 'POST', `${path}/deny`)).status).toBe(200);
    const again = await call(approver.cookie, 'POST', `${path}/approve`);

    expect(again.status).toBe(409);
    expect(grantCount(request.id)).toBe(0);
    expect(
      (
        db.prepare('SELECT status FROM approval_requests WHERE id = ?').get(request.id) as {
          status: string;
        }
      ).status
    ).toBe('denied');
  });

  it('does not decide a step twice', async () => {
    const { db, adapter, call, grantCount } = setup();
    const requester = signIn(db);
    const approver = signIn(db);
    const { request, steps } = await seed(adapter, { requester: requester.userId });
    const path = `/${request.public_request_id}/steps/${steps[0].id}/approve`;

    expect((await call(approver.cookie, 'POST', path)).status).toBe(200);
    expect((await call(approver.cookie, 'POST', path)).status).toBe(409);
    expect(grantCount(request.id)).toBe(1);
  });

  it('does not approve a request past its deadline', async () => {
    const { db, adapter, call, grantCount } = setup();
    const requester = signIn(db);
    const approver = signIn(db);
    const { request, steps } = await seed(adapter, {
      requester: requester.userId,
      expiresAt: Date.now() - 1000,
    });

    const res = await call(
      approver.cookie,
      'POST',
      `/${request.public_request_id}/steps/${steps[0].id}/approve`
    );

    expect(res.status).toBe(409);
    expect(grantCount(request.id)).toBe(0);
  });
});

describe('a request yields at most one active grant', () => {
  it('refuses to insert a second active grant for the same request', async () => {
    const { db, adapter } = setup();
    const requester = signIn(db);
    const { request } = await seed(adapter, { requester: requester.userId });
    db.prepare("UPDATE approval_requests SET status = 'approved' WHERE id = ?").run(request.id);
    const grants = new ElevationGrantRepository(adapter);
    const input = {
      approval_request_id: request.id,
      tenant_id: TENANT,
      target_audience: 'admin_api',
      resource_class: 'admin_audit_detail',
      redaction_level: 'masked' as const,
      scope_json: request.scope_json,
      scope_canonical: request.scope_canonical,
      requester_subject_type: 'admin_user' as const,
      requester_subject_id: requester.userId,
      actor_subject_type: 'admin_user' as const,
      actor_subject_id: requester.userId,
      expires_at: Date.now() + 60_000,
    };

    const [first, second] = [
      await grants.createElevationGrant(input, { onlyIfNoActiveGrant: true }),
      await grants.createElevationGrant(input, { onlyIfNoActiveGrant: true }),
    ];

    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(
      (
        db
          .prepare('SELECT count(*) AS n FROM elevation_grants WHERE approval_request_id = ?')
          .get(request.id) as { n: number }
      ).n
    ).toBe(1);
  });

  it('issues a new grant once the earlier one is revoked', async () => {
    const { db, adapter } = setup();
    const requester = signIn(db);
    const { request } = await seed(adapter, { requester: requester.userId });
    db.prepare("UPDATE approval_requests SET status = 'approved' WHERE id = ?").run(request.id);
    const grants = new ElevationGrantRepository(adapter);
    const input = {
      approval_request_id: request.id,
      tenant_id: TENANT,
      target_audience: 'admin_api',
      resource_class: 'admin_audit_detail',
      redaction_level: 'masked' as const,
      scope_json: request.scope_json,
      scope_canonical: request.scope_canonical,
      requester_subject_type: 'admin_user' as const,
      requester_subject_id: requester.userId,
      actor_subject_type: 'admin_user' as const,
      actor_subject_id: requester.userId,
      expires_at: Date.now() + 60_000,
    };
    const first = await grants.createElevationGrant(input, { onlyIfNoActiveGrant: true });
    await grants.updateElevationGrantStatus(first!.id, 'revoked', { revokedAt: Date.now() });

    expect(await grants.createElevationGrant(input, { onlyIfNoActiveGrant: true })).not.toBeNull();
  });
});

describe('a grant follows the request it was issued from', () => {
  it('is not issued for a request that was cancelled in the meantime', async () => {
    const { db, adapter } = setup();
    const requester = signIn(db);
    const { request } = await seed(adapter, { requester: requester.userId });
    db.prepare("UPDATE approval_requests SET status = 'cancelled' WHERE id = ?").run(request.id);

    const grant = await new ElevationGrantRepository(adapter).createElevationGrant(
      {
        approval_request_id: request.id,
        tenant_id: TENANT,
        target_audience: 'admin_api',
        resource_class: 'admin_audit_detail',
        redaction_level: 'masked',
        scope_json: request.scope_json,
        scope_canonical: request.scope_canonical,
        requester_subject_type: 'admin_user',
        requester_subject_id: requester.userId,
        actor_subject_type: 'admin_user',
        actor_subject_id: requester.userId,
        expires_at: Date.now() + 60_000,
      },
      { onlyIfNoActiveGrant: true }
    );

    expect(grant).toBeNull();
  });

  it('is not issued once the request has passed its deadline', async () => {
    const { db, adapter } = setup();
    const requester = signIn(db);
    const { request } = await seed(adapter, { requester: requester.userId });
    db.prepare("UPDATE approval_requests SET status = 'approved', expires_at = ? WHERE id = ?").run(
      Date.now() - 1,
      request.id
    );

    const grant = await new ElevationGrantRepository(adapter).createElevationGrant(
      {
        approval_request_id: request.id,
        tenant_id: TENANT,
        target_audience: 'admin_api',
        resource_class: 'admin_audit_detail',
        redaction_level: 'masked',
        scope_json: request.scope_json,
        scope_canonical: request.scope_canonical,
        requester_subject_type: 'admin_user',
        requester_subject_id: requester.userId,
        actor_subject_type: 'admin_user',
        actor_subject_id: requester.userId,
        expires_at: Date.now() + 60_000,
      },
      { onlyIfNoActiveGrant: true }
    );

    expect(grant).toBeNull();
  });
});

describe('a request with several steps', () => {
  it('ends approved with one grant when its steps are decided one after the other', async () => {
    const { db, adapter, call, grantCount } = setup();
    const requester = signIn(db);
    const first = signIn(db);
    const second = signIn(db);
    const { request, steps } = await seed(adapter, { requester: requester.userId, steps: 2 });
    const base = `/${request.public_request_id}/steps`;

    expect((await call(first.cookie, 'POST', `${base}/${steps[0].id}/approve`)).json.status).toBe(
      'partially_approved'
    );
    expect((await call(second.cookie, 'POST', `${base}/${steps[1].id}/approve`)).json.status).toBe(
      'approved'
    );
    expect(grantCount(request.id)).toBe(1);
  });

  it('stays approved when the other step is decided between a decision and its status write', async () => {
    const { db, adapter, call, grantCount, hooks } = setup();
    const requester = signIn(db);
    const first = signIn(db);
    const second = signIn(db);
    const { request, steps } = await seed(adapter, { requester: requester.userId, steps: 2 });
    const base = `/${request.public_request_id}/steps`;
    // The first approver has written their step and read the steps back; before the request's
    // status write lands, the second approver completes the request.
    hooks.beforeExecute = {
      match: /^\s*UPDATE approval_requests/,
      run: async () => {
        await call(second.cookie, 'POST', `${base}/${steps[1].id}/approve`);
      },
    };

    const res = await call(first.cookie, 'POST', `${base}/${steps[0].id}/approve`);

    expect(hooks.beforeExecute).toBeUndefined();
    expect(res.status).toBe(200);
    expect(
      (
        db.prepare('SELECT status FROM approval_requests WHERE id = ?').get(request.id) as {
          status: string;
        }
      ).status
    ).toBe('approved');
    expect(grantCount(request.id)).toBe(1);
  });

  it('takes no decision on a step once another step has denied the request', async () => {
    const { db, adapter, call, grantCount, hooks } = setup();
    const requester = signIn(db);
    const first = signIn(db);
    const second = signIn(db);
    const { request, steps } = await seed(adapter, { requester: requester.userId, steps: 2 });
    const base = `/${request.public_request_id}/steps`;
    // The checks have passed; before the first approver's write, the other step is denied.
    hooks.beforeExecute = {
      match: /^\s*UPDATE approval_request_approvals/,
      run: async () => {
        await call(second.cookie, 'POST', `${base}/${steps[1].id}/deny`);
      },
    };

    const res = await call(first.cookie, 'POST', `${base}/${steps[0].id}/approve`);

    expect(hooks.beforeExecute).toBeUndefined();
    expect(res.status).toBe(409);
    expect(
      (
        db
          .prepare('SELECT status FROM approval_request_approvals WHERE id = ?')
          .get(steps[0].id) as { status: string }
      ).status
    ).toBe('pending');
    expect(grantCount(request.id)).toBe(0);
  });

  it('takes no decision after the request’s deadline has passed under the write', async () => {
    const { db, adapter, call, grantCount, hooks } = setup();
    const requester = signIn(db);
    const approver = signIn(db);
    const { request, steps } = await seed(adapter, { requester: requester.userId });
    hooks.beforeExecute = {
      match: /^\s*UPDATE approval_request_approvals/,
      run: async () => {
        db.prepare('UPDATE approval_requests SET expires_at = ? WHERE id = ?').run(
          Date.now() - 1,
          request.id
        );
      },
    };

    const res = await call(
      approver.cookie,
      'POST',
      `/${request.public_request_id}/steps/${steps[0].id}/approve`
    );

    expect(hooks.beforeExecute).toBeUndefined();
    expect(res.status).toBe(409);
    expect(grantCount(request.id)).toBe(0);
  });

  it('works the status out from the steps as they are now', async () => {
    const { db, adapter } = setup();
    const requester = signIn(db);
    const { request } = await seed(adapter, { requester: requester.userId, steps: 2 });
    db.prepare("UPDATE approval_request_approvals SET status = 'approved'").run();
    db.prepare("UPDATE approval_requests SET status = 'partially_approved' WHERE id = ?").run(
      request.id
    );

    const updated = await new ApprovalRequestRepository(adapter).recomputeApprovalRequestStatus(
      request.id
    );

    expect(updated?.status).toBe('approved');
    expect(updated?.decided_at).not.toBeNull();
  });
});

describe('an approval names its approver', () => {
  it('refuses an approval from nobody in particular (a portal step with no approver)', async () => {
    const { db, adapter } = setup();
    const requester = signIn(db);
    const { request, steps } = await seed(adapter, { requester: requester.userId });

    await expect(
      applyApprovalDecisionForRequest(
        { env: {} } as unknown as Parameters<typeof applyApprovalDecisionForRequest>[0],
        {
          adapter,
          requestRepo: new ApprovalRequestRepository(adapter),
          approvalRepo: new ApprovalRequestApprovalRepository(adapter),
          grantRepo: new ElevationGrantRepository(adapter),
        },
        {
          request,
          approval: steps[0],
          nextStatus: 'approved',
          actorSubjectType: 'admin_user',
          actorSubjectId: null,
        }
      )
    ).rejects.toMatchObject({
      code: 'approver_identity_required',
    } satisfies Partial<ApprovalWorkflowPolicyError>);
    expect(
      (
        db
          .prepare('SELECT status FROM approval_request_approvals WHERE id = ?')
          .get(steps[0].id) as {
          status: string;
        }
      ).status
    ).toBe('pending');
  });
});

describe('a machine credential is one subject, however it is recorded', () => {
  it.each([['service_principal'], ['admin_user']] as const)(
    'cannot approve a request it filed as a %s',
    async (requesterType) => {
      const { db, adapter } = setup();
      const { request, steps } = await seed(adapter, { requester: 'principal-1' });
      db.prepare('UPDATE approval_requests SET requester_subject_type = ? WHERE id = ?').run(
        requesterType,
        request.id
      );
      const refresh = (await new ApprovalRequestRepository(adapter).getApprovalRequestByPublicId(
        TENANT,
        request.public_request_id
      ))!;

      await expect(
        applyApprovalDecisionForRequest(
          { env: {} } as unknown as Parameters<typeof applyApprovalDecisionForRequest>[0],
          {
            adapter,
            requestRepo: new ApprovalRequestRepository(adapter),
            approvalRepo: new ApprovalRequestApprovalRepository(adapter),
            grantRepo: new ElevationGrantRepository(adapter),
          },
          {
            request: refresh,
            approval: steps[0],
            nextStatus: 'approved',
            // The approvals route records the actor as an admin_user, whoever signed in.
            actorSubjectType: 'admin_user',
            actorSubjectId: 'principal-1',
          }
        )
      ).rejects.toMatchObject({ code: 'self_approval_not_allowed' });
    }
  );
});

describe('who a request is filed by', () => {
  it('is the signed-in admin, whatever the body says', () => {
    expect(resolveApprovalRequester({ userId: 'a', authMethod: 'session' }, {})).toEqual({
      type: 'admin_user',
      id: 'a',
    });
    expect(() =>
      resolveApprovalRequester({ userId: 'a', authMethod: 'session' }, { id: 'b' })
    ).toThrow(ApprovalRequesterError);
    expect(() =>
      resolveApprovalRequester(
        { userId: 'a', authMethod: 'session' },
        { type: 'service_principal' }
      )
    ).toThrow(ApprovalRequesterError);
  });

  it('may be named by a machine credential, as before', () => {
    const machine = { userId: 'principal-1', authMethod: 'machine_access_token' };
    expect(resolveApprovalRequester(machine, {})).toEqual({
      type: 'admin_user',
      id: 'principal-1',
    });
    expect(resolveApprovalRequester(machine, { type: 'service_principal', id: 'svc-1' })).toEqual({
      type: 'service_principal',
      id: 'svc-1',
    });
  });

  it('falls back to the system when nobody is signed in', () => {
    expect(resolveApprovalRequester(undefined, {})).toEqual({
      type: 'service_principal',
      id: 'system',
    });
  });
});
