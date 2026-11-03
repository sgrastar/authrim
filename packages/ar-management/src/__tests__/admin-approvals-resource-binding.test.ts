import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import {
  ApprovalRequestApprovalRepository,
  ApprovalRequestRepository,
  ElevationGrantRepository,
  ELEVATION_GRANT_SUBJECT_TOKEN_USE,
  canonicalizeApprovalScope,
  findApprovalScopeBindingViolation,
  resolveElevationGrantSubjectToken,
  type ApprovalRequestApproval,
  type DatabaseAdapter,
  type Env,
} from '@authrim/ar-lib-core';
import { adminApprovalsRouter } from '../routes/admin-management/admin-approvals';
import { requireAdminPermissionOrElevationGrant } from '../admin-elevation-access';
import { openAdminDatabase, sqliteAdapter } from './helpers/admin-authority-fixture';
import { ApprovalWorkflowPolicyError, applyApprovalDecisionForRequest } from '../approval-workflow';
import type { SQLiteDatabase } from './test-sqlite';

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
 * What an approval may open is bound to who approves it: a user's approval opens that user's own
 * profile and nothing else, and every other resource needs an admin's approval. The rule holds
 * when a request is filed, when it is decided, and when an earlier grant is used.
 */

const TENANT = 'tenant-a';
const PERMISSIONS = [
  'admin:approvals:read',
  'admin:approvals:write',
  'admin:approvals:approve',
  'admin:approvals:grant:issue',
];

type Step = Pick<ApprovalRequestApproval, 'side' | 'subject_type'> & { subject_id?: string | null };

const OWNER = (userId: string): Step => ({
  side: 'customer_data_owner',
  subject_type: 'end_user',
  subject_id: userId,
});
const ADMIN: Step = { side: 'admin_operator', subject_type: 'admin_user', subject_id: null };

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
    ['viewer', 'role_ar_viewer'],
  ] as const) {
    db.prepare(
      `INSERT INTO admin_role_assignments (id, tenant_id, admin_user_id, admin_role_id, scope_type, scope_id, created_at)
       VALUES (?, ?, ?, ?, 'tenant', ?, ?)`
    ).run(`${userId}-${suffix}`, TENANT, userId, role, TENANT, now);
  }
  return { userId, cookie: `authrim_admin_session=${sessionId}` };
}

