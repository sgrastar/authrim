import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  adapter: {
    queryOne: vi.fn(),
    query: vi.fn(),
    execute: vi.fn(),
  },
  evaluate: vi.fn(),
  testRule: vi.fn(),
  getSecret: vi.fn(),
  hashDomain: vi.fn(),
  logger: { error: vi.fn() },
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getLogger: vi.fn(() => ({ module: vi.fn(() => mocks.logger) })),
    createRuleEvaluator: vi.fn(() => ({ evaluate: mocks.evaluate })),
    testRuleAgainstContext: mocks.testRule,
    getEmailDomainHashSecret: mocks.getSecret,
    generateEmailDomainHash: mocks.hashDomain,
  };
});

vi.mock('../routes/settings/tenant-resolver', () => ({
  resolveSettingsTenantId: vi.fn(() => 'tenant-a'),
  resolveSettingsCoreAdapter: vi.fn(() => mocks.adapter),
}));

import {
  createRoleAssignmentRule,
  deleteRoleAssignmentRule,
  evaluateRoleAssignmentRules,
  getRoleAssignmentRule,
  listRoleAssignmentRules,
  testRoleAssignmentRule,
  updateRoleAssignmentRule,
} from '../routes/settings/role-assignment-rules';

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'rar_rule1',
    tenant_id: 'tenant-a',
    name: 'Engineering users',
    description: null,
    role_id: 'role-engineer',
    scope_type: 'global',
    scope_target: '',
    conditions_json: JSON.stringify({ field: 'provider_id', operator: 'eq', value: 'corp' }),
    actions_json: JSON.stringify([{ type: 'assign_role', role_id: 'role-engineer' }]),
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
  } = {}
) {
  const cacheDelete = options.cacheDelete ?? vi.fn().mockResolvedValue(undefined);
  const query = options.query ?? {};
  return {
    req: {
      json: vi.fn().mockResolvedValue(options.body ?? {}),
      param: vi.fn((name: string) => (name === 'id' ? (options.id ?? 'rar_rule1') : undefined)),
      query: vi.fn((name: string) => query[name]),
    },
    env: { SETTINGS: { delete: cacheDelete } },
    json: vi.fn((value: unknown, status = 200) => Response.json(value, { status })),
  } as never;
}

const validInput = {
  name: 'Engineering users',
  role_id: 'role-engineer',
  condition: { field: 'provider_id', operator: 'eq', value: 'corp' },
  actions: [{ type: 'assign_role', role_id: 'role-engineer' }],
};

