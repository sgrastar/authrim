/**
 * zod 3 -> 4 migration pins for routes/admin-management/admin-approvals.ts.
 *
 * Every route does `Schema.parse(await c.req.json())` inside a try/catch and, for
 * `error instanceof z.ZodError`, reports ONLY `issues[0]` as `field = path.join('.') || 'body'`,
 * `reason = message`. `createErrorResponse` is mocked (status from the real implementation, body
 * `{ error: code, ...options }`) so both strings are pinned.
 * A payload that passes validation is detected by the next step: the (mocked) request lookup
 * returns null, which yields `404 ADMIN_RESOURCE_NOT_FOUND`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core';

const mocks = vi.hoisted(() => ({
  adapter: { query: vi.fn(), queryOne: vi.fn(), execute: vi.fn() },
  requestRepo: {
    createApprovalRequest: vi.fn(),
    getApprovalRequestByPublicId: vi.fn(),
    updateApprovalRequestStatus: vi.fn(),
    listApprovalRequests: vi.fn(),
  },
  approvalRepo: {
    createApproval: vi.fn(),
    getApprovalById: vi.fn(),
    listApprovalsForRequest: vi.fn(),
    updateApproval: vi.fn(),
  },
  grantRepo: {
    createElevationGrant: vi.fn(),
    listElevationGrantsForRequest: vi.fn(),
    updateElevationGrantStatus: vi.fn(),
  },
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    ADMIN_PERMISSIONS: {
      ...actual.ADMIN_PERMISSIONS,
      APPROVALS_GRANT_ISSUE: 'admin:approvals:grant:issue',
    },
    adminAuthMiddleware: vi.fn(() => async (c: any, next: () => Promise<void>) => {
      c.set('adminAuth', {
        userId: 'admin-1',
        authMethod: 'session',
        tenantId: 'tenant-a',
        permissions: [
          actual.ADMIN_PERMISSIONS.APPROVALS_WRITE,
          actual.ADMIN_PERMISSIONS.APPROVALS_APPROVE,
          'admin:approvals:grant:issue',
        ],
        roles: ['tenant_admin'],
        hierarchyLevel: 50,
        mfaVerified: true,
      });
      await next();
    }),
    requireDedicatedAdminDatabaseAdapter: vi.fn(() => mocks.adapter),
    ensureDatabaseAdapter: vi.fn(() => mocks.adapter),
    getTenantIdFromContext: vi.fn(() => 'tenant-a'),
    ApprovalRequestRepository: vi.fn(function MockApprovalRequestRepository() {
      return mocks.requestRepo;
    }),
    ApprovalRequestApprovalRepository: vi.fn(function MockApprovalRequestApprovalRepository() {
      return mocks.approvalRepo;
    }),
    ElevationGrantRepository: vi.fn(function MockElevationGrantRepository() {
      return mocks.grantRepo;
    }),
    createErrorResponse: vi.fn(async (c, code, options) => {
      const real = await actual.createErrorResponse(c, code, options);
      return Response.json({ error: code, ...options }, { status: real.status });
    }),
  };
});
vi.mock('../../admin-shared', () => ({ writeAdminAuditLog: vi.fn() }));
vi.mock('../../approval-transport-detail', () => ({
  appendApprovalTransportEvent: vi.fn(async (_c, _a, _r, request) => request),
  loadApprovalTransportDetail: vi.fn(),
}));

import { adminApprovalsRouter } from '../../routes/admin-management/admin-approvals';

const env = { DB_ADMIN: {}, DB: {} } as unknown as Env;

async function post(path: string, body: unknown, raw?: string) {
  const app = new Hono<{ Bindings: Env }>();
  app.route('/api/admin/approvals', adminApprovalsRouter);
  const response = await app.request(
    `/api/admin/approvals${path}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: raw ?? JSON.stringify(body),
    },
    env
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

const invalid = (field: string, reason: string) => ({
  status: 400,
  body: { error: 'AR130003', variables: { field, reason } },
});
/** Passed the schema; the request lookup (mocked to null) stopped it. */
const ACCEPTED = { status: 404, body: { error: 'AR060004' } };

const METHODS = "'ciba' | 'passkey' | 'portal_confirm' | 'email_otp' | 'sms_otp' | 'reauth'";
const SUBJECT_TYPES = "'admin_user' | 'end_user' | 'customer_delegate' | 'service_principal'";
const PRESETS =
  "'support_case_default' | 'technical_debug_default' | 'security_investigation_default' | 'guardian_support_default' | 'compliance_review_default'";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requestRepo.getApprovalRequestByPublicId.mockResolvedValue(null);
  mocks.requestRepo.listApprovalRequests.mockResolvedValue([]);
  mocks.approvalRepo.listApprovalsForRequest.mockResolvedValue([]);
  mocks.grantRepo.listElevationGrantsForRequest.mockResolvedValue([]);
});

