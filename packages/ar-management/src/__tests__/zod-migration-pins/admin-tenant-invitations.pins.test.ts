/**
 * zod 3 -> 4 migration pins for admin-tenant-invitations.ts (CreateInvitationSchema).
 *
 * The handler returns `parsed.error.flatten()` verbatim, so the whole `details` object is pinned.
 * `createErrorResponse` is mocked (status from the real implementation, body `{ error, ...options }`).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const mocks = vi.hoisted(() => ({
  queryOne: vi.fn(),
  execute: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    createAuthContextFromHono: () => ({
      coreAdapter: { queryOne: mocks.queryOne, query: vi.fn(), execute: mocks.execute },
    }),
    createAuditLogFromContext: vi.fn(),
    produceNotificationDelivery: vi.fn(async () => ({ delivery: 'delivered' })),
    getLogger: () => ({ module: () => ({ warn: vi.fn(), error: vi.fn() }) }),
    createErrorResponse: vi.fn(
      async (...[c, code, options]: Parameters<typeof actual.createErrorResponse>) => {
        const real = await actual.createErrorResponse(c, code, options);
        return Response.json({ error: code, ...options }, { status: real.status });
      }
    ),
  };
});

vi.mock('../../single-tenant-guard', () => ({ ensureSupportedTenantId: vi.fn(async () => null) }));
vi.mock('../../admin-tenant-access', () => ({
  requireTenantResourceAccess: vi.fn(async () => null),
}));
vi.mock('../../request-issuer', () => ({
  getCanonicalTenantBaseUrl: (_env: unknown, tenantId: string) =>
    `https://${tenantId}.example.test`,
}));
vi.mock('../../tenant-alias-directory', () => ({
  resolveTenantDiscoveryAliasDirectoryInput: vi.fn(
    async (_env: unknown, input: Record<string, unknown>) => ({
      ...input,
      routeProjection: {},
    })
  ),
  prepareTenantDiscoveryAliasDirectory: vi.fn(async () => undefined),
  ensureActiveTenantDiscoveryAliasDirectory: vi.fn(async () => undefined),
  disableTenantDiscoveryAliasDirectory: vi.fn(async () => undefined),
}));

import { createTenantInvitationHandler } from '../../admin-tenant-invitations';

const NOW_MS = Date.UTC(2026, 6, 1, 0, 0, 0);
const NOW = NOW_MS / 1000;

function app() {
  const instance = new Hono();
  instance.post('/tenants/:id/invitations', createTenantInvitationHandler as never);
  return instance;
}

async function post(rawBody: string) {
  const response = await app().request('/tenants/tenant-a/invitations', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: rawBody,
  });
  return { status: response.status, body: await response.json<Record<string, unknown>>() };
}

const postJson = (value: unknown) => post(JSON.stringify(value));

/** `details` of a 400 `invalid_request` response */
async function details(value: unknown) {
  const result = await postJson(value);
  expect(result.status).toBe(400);
  expect((result.body as { error: string }).error).toBe('invalid_request');
  return (result.body as { details: unknown }).details;
}