function setup() {
  const db = openAdminDatabase();
  const adapter = sqliteAdapter(db);
  const env = { DB_ADMIN: adapter } as unknown as Env;
  const app = new Hono<{ Bindings: Env }>();
  app.use('*', async (c, next) => {
    (c as unknown as { set(key: string, value: unknown): void }).set('tenantId', TENANT);
    await next();
  });
  app.route('/api/admin/approvals', adminApprovalsRouter);
  const call = async (cookie: string, path: string, body: unknown) => {
    const response = await app.request(
      `/api/admin/approvals${path}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-Tenant-Id': TENANT, Cookie: cookie },
        body: JSON.stringify(body),
      },
      env
    );
    return {
      status: response.status,
      json: await response.json<{ error?: string; error_description?: string }>(),
    };
  };
  const counts = () => ({
    requests: (db.prepare('SELECT count(*) AS n FROM approval_requests').get() as { n: number }).n,
    grants: (db.prepare('SELECT count(*) AS n FROM elevation_grants').get() as { n: number }).n,
  });
  return { db, adapter, env, call, counts };
}

const createBody = (extra: Record<string, unknown> = {}) => ({
  target_subject_type: 'user',
  target_subject_id: 'user-u',
  request_surface: 'service_data',
  requested_action: 'detail_read',
  resource_class: 'customer_profile',
  reason_code: 'support_case',
  policy_preset: 'support_case_default',
  approvals: [{ step_key: 'owner-1', side: 'customer_data_owner', subject_type: 'end_user' }],
  ...extra,
});

/** A request stored as an older release could have stored it, skipping today's checks. */
async function seedRequest(
  adapter: DatabaseAdapter,
  input: {
    targetType?: 'user' | 'tenant_resource';
    targetId: string;
    resourceClass: string;
    resourceIds?: string[];
    steps: Step[];
    approved?: boolean;
    requester?: string;
  }
) {
  const requests = new ApprovalRequestRepository(adapter);
  const approvals = new ApprovalRequestApprovalRepository(adapter);
  const surface = input.resourceClass === 'admin_audit_detail' ? 'admin_audit' : 'service_data';
  const scope = canonicalizeApprovalScope({
    version: 1,
    surface,
    action: 'detail_read',
    tenant_id: TENANT,
    resource_class: input.resourceClass,
    resource_ids: input.resourceIds,
    investigation_id: 'inv_1',
    redaction_level: 'masked',
  });
  const expiresAt = Date.now() + 15 * 60_000;
  let request = await requests.createApprovalRequest({
    tenant_id: TENANT,
    investigation_id: 'inv_1',
    requester_subject_type: 'admin_user',
    requester_subject_id: input.requester ?? 'requester-admin',
    target_subject_type: input.targetType ?? 'user',
    target_subject_id: input.targetId,
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
  for (const [index, step] of input.steps.entries()) {
    steps.push(
      await approvals.createApproval({
        approval_request_id: request.id,
        step_key: `step-${index + 1}`,
        side: step.side,
        subject_type: step.subject_type,
        subject_id: step.subject_id ?? null,
        expires_at: expiresAt,
      })
    );
  }
  let grant = null;
  if (input.approved) {
    request = (await requests.updateApprovalRequestStatus(request.id, 'approved'))!;
    grant = await new ElevationGrantRepository(adapter).createElevationGrant({
      approval_request_id: request.id,
      tenant_id: TENANT,
      target_audience: 'admin_api',
      resource_class: input.resourceClass,
      redaction_level: 'masked',
      scope_json: request.scope_json,
      scope_canonical: request.scope_canonical,
      authorization_details_json: {},
      requester_subject_type: 'admin_user',
      requester_subject_id: request.requester_subject_id,
      actor_subject_type: 'admin_user',
      actor_subject_id: request.requester_subject_id,
      expires_at: expiresAt,
    });
  }
  return { request, steps, grant };
}

describe('the rule itself', () => {
  const rule = (input: Partial<Parameters<typeof findApprovalScopeBindingViolation>[0]>) =>
    findApprovalScopeBindingViolation({
      targetSubjectType: 'user',
      targetSubjectId: 'user-u',
      resourceClass: 'customer_profile',
      resourceIds: ['user-u'],
      steps: [OWNER('user-u')],
      ...input,
    });

  it('lets a user approve their own profile, and only theirs', () => {
    expect(rule({})).toBeNull();
    expect(rule({ resourceIds: [' user-u ', 'user-u'] })).toBeNull();
    expect(rule({ resourceIds: ['user-v'] })).not.toBeNull();
    expect(rule({ resourceIds: ['user-u', 'user-v'] })).not.toBeNull();
    expect(rule({ targetSubjectType: 'tenant_resource' })).not.toBeNull();
    // The stored target is what a subject token names, so it is compared as stored.
    expect(rule({ targetSubjectId: ' user-u ' })).not.toBeNull();
  });

  it('binds a profile to its target even when an admin approves it', () => {
    expect(rule({ resourceIds: ['user-v'], steps: [ADMIN] })).not.toBeNull();
  });

  it('needs an admin for every other class, named or not', () => {
    for (const resourceClass of ['admin_audit_detail', 'verified_attribute', 'unlisted_detail']) {
      expect(rule({ resourceClass, steps: [OWNER('user-u')] })).not.toBeNull();
      expect(
        rule({
          resourceClass,
          steps: [{ side: 'admin_operator', subject_type: 'service_principal' }],
        })
      ).not.toBeNull();
      expect(rule({ resourceClass, steps: [OWNER('user-u'), ADMIN] })).toBeNull();
    }
  });

  it('refuses a scope that names no resource', () => {
    for (const resourceIds of [undefined, [], ['  ']]) {
      expect(
        rule({ resourceClass: 'admin_audit_detail', resourceIds, steps: [ADMIN] })
      ).not.toBeNull();
    }
  });
});

describe('filing a request', () => {
  it('refuses a user’s approval for another user’s profile', async () => {
    const { db, call, counts } = setup();
    const admin = signIn(db);

    for (const path of ['', '/preview']) {
      const res = await call(admin.cookie, path, createBody({ resource_ids: ['user-v'] }));
      expect(res.status).toBe(409);
      expect(res.json.error).toBe('approval_scope_binding_violation');
    }
    expect(counts().requests).toBe(0);
  });

  it('refuses a user’s approval for an admin resource or an unlisted class', async () => {
    const { db, call, counts } = setup();
    const admin = signIn(db);

    for (const resourceClass of ['admin_audit_detail', 'verified_attribute', 'unlisted_detail']) {
      const res = await call(admin.cookie, '', createBody({ resource_class: resourceClass }));
      expect(res.status).toBe(409);
      expect(res.json.error).toBe('approval_scope_binding_violation');
    }
    expect(counts().requests).toBe(0);
  });

  it('files an admin resource an admin approves, and a profile for the target user', async () => {
    const { db, call } = setup();
    const admin = signIn(db);
    const adminStep = {
      step_key: 'operator-1',
      side: 'admin_operator',
      subject_type: 'admin_user',
    };

    const audit = await call(
      admin.cookie,
      '',
      createBody({
        target_subject_type: 'tenant_resource',
        target_subject_id: 'log-1',
        resource_class: 'admin_audit_detail',
        approvals: [adminStep],
      })
    );
    expect(audit.status).toBe(201);

    // Omitted resource ids default to the target.
    const profile = await call(admin.cookie, '', createBody({ approvals: [adminStep] }));
    expect(profile.status).toBe(201);
  });

  it('refuses an empty resource list instead of reading it as every resource', async () => {
    const { db, call, counts } = setup();
    const admin = signIn(db);
    const body = (resourceIds: string[]) =>
      createBody({
        target_subject_type: 'tenant_resource',
        target_subject_id: 'log-1',
        resource_class: 'admin_audit_detail',
        resource_ids: resourceIds,
        approvals: [{ step_key: 'operator-1', side: 'admin_operator', subject_type: 'admin_user' }],
      });

    for (const path of ['', '/preview']) {
      for (const resourceIds of [[], ['  ']]) {
        expect((await call(admin.cookie, path, body(resourceIds))).status).toBe(400);
      }
    }
    expect(counts().requests).toBe(0);
  });

  it('refuses the classes only the server files requests for', async () => {
    const { db, call, counts } = setup();
    const admin = signIn(db);

    for (const resourceClass of ['support_operation_cohort', 'agent_elevation']) {
      const res = await call(
        admin.cookie,
        '',
        createBody({
          target_subject_type: 'tenant_resource',
          target_subject_id: 'cohort-1',
          request_surface: 'support_ops',
          resource_class: resourceClass,
          approvals: [
            { step_key: 'operator-1', side: 'admin_operator', subject_type: 'admin_user' },
          ],
        })
      );
      expect(res.status).toBe(400);
    }
    expect(counts().requests).toBe(0);
  });
});

describe('deciding a request filed before the rule', () => {
  it('does not let the target user approve another user’s profile', async () => {
    const { adapter, counts } = setup();
    const { request, steps } = await seedRequest(adapter, {
      targetId: 'user-u',
      resourceClass: 'customer_profile',
      resourceIds: ['user-v'],
      steps: [OWNER('user-u')],
    });

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
          actorSubjectType: 'end_user',
          actorSubjectId: 'user-u',
        }
      )
    ).rejects.toMatchObject({
      code: 'approval_scope_binding_violation',
    } satisfies Partial<ApprovalWorkflowPolicyError>);
    expect(counts().grants).toBe(0);
  });
});

describe('using a grant issued before the rule', () => {
  const useGrant = async (
    env: Env,
    actorId: string,
    requirement: { resourceClass: string; resourceIds: string[]; grantId?: string }
  ) => {
    const app = new Hono<{ Bindings: Env }>();
    app.get('/read', async (c) => {
      (c as unknown as { set(key: string, value: unknown): void }).set('tenantId', TENANT);
      (c as unknown as { set(key: string, value: unknown): void }).set('adminAuth', {
        userId: actorId,
        permissions: [],
      });
      const access = await requireAdminPermissionOrElevationGrant(c as never, {
        directPermission: 'admin:audit:detail:read',
        requestSurface:
          requirement.resourceClass === 'admin_audit_detail' ? 'admin_audit' : 'service_data',
        requestedAction: 'detail_read',
        resourceClass: requirement.resourceClass,
        resourceIds: requirement.resourceIds,
      });
      return access instanceof Response
        ? access
        : c.json({ granted: access.grant?.public_grant_id });
    });
    const query = requirement.grantId ? `?grant_id=${requirement.grantId}` : '';
    return (await app.request(`/read${query}`, {}, env)).status;
  };

  it('does not open an admin resource that only a user approved', async () => {
    const { adapter, env } = setup();
    const { grant } = await seedRequest(adapter, {
      targetId: 'user-u',
      resourceClass: 'admin_audit_detail',
      resourceIds: ['log-1'],
      steps: [OWNER('user-u')],
      approved: true,
    });
    const requirement = { resourceClass: 'admin_audit_detail', resourceIds: ['log-1'] };

    expect(await useGrant(env, 'requester-admin', requirement)).toBe(403);
    expect(
      await useGrant(env, 'requester-admin', { ...requirement, grantId: grant!.public_grant_id })
    ).toBe(403);
  });

  it('still opens the same resource when an admin approved it', async () => {
    const { adapter, env } = setup();
    await seedRequest(adapter, {
      targetType: 'tenant_resource',
      targetId: 'log-1',
      resourceClass: 'admin_audit_detail',
      resourceIds: ['log-1'],
      steps: [ADMIN],
      approved: true,
    });

    expect(
      await useGrant(env, 'requester-admin', {
        resourceClass: 'admin_audit_detail',
        resourceIds: ['log-1'],
      })
    ).toBe(200);
  });

  it('does not read a grant that names no resource as one for every resource', async () => {
    const { adapter, env } = setup();
    await seedRequest(adapter, {
      targetType: 'tenant_resource',
      targetId: 'log-1',
      resourceClass: 'admin_audit_detail',
      resourceIds: [],
      steps: [ADMIN],
      approved: true,
    });

    expect(
      await useGrant(env, 'requester-admin', {
        resourceClass: 'admin_audit_detail',
        resourceIds: ['log-2'],
      })
    ).toBe(403);
  });

  it('refuses a subject token for, and an exchange of, a profile grant for another user', async () => {
    const { db, adapter, call } = setup();
    const admin = signIn(db);
    const { request, grant } = await seedRequest(adapter, {
      targetId: 'user-u',
      resourceClass: 'customer_profile',
      resourceIds: ['user-v'],
      steps: [OWNER('user-u')],
      approved: true,
      requester: admin.userId,
    });

    const issued = await call(
      admin.cookie,
      `/${request.public_request_id}/grants/${grant!.public_grant_id}/subject-token`,
      { client_id: 'svc-client-1' }
    );
    expect(issued.status).toBe(409);
    expect(issued.json.error).toBe('approval_scope_binding_violation');

    // A subject token minted before the rule is refused when it is exchanged.
    await expect(
      resolveElevationGrantSubjectToken({
        adapter,
        tenantId: TENANT,
        requestingClientId: 'svc-client-1',
        tokenPayload: {
          token_use: ELEVATION_GRANT_SUBJECT_TOKEN_USE,
          aud: 'svc-client-1',
          sub: 'user-u',
          authrim_elevation: {
            grant_id: grant!.public_grant_id,
            request_id: request.public_request_id,
          },
        },
      })
    ).rejects.toThrow('not bound to its approvers');
  });
});