const step = { step_key: 'operator-1', side: 'admin_operator', subject_type: 'admin_user' };
const create = (overrides: Record<string, unknown> = {}) => ({
  target_subject_type: 'user',
  target_subject_id: 'user-1',
  request_surface: 'admin_audit',
  requested_action: 'detail_read',
  resource_class: 'admin_audit_detail',
  reason_code: 'support_case',
  policy_preset: 'support_case_default',
  approvals: [step],
  ...overrides,
});

describe('zod pins: ApprovalRequestCreateSchema (POST /approvals and POST /approvals/preview)', () => {
  it.each(['', '/preview'])('first-issue reporting on %s', async (route) => {
    const run = (body: unknown) => post(route, body);
    expect(await run(null)).toEqual(invalid('body', 'Expected object, received null'));
    expect(await run([])).toEqual(invalid('body', 'Expected object, received array'));
    expect(await run({})).toEqual(invalid('target_subject_type', 'Required'));
    expect(await run(create({ target_subject_type: 'group' }))).toEqual(
      invalid(
        'target_subject_type',
        "Invalid enum value. Expected 'user' | 'artifact' | 'service_resource' | 'tenant_resource', received 'group'"
      )
    );
    expect(await run(create({ target_subject_id: '' }))).toEqual(
      invalid('target_subject_id', 'String must contain at least 1 character(s)')
    );
    expect(await run(create({ requester_subject_type: 'robot' }))).toEqual(
      invalid(
        'requester_subject_type',
        `Invalid enum value. Expected ${SUBJECT_TYPES}, received 'robot'`
      )
    );
    expect(await run(create({ redaction_level: 'full' }))).toEqual(
      invalid(
        'redaction_level',
        "Invalid enum value. Expected 'summary_only' | 'masked' | 'raw', received 'full'"
      )
    );
    expect(await run(create({ policy_preset: 'custom' }))).toEqual(
      invalid('policy_preset', `Invalid enum value. Expected ${PRESETS}, received 'custom'`)
    );
    expect(await run(create({ reuse_scope: 'global' }))).toEqual(
      invalid('reuse_scope', "Invalid enum value. Expected 'request' | 'case', received 'global'")
    );
    expect(await run(create({ partial_access_allowed: 'yes' }))).toEqual(
      invalid('partial_access_allowed', 'Expected boolean, received string')
    );
    expect(await run(create({ expires_at: 0 }))).toEqual(
      invalid('expires_at', 'Number must be greater than 0')
    );
    expect(await run(create({ expires_at: 1.5 }))).toEqual(
      invalid('expires_at', 'Expected integer, received float')
    );
    expect(await run(create({ approvals: [] }))).toEqual(
      invalid('approvals', 'Array must contain at least 1 element(s)')
    );
    expect(await run(create({ approvals: 'x' }))).toEqual(
      invalid('approvals', 'Expected array, received string')
    );
    expect(await run(create({ resource_ids: [''] }))).toEqual(
      invalid('resource_ids.0', 'String must contain at least 1 character(s)')
    );
    expect(await run(create({ detail_classes: [5] }))).toEqual(
      invalid('detail_classes.0', 'Expected string, received number')
    );
    expect(await run(create({ attributes: [] }))).toEqual(
      invalid('attributes', 'Expected object, received array')
    );
    expect(await run(create({ reference: { system: 'jira' } }))).toEqual(
      invalid('reference.id', 'Required')
    );
    expect(await run(create({ reference: { system: '', id: 'x' } }))).toEqual(
      invalid('reference.system', 'String must contain at least 1 character(s)')
    );
    expect(
      await run(create({ ticket_reference: { system: 's', id: 'i', url: 'not a url' } }))
    ).toEqual(invalid('ticket_reference.url', 'Invalid url'));
    expect(await run(create({ approvals: [{ ...step, side: 'robot' }] }))).toEqual(
      invalid(
        'approvals.0.side',
        "Invalid enum value. Expected 'admin_operator' | 'customer_data_owner' | 'guardian_delegate', received 'robot'"
      )
    );
    expect(await run(create({ approvals: [step, { ...step, step_key: '' }] }))).toEqual(
      invalid('approvals.1.step_key', 'String must contain at least 1 character(s)')
    );
    expect(await run(create({ approvals: [{ ...step, step_key: 's'.repeat(101) }] }))).toEqual(
      invalid('approvals.0.step_key', 'String must contain at most 100 character(s)')
    );
    expect(await run(create({ approvals: [{ ...step, method: 'fax' }] }))).toEqual(
      invalid('approvals.0.method', `Invalid enum value. Expected ${METHODS}, received 'fax'`)
    );
    expect(await run(create({ approvals: [{ ...step, expires_at: -1 }] }))).toEqual(
      invalid('approvals.0.expires_at', 'Number must be greater than 0')
    );
  });

  it.each(['', '/preview'])('first issue follows schema order on %s', async (route) => {
    expect(await post(route, { policy_preset: 'x', target_subject_id: '', approvals: [] })).toEqual(
      invalid('target_subject_type', 'Required')
    );
    expect(
      await post(route, create({ policy_preset: 'x', reason_code: '', approvals: [] }))
    ).toEqual(invalid('reason_code', 'String must contain at least 1 character(s)'));
  });

  it('url() on a structured reference: lenient URL syntax', async () => {
    const outcome: Record<string, boolean> = {};
    for (const url of [
      'https://jira.example.com/T-1',
      'javascript:alert(1)',
      'mailto:a@b.co',
      ' https://x.example',
      'not a url',
      '//x.example',
      '',
    ]) {
      const result = await post('', create({ reference: { system: 's', id: 'i', url } }));
      outcome[url] =
        result.status === 400 &&
        (result.body.variables as { field: string }).field === 'reference.url';
    }
    expect(outcome).toEqual({
      'https://jira.example.com/T-1': false,
      'javascript:alert(1)': false,
      'mailto:a@b.co': false,
      ' https://x.example': false,
      'not a url': true,
      '//x.example': true,
      '': true,
    });
  });

  it('malformed JSON is not a ZodError (internal error)', async () => {
    expect(await post('', undefined, '{oops')).toEqual({
      status: 500,
      body: { error: 'AR900001' },
    });
  });

  it('defaults reach the repository: redaction_level="masked", reuse_scope="request", partial_access_allowed=false', async () => {
    mocks.requestRepo.createApprovalRequest.mockRejectedValue(new Error('stop here'));
    const result = await post('', create({ unknown_key: 'dropped' }));
    expect(result).toEqual({ status: 500, body: { error: 'AR900001' } });
    const call = mocks.requestRepo.createApprovalRequest.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(call).toMatchObject({
      tenant_id: 'tenant-a',
      requester_subject_type: 'admin_user',
      requester_subject_id: 'admin-1',
      target_subject_type: 'user',
      target_subject_id: 'user-1',
      request_surface: 'admin_audit',
      requested_action: 'detail_read',
      redaction_level: 'masked',
      reason_code: 'support_case',
      reason_note: null,
      reference: null,
      ticket_reference: null,
      policy_preset: 'support_case_default',
      reuse_scope: 'request',
      partial_access_allowed: false,
    });
    expect(call).not.toHaveProperty('unknown_key');
  });

  it('explicit values override defaults', async () => {
    mocks.requestRepo.createApprovalRequest.mockRejectedValue(new Error('stop here'));
    await post(
      '',
      create({
        redaction_level: 'raw',
        reuse_scope: 'case',
        partial_access_allowed: true,
        expires_at: 4102444800000,
        reference: { system: 'jira', id: 'T-1' },
        reason_note: 'n',
      })
    );
    const call = mocks.requestRepo.createApprovalRequest.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(call).toMatchObject({
      redaction_level: 'raw',
      reuse_scope: 'case',
      partial_access_allowed: true,
      expires_at: 4102444800000,
      reason_note: 'n',
      reference: { system: 'jira', id: 'T-1' },
    });
  });
});