describe('zod pins: CreateInvitationSchema (flatten body)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    mocks.execute.mockResolvedValue({ rowsAffected: 1 });
    mocks.queryOne.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM tenants')) return { id: 'tenant-a', name: 'Tenant A' };
      if (sql.includes('FROM roles')) return { id: 'role-a' };
      if (sql.includes('FROM organizations')) return { id: 'org-a' };
      return null;
    });
  });

  it('non-object roots', async () => {
    const root = (message: string) => ({ formErrors: [message], fieldErrors: {} });
    expect(await details(null)).toEqual(root('Expected object, received null'));
    expect(await details([])).toEqual(root('Expected object, received array'));
    expect(await details('x')).toEqual(root('Expected object, received string'));
    expect(await details(1)).toEqual(root('Expected object, received number'));
    expect(await details(true)).toEqual(root('Expected object, received boolean'));
  });

  it('malformed JSON is a thrown error -> 500 internal error body', async () => {
    expect(await post('{not json')).toEqual({
      status: 500,
      body: { error: 'AR900001' },
    });
  });

  it('single-field type / range / format issues', async () => {
    expect(await details({ invited_email: 'nope' })).toEqual({
      formErrors: [],
      fieldErrors: { invited_email: ['Invalid email'] },
    });
    expect(await details({ invited_email: 5 })).toEqual({
      formErrors: [],
      fieldErrors: { invited_email: ['Expected string, received number'] },
    });
    expect(await details({ role_id: '' })).toEqual({
      formErrors: [],
      fieldErrors: { role_id: ['String must contain at least 1 character(s)'] },
    });
    expect(await details({ org_id: 'x'.repeat(64) })).toEqual({
      formErrors: [],
      fieldErrors: { org_id: ['String must contain at most 63 character(s)'] },
    });
    expect(await details({ role_id: 1 })).toEqual({
      formErrors: [],
      fieldErrors: { role_id: ['Expected string, received number'] },
    });
    expect(await details({ max_uses: 1.5 })).toEqual({
      formErrors: [],
      fieldErrors: { max_uses: ['Expected integer, received float'] },
    });
    expect(await details({ max_uses: -2 })).toEqual({
      formErrors: [],
      fieldErrors: { max_uses: ['Number must be greater than or equal to -1'] },
    });
    expect(await details({ max_uses: 1001 })).toEqual({
      formErrors: [],
      fieldErrors: { max_uses: ['Number must be less than or equal to 1000'] },
    });
    expect(await details({ max_uses: '5' })).toEqual({
      formErrors: [],
      fieldErrors: { max_uses: ['Expected number, received string'] },
    });
    expect(await details({ max_uses: null })).toEqual({
      formErrors: [],
      fieldErrors: { max_uses: ['Expected number, received null'] },
    });
    expect(await details({ expires_in_hours: 0 })).toEqual({
      formErrors: [],
      fieldErrors: { expires_in_hours: ['Number must be greater than or equal to 1'] },
    });
    expect(await details({ expires_in_hours: 721 })).toEqual({
      formErrors: [],
      fieldErrors: { expires_in_hours: ['Number must be less than or equal to 720'] },
    });
    expect(await details({ expires_in_hours: 2.5 })).toEqual({
      formErrors: [],
      fieldErrors: { expires_in_hours: ['Expected integer, received float'] },
    });
    expect(await details({ expires_in_hours: null })).toEqual({
      formErrors: [],
      fieldErrors: { expires_in_hours: ['Expected number, received null'] },
    });
  });

  it('multiple simultaneous issues keep per-field arrays and field key order', async () => {
    expect(
      await details({
        expires_in_hours: 'soon',
        max_uses: 5000.5,
        invited_email: 'bad',
        role_id: '',
        org_id: 7,
      })
    ).toEqual({
      formErrors: [],
      fieldErrors: {
        expires_in_hours: ['Expected number, received string'],
        // zod 4: a non-integer stops at the integer check, so the range message no longer follows.
        max_uses: ['Expected integer, received float'],
        invited_email: ['Invalid email'],
        role_id: ['String must contain at least 1 character(s)'],
        org_id: ['Expected string, received number'],
      },
    });
    // key order of fieldErrors follows the schema/issue order, not the input order
    const d = (await details({
      org_id: 7,
      invited_email: 'bad',
      max_uses: 'x',
    })) as { fieldErrors: Record<string, string[]> };
    expect(Object.keys(d.fieldErrors)).toEqual(['invited_email', 'org_id', 'max_uses']);
  });

  it('non-integer AND out-of-range number reports only the integer check', async () => {
    // zod 3 listed both checks; zod 4: a non-integer stops at the integer check, so the range message no longer follows.
    expect(await details({ max_uses: 1000.5 })).toEqual({
      formErrors: [],
      fieldErrors: { max_uses: ['Expected integer, received float'] },
    });
    expect(await details({ max_uses: -1.5 })).toEqual({
      formErrors: [],
      fieldErrors: { max_uses: ['Expected integer, received float'] },
    });
  });

  it('email validation edge cases (status per value)', async () => {
    const emails = [
      'a@b.co',
      'a@b',
      'a@b.c',
      'user+tag@example.com',
      "o'brien@example.com",
      'a..b@example.com',
      '.a@example.com',
      'a@-b.com',
      'a@b..com',
      'a b@example.com',
      'ユーザー@example.com',
      'a@例え.jp',
      'a@[127.0.0.1]',
      '"quoted"@example.com',
      '',
      ' a@b.co',
    ];
    const statuses: Record<string, number> = {};
    for (const invited_email of emails) {
      statuses[invited_email] = (await postJson({ invited_email })).status;
    }
    expect(statuses).toEqual({
      'a@b.co': 201,
      'a@b': 400,
      'a@b.c': 400,
      'user+tag@example.com': 201,
      "o'brien@example.com": 201,
      'a..b@example.com': 400,
      '.a@example.com': 400,
      'a@-b.com': 400,
      'a@b..com': 400,
      'a b@example.com': 400,
      'ユーザー@example.com': 400,
      'a@例え.jp': 400,
      'a@[127.0.0.1]': 400,
      '"quoted"@example.com': 400,
      '': 400,
      ' a@b.co': 400,
    });
  });

  it('accepted shapes: empty object applies defaults max_uses=1 and expires_in_hours=72', async () => {
    const result = await postJson({});
    expect(result.status).toBe(201);
    expect(result.body).toEqual({
      id: expect.any(String) as unknown,
      invite_url: expect.stringMatching(
        /^https:\/\/tenant-a\.example\.test\/discover\?invite_token=[0-9a-f]{64}$/
      ) as unknown,
      token: expect.stringMatching(/^[0-9a-f]{64}$/) as unknown,
      expires_at: NOW + 72 * 3600,
      email_sent: false,
    });
    const params = mocks.execute.mock.calls[0]?.[1] as unknown[];
    // [id, token, tenant, invited_email, invited_by, role_id, org_id, max_uses, expires_at, now, now]
    expect(params.slice(2)).toEqual([
      'tenant-a',
      null,
      'unknown',
      null,
      null,
      1,
      NOW + 72 * 3600,
      NOW,
      NOW,
    ]);
  });

  it('accepted shapes: nullable/optional fields, boundaries, unknown keys stripped', async () => {
    const result = await postJson({
      invited_email: null,
      role_id: null,
      org_id: null,
      max_uses: -1,
      expires_in_hours: 720,
      extra_key: 'ignored',
    });
    expect(result.status).toBe(201);
    expect(result.body.expires_at).toBe(NOW + 720 * 3600);
    expect((mocks.execute.mock.calls[0]?.[1] as unknown[]).slice(3)).toEqual([
      null,
      'unknown',
      null,
      null,
      -1,
      NOW + 720 * 3600,
      NOW,
      NOW,
    ]);

    mocks.execute.mockClear();
    expect(
      (await postJson({ max_uses: 0, expires_in_hours: 1, invited_email: 'a@b.co' })).status
    ).toBe(201);
    expect((await postJson({ max_uses: 1000, role_id: 'r'.repeat(63), org_id: 'o' })).status).toBe(
      201
    );
  });
});