describe('role assignment rules settings API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.adapter.queryOne.mockResolvedValue(null);
    mocks.adapter.query.mockResolvedValue([]);
    mocks.adapter.execute.mockResolvedValue({ success: true, rowsAffected: 1 });
    mocks.getSecret.mockResolvedValue('domain-hash-secret');
    mocks.hashDomain.mockResolvedValue('hashed-domain');
    mocks.testRule.mockReturnValue({ matched: true, actions: validInput.actions });
    mocks.evaluate.mockResolvedValue({
      matched_rules: ['rar_rule1'],
      roles_to_assign: ['role-engineer'],
      orgs_to_join: [],
      attributes_to_set: { department: 'engineering' },
      denied: false,
    });
  });

  describe('create', () => {
    it.each([
      [{ ...validInput, name: '' }, 'name is required'],
      [{ ...validInput, role_id: ' ' }, 'role_id is required'],
      [{ ...validInput, condition: undefined }, 'condition is required'],
      [{ ...validInput, actions: [] }, 'actions is required'],
      [{ ...validInput, actions: null }, 'actions is required'],
    ])('rejects invalid rule input %#', async (body, message) => {
      const response = await createRoleAssignmentRule(context({ body }));

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: 'invalid_request',
        error_description: expect.stringContaining(message),
      });
      expect(mocks.adapter.queryOne).not.toHaveBeenCalled();
    });

    it('rejects duplicate names within the tenant', async () => {
      mocks.adapter.queryOne.mockResolvedValueOnce({ id: 'existing' });

      const response = await createRoleAssignmentRule(context({ body: validInput }));

      expect(response.status).toBe(409);
      expect(mocks.adapter.execute).not.toHaveBeenCalled();
    });

    it('creates a tenant-scoped active rule with safe defaults', async () => {
      const cacheDelete = vi.fn().mockResolvedValue(undefined);
      const c = context({ body: validInput, cacheDelete });
      const response = await createRoleAssignmentRule(c);
      const body = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(201);
      expect(body).toMatchObject({
        tenant_id: 'tenant-a',
        name: 'Engineering users',
        scope_type: 'global',
        scope_target: '',
        priority: 0,
        is_active: true,
        stop_processing: false,
      });
      expect(mocks.adapter.execute).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO role_assignment_rules'),
        expect.arrayContaining(['tenant-a', 'Engineering users', 'role-engineer'])
      );
      expect(cacheDelete).toHaveBeenCalledWith('role_assignment_rules_cache:tenant-a');
    });

    it('preserves explicit optional policy fields and tolerates cache invalidation failure', async () => {
      const cacheDelete = vi.fn().mockRejectedValue(new Error('KV unavailable'));
      const body = {
        ...validInput,
        description: 'Corporate engineering access',
        scope_type: 'organization',
        scope_target: 'org-1',
        priority: 20,
        is_active: false,
        stop_processing: true,
        valid_from: 100,
        valid_until: 200,
      };

      const response = await createRoleAssignmentRule(context({ body, cacheDelete }));

      expect(response.status).toBe(201);
      await expect(response.json()).resolves.toMatchObject({
        description: 'Corporate engineering access',
        scope_type: 'organization',
        scope_target: 'org-1',
        priority: 20,
        is_active: false,
        stop_processing: true,
        valid_from: 100,
        valid_until: 200,
      });
    });

    it('returns a stable server error when persistence fails', async () => {
      mocks.adapter.queryOne.mockRejectedValueOnce(new Error('D1 unavailable'));

      const response = await createRoleAssignmentRule(context({ body: validInput }));

      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toMatchObject({ error: 'server_error' });
      expect(mocks.logger.error).toHaveBeenCalledWith('Create error', {}, expect.any(Error));
    });
  });

  describe('read', () => {
    it('lists active rules with bounded pagination and converts stored JSON', async () => {
      mocks.adapter.queryOne.mockResolvedValueOnce({ count: 1 });
      mocks.adapter.query.mockResolvedValueOnce([
        row({
          description: 'Description',
          stop_processing: 1,
          valid_from: 100,
          valid_until: 200,
          created_by: 'admin-1',
        }),
      ]);

      const response = await listRoleAssignmentRules(
        context({ query: { limit: '500', offset: '10', is_active: 'true' } })
      );
      const body = (await response.json()) as { rules: Array<Record<string, unknown>> };

      expect(response.status).toBe(200);
      expect(body).toMatchObject({ total: 1, limit: 100, offset: 10 });
      expect(body.rules[0]).toMatchObject({
        description: 'Description',
        stop_processing: true,
        valid_from: 100,
        valid_until: 200,
        created_by: 'admin-1',
        condition: expect.any(Object),
        actions: expect.any(Array),
      });
      expect(mocks.adapter.query).toHaveBeenCalledWith(
        expect.stringContaining('AND is_active = ?'),
        ['tenant-a', 1, 100, 10]
      );
    });

    it('uses defaults and treats a missing count as zero', async () => {
      const response = await listRoleAssignmentRules(context());

      await expect(response.json()).resolves.toMatchObject({ total: 0, limit: 50, offset: 0 });
    });

    it('maps is_active=false to the inactive database flag', async () => {
      await listRoleAssignmentRules(context({ query: { is_active: 'false' } }));

      expect(mocks.adapter.queryOne).toHaveBeenCalledWith(expect.any(String), ['tenant-a', 0]);
    });

    it('returns server_error when listing fails', async () => {
      mocks.adapter.queryOne.mockRejectedValueOnce(new Error('query failed'));
      const response = await listRoleAssignmentRules(context());
      expect(response.status).toBe(500);
    });

    it('returns a tenant-scoped rule and omits nullable optional fields', async () => {
      mocks.adapter.queryOne.mockResolvedValueOnce(row());
      const response = await getRoleAssignmentRule(context());
      await expect(response.json()).resolves.toMatchObject({
        id: 'rar_rule1',
        tenant_id: 'tenant-a',
      });
      expect(mocks.adapter.queryOne).toHaveBeenCalledWith(
        expect.stringContaining('tenant_id = ?'),
        ['rar_rule1', 'tenant-a']
      );
    });

    it('returns not_found rather than leaking another tenant rule', async () => {
      const response = await getRoleAssignmentRule(context({ id: 'rar_other' }));
      expect(response.status).toBe(404);
    });

    it('returns server_error when a single-rule lookup fails', async () => {
      mocks.adapter.queryOne.mockRejectedValueOnce(new Error('query failed'));
      const response = await getRoleAssignmentRule(context());
      expect(response.status).toBe(500);
    });
  });

  describe('update and delete', () => {
    it('returns not_found for an update outside the tenant', async () => {
      const response = await updateRoleAssignmentRule(context({ body: { name: 'New' } }));
      expect(response.status).toBe(404);
      expect(mocks.adapter.execute).not.toHaveBeenCalled();
    });

    it('returns the existing contract when no fields change', async () => {
      mocks.adapter.queryOne.mockResolvedValueOnce(row());
      const response = await updateRoleAssignmentRule(context({ body: {} }));
      expect(response.status).toBe(200);
      expect(mocks.adapter.execute).not.toHaveBeenCalled();
    });

    it('updates every supported policy field and invalidates its tenant cache', async () => {
      mocks.adapter.queryOne
        .mockResolvedValueOnce(row())
        .mockResolvedValueOnce(row({ name: 'Updated', is_active: 0, stop_processing: 1 }));
      const cacheDelete = vi.fn().mockResolvedValue(undefined);
      const c = context({
        cacheDelete,
        body: {
          name: 'Updated',
          description: 'Updated description',
          role_id: 'role-new',
          scope_type: 'organization',
          scope_target: 'org-2',
          condition: { field: 'email_verified', operator: 'eq', value: true },
          actions: [{ type: 'assign_role', role_id: 'role-new' }],
          priority: 50,
          is_active: false,
          stop_processing: true,
          valid_from: 300,
          valid_until: 400,
        },
      });

      const response = await updateRoleAssignmentRule(c);

      expect(response.status).toBe(200);
      expect(mocks.adapter.execute).toHaveBeenCalledWith(
        expect.stringContaining('name = ?'),
        expect.arrayContaining(['Updated', 'role-new', 50, 0, 1, 'rar_rule1', 'tenant-a'])
      );
      expect(cacheDelete).toHaveBeenCalledWith('role_assignment_rules_cache:tenant-a');
    });

    it('tolerates update cache failure after durable persistence', async () => {
      mocks.adapter.queryOne.mockResolvedValue(row());
      const response = await updateRoleAssignmentRule(
        context({ body: { name: 'Updated' }, cacheDelete: vi.fn().mockRejectedValue('KV down') })
      );
      expect(response.status).toBe(200);
    });

    it('returns server_error for update failures', async () => {
      mocks.adapter.queryOne.mockRejectedValueOnce(new Error('query failed'));
      const response = await updateRoleAssignmentRule(context({ body: { name: 'Updated' } }));
      expect(response.status).toBe(500);
    });

    it('returns not_found when no tenant-scoped row is deleted', async () => {
      mocks.adapter.execute.mockResolvedValueOnce({ rowsAffected: 0 });
      const response = await deleteRoleAssignmentRule(context());
      expect(response.status).toBe(404);
    });

    it('deletes a rule and tolerates cache invalidation failure', async () => {
      const response = await deleteRoleAssignmentRule(
        context({ cacheDelete: vi.fn().mockRejectedValue(new Error('KV unavailable')) })
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ success: true });
    });

    it('returns server_error for delete failures', async () => {
      mocks.adapter.execute.mockRejectedValueOnce(new Error('delete failed'));
      const response = await deleteRoleAssignmentRule(context());
      expect(response.status).toBe(500);
    });
  });

  describe('evaluation', () => {
    it('returns not_found when testing a rule outside the tenant', async () => {
      const response = await testRoleAssignmentRule(context({ body: { context: {} } }));
      expect(response.status).toBe(404);
      expect(mocks.testRule).not.toHaveBeenCalled();
    });

    it('hashes a valid email domain and passes normalized context to the evaluator', async () => {
      mocks.adapter.queryOne.mockResolvedValueOnce(row());
      const response = await testRoleAssignmentRule(
        context({
          body: {
            context: {
              email: 'person@example.com',
              email_verified: true,
              provider_id: 'corp',
              idp_claims: { department: 'engineering' },
              user_type: 'employee',
            },
          },
        })
      );

      expect(response.status).toBe(200);
      expect(mocks.hashDomain).toHaveBeenCalledWith('person@example.com', 'domain-hash-secret');
      expect(mocks.testRule).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'rar_rule1' }),
        expect.objectContaining({
          email_domain_hash: 'hashed-domain',
          email_verified: true,
          provider_id: 'corp',
          idp_claims: { department: 'engineering' },
          user_type: 'employee',
          tenant_id: 'tenant-a',
        })
      );
    });

    it('uses privacy-safe defaults and continues when the hash secret is unavailable', async () => {
      mocks.adapter.queryOne.mockResolvedValueOnce(row());
      mocks.getSecret.mockRejectedValueOnce(new Error('missing secret'));

      const response = await testRoleAssignmentRule(
        context({ body: { context: { email: 'person@example.com' } } })
      );

      expect(response.status).toBe(200);
      expect(mocks.testRule).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          email_domain_hash: undefined,
          email_verified: false,
          idp_claims: {},
          provider_id: '',
        })
      );
    });

    it('does not hash malformed email identifiers', async () => {
      mocks.adapter.queryOne.mockResolvedValueOnce(row());
      await testRoleAssignmentRule(context({ body: { context: { email: 'not-an-email' } } }));
      expect(mocks.getSecret).not.toHaveBeenCalled();
    });

    it('returns server_error when single-rule evaluation fails', async () => {
      mocks.adapter.queryOne.mockRejectedValueOnce(new Error('query failed'));
      const response = await testRoleAssignmentRule(context({ body: { context: {} } }));
      expect(response.status).toBe(500);
    });

    it('maps aggregate evaluation results without losing deny information', async () => {
      mocks.evaluate.mockResolvedValueOnce({
        matched_rules: ['deny-rule'],
        roles_to_assign: [],
        orgs_to_join: [],
        attributes_to_set: {},
        denied: true,
        deny_code: 'account_blocked',
        deny_description: 'Account is blocked by policy',
      });
      const response = await evaluateRoleAssignmentRules(
        context({ body: { context: { email_verified: true } } })
      );

      await expect(response.json()).resolves.toEqual({
        matched_rules: ['deny-rule'],
        final_roles: [],
        final_orgs: [],
        attributes_to_set: {},
        denied: true,
        deny_code: 'account_blocked',
        deny_description: 'Account is blocked by policy',
      });
    });

    it('hashes email for aggregate evaluation and applies missing-field defaults', async () => {
      await evaluateRoleAssignmentRules(
        context({ body: { context: { email: 'person@example.com' } } })
      );
      expect(mocks.evaluate).toHaveBeenCalledWith(
        expect.objectContaining({
          email_domain_hash: 'hashed-domain',
          email_verified: false,
          idp_claims: {},
          provider_id: '',
          tenant_id: 'tenant-a',
        })
      );
    });

    it('continues aggregate evaluation without a domain hash when secret lookup fails', async () => {
      mocks.getSecret.mockRejectedValueOnce(new Error('missing secret'));
      const response = await evaluateRoleAssignmentRules(
        context({ body: { context: { email: 'person@example.com' } } })
      );
      expect(response.status).toBe(200);
      expect(mocks.evaluate).toHaveBeenCalledWith(
        expect.objectContaining({ email_domain_hash: undefined })
      );
    });

    it('returns server_error when aggregate evaluation fails', async () => {
      mocks.evaluate.mockRejectedValueOnce(new Error('evaluation failed'));
      const response = await evaluateRoleAssignmentRules(context({ body: { context: {} } }));
      expect(response.status).toBe(500);
    });
  });
});