describe('zod pins: decision / cancel / revoke / subject-token / artifact-issue bodies', () => {
  const steps = '/req-1/steps/step-1';

  it.each(['approve', 'deny', 'remind', 'resend'])(
    'ApprovalDecisionBodySchema on steps/:id/%s',
    async (action) => {
      const run = (body: unknown) => post(`${steps}/${action}`, body);
      expect(await run(null)).toEqual(invalid('body', 'Expected object, received null'));
      expect(await run({ method: 'fax' })).toEqual(
        invalid('method', `Invalid enum value. Expected ${METHODS}, received 'fax'`)
      );
      expect(await run({ transport_channel: '' })).toEqual(
        invalid('transport_channel', 'String must contain at least 1 character(s)')
      );
      expect(await run({ reason_code: 5 })).toEqual(
        invalid('reason_code', 'Expected string, received number')
      );
      expect(await run({ transport_summary: { provider: '' } })).toEqual(
        invalid('transport_summary.provider', 'String must contain at least 1 character(s)')
      );
      expect(await run({ transport_detail: { response: 'x' } })).toEqual(
        invalid('transport_detail.response', 'Expected object, received string')
      );
      expect(await run({ transport_detail: { metadata: [] } })).toEqual(
        invalid('transport_detail.metadata', 'Expected object, received array')
      );
      // accepted (all optional; nullable records; unknown keys stripped)
      expect(await run({})).toEqual(ACCEPTED);
      expect(
        await run({
          method: 'portal_confirm',
          reason_note: 'n',
          transport_detail: { request: null, response: {}, metadata: { a: 1 } },
          extra: 1,
        })
      ).toEqual(ACCEPTED);
    }
  );

  it('ApprovalCancelBodySchema on /:id/cancel', async () => {
    const run = (body: unknown) => post('/req-1/cancel', body);
    expect(await run(null)).toEqual(invalid('body', 'Expected object, received null'));
    expect(await run({ reason_code: '' })).toEqual(
      invalid('reason_code', 'String must contain at least 1 character(s)')
    );
    expect(await run({ reason_note: 5 })).toEqual(
      invalid('reason_note', 'Expected string, received number')
    );
    expect(await run({})).toEqual(ACCEPTED);
    expect(await run({ reason_code: 'r', extra: true })).toEqual(ACCEPTED);
  });

  it('ApprovalGrantRevokeSchema on grants/:id/revoke: a malformed JSON body falls back to {}', async () => {
    const run = (body: unknown, raw?: string) => post('/req-1/grants/grant-1/revoke', body, raw);
    expect(await run(undefined, '{oops')).toEqual(ACCEPTED);
    expect(await run({})).toEqual(ACCEPTED);
    expect(await run(null)).toEqual(invalid('body', 'Expected object, received null'));
    expect(await run({ reason_code: '' })).toEqual(
      invalid('reason_code', 'String must contain at least 1 character(s)')
    );
  });

  it('ApprovalGrantSubjectTokenSchema on grants/:id/subject-token (client_id, expires_in 60..1800)', async () => {
    const run = (body: unknown) => post('/req-1/grants/grant-1/subject-token', body);
    expect(await run({})).toEqual(invalid('client_id', 'Required'));
    expect(await run({ client_id: '' })).toEqual(
      invalid('client_id', 'String must contain at least 1 character(s)')
    );
    expect(await run({ client_id: 'c', expires_in: 59 })).toEqual(
      invalid('expires_in', 'Number must be greater than or equal to 60')
    );
    expect(await run({ client_id: 'c', expires_in: 1801 })).toEqual(
      invalid('expires_in', 'Number must be less than or equal to 1800')
    );
    expect(await run({ client_id: 'c', expires_in: 60.5 })).toEqual(
      invalid('expires_in', 'Expected integer, received float')
    );
    expect(await run({ client_id: 'c', expires_in: '300' })).toEqual(
      invalid('expires_in', 'Expected number, received string')
    );
    expect(await run({ client_id: 'c', expires_in: 60 })).toEqual(ACCEPTED);
    expect(await run({ client_id: 'c', expires_in: 1800, extra: 1 })).toEqual(ACCEPTED);
    expect(await run({ client_id: 'c' })).toEqual(ACCEPTED);
  });

  it('ApprovalArtifactIssueSchema on steps/:id/artifacts (expires_in_seconds 60..3600)', async () => {
    const run = (body: unknown) => post(`${steps}/artifacts`, body);
    expect(await run(null)).toEqual(invalid('body', 'Expected object, received null'));
    expect(await run({ method: 'fax' })).toEqual(
      invalid('method', `Invalid enum value. Expected ${METHODS}, received 'fax'`)
    );
    expect(await run({ transport_channel: '' })).toEqual(
      invalid('transport_channel', 'String must contain at least 1 character(s)')
    );
    expect(await run({ expires_in_seconds: 59 })).toEqual(
      invalid('expires_in_seconds', 'Number must be greater than or equal to 60')
    );
    expect(await run({ expires_in_seconds: 3601 })).toEqual(
      invalid('expires_in_seconds', 'Number must be less than or equal to 3600')
    );
    expect(await run({ expires_in_seconds: 90.5 })).toEqual(
      invalid('expires_in_seconds', 'Expected integer, received float')
    );
    expect(await run({})).toEqual(ACCEPTED);
    expect(await run({ expires_in_seconds: 3600, method: 'ciba' })).toEqual(ACCEPTED);
  });
});
