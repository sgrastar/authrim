import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  adapter: { queryOne: vi.fn(), query: vi.fn(), execute: vi.fn() },
  evaluate: vi.fn(),
  testRule: vi.fn(),
  logger: { warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getLogger: vi.fn(() => ({ module: vi.fn(() => mocks.logger) })),
    createTokenClaimEvaluator: vi.fn(() => ({ evaluate: mocks.evaluate })),
    testTokenClaimRule: mocks.testRule,
  };
});

vi.mock('../routes/settings/tenant-resolver', () => ({
  resolveSettingsTenantId: vi.fn(() => 'tenant-a'),
  resolveSettingsCoreAdapter: vi.fn(() => mocks.adapter),
}));

import {
  createTokenClaimRule,
  deleteTokenClaimRule,
  evaluateTokenClaimRules,
  getTokenClaimRule,
  listTokenClaimRules,
  testTokenClaimRuleHandler,
  updateTokenClaimRule,
} from '../routes/settings/token-claim-rules';

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tcr_rule1',
    tenant_id: 'tenant-a',
    name: 'Department claim',
    description: null,
    token_type: 'access',
    conditions_json: JSON.stringify({ field: 'scope', operator: 'contains', value: 'profile' }),
    actions_json: JSON.stringify([
      { claim_name: 'department', source: 'static', value: 'engineering' },
    ]),
    priority: 10,
    is_active: 1,
    stop_processing: 0,
    valid_from: null,
    valid_until: null,
    created_by: null,
    created_at: 100,
    updated_at: 100,
    ...overrides,
  };
}

function context(
  options: {
    body?: unknown;
    id?: string;
    query?: Record<string, string | undefined>;
    cacheDelete?: ReturnType<typeof vi.fn>;
    withSettings?: boolean;
  } = {}
) {
  const cacheDelete = options.cacheDelete ?? vi.fn().mockResolvedValue(undefined);
  const query = options.query ?? {};
  return {
    req: {
      json: vi.fn().mockResolvedValue(options.body ?? {}),
      param: vi.fn((name: string) => (name === 'id' ? (options.id ?? 'tcr_rule1') : undefined)),
      query: vi.fn((name: string) => query[name]),
    },
    env: options.withSettings === false ? {} : { SETTINGS: { delete: cacheDelete } },
    json: vi.fn((value: unknown, status = 200) => Response.json(value, { status })),
  } as never;
}

const validInput = {
  name: 'Department claim',
  condition: { field: 'scope', operator: 'contains', value: 'profile' },
  actions: [{ claim_name: 'department', source: 'static', value: 'engineering' }],
};

describe('token claim rules settings API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.adapter.queryOne.mockResolvedValue(null);
    mocks.adapter.query.mockResolvedValue([]);
    mocks.adapter.execute.mockResolvedValue({ success: true, rowsAffected: 1 });
    mocks.testRule.mockReturnValue({ matched: true, claims: { department: 'engineering' } });
    mocks.evaluate.mockResolvedValue({
      matched_rules: ['tcr_rule1'],
      claims_to_add: { department: 'engineering' },
      claim_overrides: [],
      truncated: false,
    });
  });

  describe('validation and creation', () => {
    it.each([
      [{ ...validInput, name: '' }, 'name is required'],
      [{ ...validInput, condition: undefined }, 'condition is required'],
      [{ ...validInput, actions: [] }, 'actions is required'],
      [{ ...validInput, actions: null }, 'actions is required'],
      [
        { ...validInput, actions: [{ source: 'static', value: 'x' }] },
        'Each action must have a claim_name',
      ],
      [
        { ...validInput, actions: [{ claim_name: 'sub', source: 'static', value: 'x' }] },
        'Cannot override reserved claim: sub',
      ],
    ])('rejects unsafe or incomplete claim rule %#', async (body, error) => {
      const response = await createTokenClaimRule(context({ body }));
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: 'invalid_request',
        error_description: expect.stringContaining(error),
      });
      expect(mocks.adapter.execute).not.toHaveBeenCalled();
    });

    it('warns about PII-shaped claims while allowing an explicitly configured custom claim', async () => {
      const response = await createTokenClaimRule(
        context({
          body: {
            ...validInput,
            actions: [{ claim_name: 'contact_email_hint', source: 'static', value: 'masked' }],
          },
        })
      );
      expect(response.status).toBe(201);
      expect(mocks.logger.warn).toHaveBeenCalledWith(
        'PII warnings',
        expect.objectContaining({ warnings: expect.stringContaining('may contain PII') })
      );
    });

    it('rejects duplicate names within a tenant', async () => {
      mocks.adapter.queryOne.mockResolvedValueOnce({ id: 'existing' });
      const response = await createTokenClaimRule(context({ body: validInput }));
      expect(response.status).toBe(409);
    });

    it('creates an active access-token rule with safe defaults and clears both caches', async () => {
      const cacheDelete = vi.fn().mockResolvedValue(undefined);
      const c = context({ body: validInput, cacheDelete });
      const response = await createTokenClaimRule(c);
      await expect(response.json()).resolves.toMatchObject({
        tenant_id: 'tenant-a',
        token_type: 'access',
        priority: 0,
        is_active: true,
        stop_processing: false,
      });
      expect(response.status).toBe(201);
      expect(cacheDelete).toHaveBeenCalledTimes(2);
    });

    it('preserves explicit lifecycle fields and tolerates KV invalidation failure', async () => {
      const response = await createTokenClaimRule(
        context({
          body: {
            ...validInput,
            description: 'ID token department',
            token_type: 'id',
            priority: 20,
            is_active: false,
            stop_processing: true,
            valid_from: 100,
            valid_until: 200,
          },
          cacheDelete: vi.fn().mockRejectedValue(new Error('KV unavailable')),
        })
      );
      expect(response.status).toBe(201);
      await expect(response.json()).resolves.toMatchObject({
        token_type: 'id',
        priority: 20,
        is_active: false,
        stop_processing: true,
      });
    });

    it('does not require a cache binding to durably create a rule', async () => {
      const response = await createTokenClaimRule(
        context({ body: validInput, withSettings: false })
      );
      expect(response.status).toBe(201);
    });

    it('returns server_error for database failures', async () => {
      mocks.adapter.queryOne.mockRejectedValueOnce(new Error('D1 unavailable'));
      const response = await createTokenClaimRule(context({ body: validInput }));
      expect(response.status).toBe(500);
    });
  });

  describe('tenant-scoped reads', () => {
    it('lists filtered rules with bounded pagination and JSON conversion', async () => {
      mocks.adapter.queryOne.mockResolvedValueOnce({ count: 1 });
      mocks.adapter.query.mockResolvedValueOnce([
        row({
          description: 'Description',
          token_type: 'both',
          stop_processing: 1,
          valid_from: 100,
          valid_until: 200,
          created_by: 'admin-1',
        }),
      ]);
      const response = await listTokenClaimRules(
        context({ query: { limit: '500', offset: '5', is_active: 'true', token_type: 'id' } })
      );
      const body = (await response.json()) as { rules: Array<Record<string, unknown>> };
      expect(body).toMatchObject({ total: 1, limit: 100, offset: 5 });
      expect(body.rules[0]).toMatchObject({
        token_type: 'both',
        stop_processing: true,
        description: 'Description',
        condition: expect.any(Object),
        actions: expect.any(Array),
      });
      expect(mocks.adapter.query).toHaveBeenCalledWith(expect.stringContaining('token_type = ?'), [
        'tenant-a',
        1,
        'id',
        'both',
        100,
        5,
      ]);
    });

    it('uses pagination defaults and missing count fallback', async () => {
      const response = await listTokenClaimRules(context());
      await expect(response.json()).resolves.toMatchObject({ total: 0, limit: 50, offset: 0 });
    });

    it('maps inactive filtering without a token-type filter', async () => {
      await listTokenClaimRules(context({ query: { is_active: 'false' } }));
      expect(mocks.adapter.queryOne).toHaveBeenCalledWith(expect.any(String), ['tenant-a', 0]);
    });

    it('returns server_error for list failures', async () => {
      mocks.adapter.queryOne.mockRejectedValueOnce(new Error('query failed'));
      expect((await listTokenClaimRules(context())).status).toBe(500);
    });

    it('returns one rule only from the current tenant', async () => {
      mocks.adapter.queryOne.mockResolvedValueOnce(row());
      const response = await getTokenClaimRule(context());
      expect(response.status).toBe(200);
      expect(mocks.adapter.queryOne).toHaveBeenCalledWith(
        expect.stringContaining('tenant_id = ?'),
        ['tcr_rule1', 'tenant-a']
      );
    });

    it('returns not_found for missing or cross-tenant IDs', async () => {
      expect((await getTokenClaimRule(context({ id: 'tcr_other' }))).status).toBe(404);
    });

    it('returns server_error for lookup failures', async () => {
      mocks.adapter.queryOne.mockRejectedValueOnce(new Error('query failed'));
      expect((await getTokenClaimRule(context())).status).toBe(500);
    });
  });

  describe('updates and deletion', () => {
    it('returns not_found before updating another tenant rule', async () => {
      expect((await updateTokenClaimRule(context({ body: { name: 'New' } }))).status).toBe(404);
    });

    it.each([
      [[{ source: 'static', value: 'x' }], 'claim_name'],
      [[{ claim_name: 'iss', source: 'static', value: 'x' }], 'reserved claim'],
    ])('revalidates replacement actions before update %#', async (actions, error) => {
      mocks.adapter.queryOne.mockResolvedValueOnce(row());
      const response = await updateTokenClaimRule(context({ body: { actions } }));
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error_description: expect.stringContaining(error),
      });
    });

    it('returns the current rule for an empty patch', async () => {
      mocks.adapter.queryOne.mockResolvedValueOnce(row());
      const response = await updateTokenClaimRule(context({ body: {} }));
      expect(response.status).toBe(200);
      expect(mocks.adapter.execute).not.toHaveBeenCalled();
    });

    it('updates every mutable field and clears both token-type caches', async () => {
      mocks.adapter.queryOne
        .mockResolvedValueOnce(row())
        .mockResolvedValueOnce(row({ name: 'Updated', token_type: 'both' }));
      const cacheDelete = vi.fn().mockResolvedValue(undefined);
      const c = context({
        cacheDelete,
        body: {
          name: 'Updated',
          description: 'Updated description',
          token_type: 'both',
          condition: { field: 'client_id', operator: 'eq', value: 'client-1' },
          actions: [{ claim_name: 'team', source: 'static', value: 'platform' }],
          priority: 50,
          is_active: false,
          stop_processing: true,
          valid_from: 300,
          valid_until: 400,
        },
      });
      const response = await updateTokenClaimRule(c);
      expect(response.status).toBe(200);
      expect(mocks.adapter.execute).toHaveBeenCalledWith(
        expect.stringContaining('token_type = ?'),
        expect.arrayContaining(['Updated', 'both', 50, 0, 1, 'tcr_rule1', 'tenant-a'])
      );
      expect(cacheDelete).toHaveBeenCalledTimes(2);
    });

    it('tolerates cache errors after a successful update', async () => {
      mocks.adapter.queryOne.mockResolvedValue(row());
      const response = await updateTokenClaimRule(
        context({ body: { name: 'Updated' }, cacheDelete: vi.fn().mockRejectedValue('KV down') })
      );
      expect(response.status).toBe(200);
    });

    it('returns server_error for update failures', async () => {
      mocks.adapter.queryOne.mockRejectedValueOnce(new Error('query failed'));
      expect((await updateTokenClaimRule(context({ body: { name: 'Updated' } }))).status).toBe(500);
    });

    it('returns not_found when deletion affects no tenant row', async () => {
      mocks.adapter.execute.mockResolvedValueOnce({ rowsAffected: 0 });
      expect((await deleteTokenClaimRule(context())).status).toBe(404);
    });

    it('deletes a rule and tolerates cache invalidation failure', async () => {
      const response = await deleteTokenClaimRule(
        context({ cacheDelete: vi.fn().mockRejectedValue(new Error('KV unavailable')) })
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ success: true });
    });

    it('deletes successfully without a cache binding', async () => {
      expect((await deleteTokenClaimRule(context({ withSettings: false }))).status).toBe(200);
    });

    it('returns server_error for delete failures', async () => {
      mocks.adapter.execute.mockRejectedValueOnce(new Error('delete failed'));
      expect((await deleteTokenClaimRule(context())).status).toBe(500);
    });
  });

  describe('evaluation contracts', () => {
    it('returns not_found when testing an inaccessible rule', async () => {
      const response = await testTokenClaimRuleHandler(context({ body: { context: {} } }));
      expect(response.status).toBe(404);
    });

    it('normalizes optional arrays and scope for a single-rule test', async () => {
      mocks.adapter.queryOne.mockResolvedValueOnce(row());
      const response = await testTokenClaimRuleHandler(
        context({ body: { context: { subject_id: 'user-1', client_id: 'client-1' } } })
      );
      expect(response.status).toBe(200);
      expect(mocks.testRule).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'tcr_rule1' }),
        expect.objectContaining({
          tenant_id: 'tenant-a',
          subject_id: 'user-1',
          client_id: 'client-1',
          scope: '',
          roles: [],
          permissions: [],
        })
      );
    });

    it('preserves all caller context fields in a single-rule test', async () => {
      mocks.adapter.queryOne.mockResolvedValueOnce(row());
      await testTokenClaimRuleHandler(
        context({
          body: {
            context: {
              subject_id: 'user-1',
              client_id: 'client-1',
              scope: 'openid profile',
              roles: ['member'],
              permissions: ['profile:read'],
              org_id: 'org-1',
              org_type: 'company',
              user_type: 'employee',
              idp_claims: { department: 'engineering' },
            },
          },
        })
      );
      expect(mocks.testRule).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({ org_id: 'org-1', user_type: 'employee' })
      );
    });

    it('returns server_error when a single-rule test fails', async () => {
      mocks.adapter.queryOne.mockRejectedValueOnce(new Error('query failed'));
      expect((await testTokenClaimRuleHandler(context({ body: { context: {} } }))).status).toBe(
        500
      );
    });

    it('maps aggregate claims and truncation evidence without loss', async () => {
      mocks.evaluate.mockResolvedValueOnce({
        matched_rules: ['tcr_rule1'],
        claims_to_add: { department: 'engineering' },
        claim_overrides: ['legacy_department'],
        truncated: true,
        truncation_reason: 'token_size_limit',
      });
      const response = await evaluateTokenClaimRules(
        context({
          body: { token_type: 'access', context: { subject_id: 'user-1', client_id: 'client-1' } },
        })
      );
      await expect(response.json()).resolves.toEqual({
        matched_rules: ['tcr_rule1'],
        claims_to_add: { department: 'engineering' },
        claim_overrides: ['legacy_department'],
        truncated: true,
        truncation_reason: 'token_size_limit',
      });
      expect(mocks.evaluate).toHaveBeenCalledWith(
        expect.objectContaining({ scope: '', roles: [], permissions: [] }),
        'access'
      );
    });

    it('passes all optional aggregate context fields to ID-token evaluation', async () => {
      await evaluateTokenClaimRules(
        context({
          body: {
            token_type: 'id',
            context: {
              subject_id: 'user-1',
              client_id: 'client-1',
              scope: 'openid',
              roles: ['member'],
              permissions: ['profile:read'],
              org_id: 'org-1',
              org_type: 'company',
              user_type: 'employee',
              idp_claims: { department: 'engineering' },
            },
          },
        })
      );
      expect(mocks.evaluate).toHaveBeenCalledWith(
        expect.objectContaining({ org_id: 'org-1', idp_claims: { department: 'engineering' } }),
        'id'
      );
    });

    it('returns server_error for aggregate evaluation failures', async () => {
      mocks.evaluate.mockRejectedValueOnce(new Error('evaluation failed'));
      expect(
        (await evaluateTokenClaimRules(context({ body: { token_type: 'access', context: {} } })))
          .status
      ).toBe(500);
    });
  });
});
