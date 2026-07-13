import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  adapter: { query: vi.fn(), execute: vi.fn() },
  validateVersion: vi.fn(),
  logger: { error: vi.fn() },
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getTenantIdFromContext: vi.fn(() => 'tenant-a'),
    createAuthContextFromHono: vi.fn(() => ({ coreAdapter: mocks.adapter })),
    validateVersionFormat: mocks.validateVersion,
    getLogger: vi.fn(() => ({ module: vi.fn(() => mocks.logger) })),
  };
});

import {
  adminClientTrustPoliciesListHandler,
  adminClientTrustPolicyUpsertHandler,
  adminConsentPoliciesListHandler,
  adminConsentPolicyCreateHandler,
  adminConsentPolicyDeleteHandler,
  adminConsentPolicyGetHandler,
  adminConsentPolicyItemsReplaceHandler,
  adminConsentPolicyUpdateHandler,
  adminSignInConfirmationPoliciesListHandler,
  adminSignInConfirmationPolicyUpsertHandler,
} from '../admin-consent-policies';

function context(body: unknown = {}, id = 'policy-1') {
  return {
    req: {
      json: vi.fn().mockResolvedValue(body),
      param: vi.fn((name: string) => (name === 'id' ? id : undefined)),
    },
    env: {},
    json: vi.fn((value: unknown, status = 200) => Response.json(value, { status })),
  } as never;
}

function queueQueries(...results: unknown[][]) {
  for (const result of results) mocks.adapter.query.mockResolvedValueOnce(result);
}

describe('admin consent policy APIs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.adapter.query.mockResolvedValue([]);
    mocks.adapter.execute.mockResolvedValue({ success: true, rowsAffected: 1 });
    mocks.validateVersion.mockReturnValue(true);
  });

  describe('policy CRUD', () => {
    it('lists only tenant-scoped policies', async () => {
      mocks.adapter.query.mockResolvedValueOnce([{ id: 'policy-1', item_count: 2 }]);
      const response = await adminConsentPoliciesListHandler(context());
      await expect(response.json()).resolves.toEqual({
        policies: [{ id: 'policy-1', item_count: 2 }],
      });
      expect(mocks.adapter.query).toHaveBeenCalledWith(expect.stringContaining('p.tenant_id = ?'), [
        'tenant-a',
      ]);
    });

    it('returns a stable list error', async () => {
      mocks.adapter.query.mockRejectedValueOnce(new Error('D1 unavailable'));
      expect((await adminConsentPoliciesListHandler(context())).status).toBe(500);
    });

    it('returns not_found for a cross-tenant or missing policy', async () => {
      expect((await adminConsentPolicyGetHandler(context())).status).toBe(404);
    });

    it('returns a policy with ordered statement items', async () => {
      queueQueries([{ id: 'policy-1' }], [{ statement_id: 'statement-1' }]);
      const response = await adminConsentPolicyGetHandler(context());
      await expect(response.json()).resolves.toEqual({
        policy: { id: 'policy-1' },
        items: [{ statement_id: 'statement-1' }],
      });
    });

    it('returns a stable get error', async () => {
      mocks.adapter.query.mockRejectedValueOnce(new Error('query failed'));
      expect((await adminConsentPolicyGetHandler(context())).status).toBe(500);
    });

    it.each([[{}], [{ display_name: '' }], [{ display_name: '   ' }]])(
      'requires a nonblank display name on create %#',
      async (body) => {
        expect((await adminConsentPolicyCreateHandler(context(body))).status).toBe(400);
        expect(mocks.adapter.execute).not.toHaveBeenCalled();
      }
    );

    it('creates an active policy with normalized nullable description', async () => {
      mocks.adapter.query.mockResolvedValueOnce([{ id: 'policy-1', display_name: 'Policy' }]);
      const response = await adminConsentPolicyCreateHandler(
        context({ display_name: ' Policy ', description: ' ', is_active: undefined })
      );
      expect(response.status).toBe(201);
      expect(mocks.adapter.execute).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO consent_policies'),
        expect.arrayContaining(['tenant-a', 'Policy', null, 1])
      );
    });

    it.each([
      [false, 0],
      [0, 0],
      [1, 1],
      ['unexpected', 1],
    ])('normalizes create is_active=%s to %s', async (input, expected) => {
      await adminConsentPolicyCreateHandler(context({ display_name: 'Policy', is_active: input }));
      expect(mocks.adapter.execute).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining(['Policy', null, expected])
      );
    });

    it('returns a stable create error', async () => {
      mocks.adapter.execute.mockRejectedValueOnce(new Error('insert failed'));
      expect(
        (await adminConsentPolicyCreateHandler(context({ display_name: 'Policy' }))).status
      ).toBe(500);
    });

    it('refuses to update a missing tenant policy', async () => {
      expect((await adminConsentPolicyUpdateHandler(context({ display_name: 'New' }))).status).toBe(
        404
      );
    });

    it('requires at least one recognized update field', async () => {
      mocks.adapter.query.mockResolvedValueOnce([{ id: 'policy-1' }]);
      expect((await adminConsentPolicyUpdateHandler(context({ unknown: true }))).status).toBe(400);
    });

    it('updates normalized fields and returns the refreshed policy', async () => {
      queueQueries([{ id: 'policy-1' }], [{ id: 'policy-1', display_name: 'New' }], []);
      const response = await adminConsentPolicyUpdateHandler(
        context({ display_name: ' New ', description: 42, is_active: 0 })
      );
      expect(response.status).toBe(200);
      expect(mocks.adapter.execute).toHaveBeenCalledWith(
        expect.stringContaining('display_name = ?'),
        expect.arrayContaining(['New', null, 0, 'policy-1', 'tenant-a'])
      );
    });

    it('returns a stable update error', async () => {
      mocks.adapter.query.mockRejectedValueOnce(new Error('query failed'));
      expect((await adminConsentPolicyUpdateHandler(context({ display_name: 'New' }))).status).toBe(
        500
      );
    });

    it('deletes within the tenant and is idempotent', async () => {
      const response = await adminConsentPolicyDeleteHandler(context());
      await expect(response.json()).resolves.toEqual({ success: true });
      expect(mocks.adapter.execute).toHaveBeenCalledWith(expect.stringContaining('tenant_id = ?'), [
        'policy-1',
        'tenant-a',
      ]);
    });

    it('returns a stable delete error', async () => {
      mocks.adapter.execute.mockRejectedValueOnce(new Error('delete failed'));
      expect((await adminConsentPolicyDeleteHandler(context())).status).toBe(500);
    });
  });

  describe('policy item replacement', () => {
    it('requires the parent policy to exist in the tenant', async () => {
      expect((await adminConsentPolicyItemsReplaceHandler(context({ items: [] }))).status).toBe(
        404
      );
    });

    async function replace(items: Array<Record<string, unknown>>, queryResults: unknown[][] = []) {
      queueQueries([{ id: 'policy-1' }], ...queryResults);
      return adminConsentPolicyItemsReplaceHandler(context({ items }));
    }

    it('treats a non-array items value as an empty replacement', async () => {
      queueQueries([{ id: 'policy-1' }], []);
      const response = await adminConsentPolicyItemsReplaceHandler(context({ items: 'bad' }));
      expect(response.status).toBe(200);
      expect(mocks.adapter.execute).toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM consent_policy_items'),
        ['tenant-a', 'policy-1']
      );
    });

    it.each([
      [[{}], [], 'statement_id is required'],
      [
        [{ statement_id: 's1' }, { statement_id: 's1' }],
        [[{ id: 's1' }]],
        'Duplicate consent statement',
      ],
      [[{ statement_id: 'unknown' }], [[]], 'Unknown consent statement'],
      [[{ statement_id: 's1', requirement: 'mandatory' }], [[{ id: 's1' }]], 'requirement must be'],
      [[{ statement_id: 's1', version_mode: 'latest' }], [[{ id: 's1' }]], 'version_mode must be'],
      [
        [{ statement_id: 's1', checkbox_mode: 'always' }],
        [[{ id: 's1' }]],
        'checkbox_mode must be',
      ],
      [
        [{ statement_id: 's1', min_version: 'bad' }],
        [[{ id: 's1' }]],
        'min_version must be YYYYMMDD',
      ],
      [
        [{ statement_id: 's1', version_mode: 'minimum' }],
        [[{ id: 's1' }]],
        'min_version is required',
      ],
      [[{ statement_id: 's1', version_mode: 'fixed' }], [[{ id: 's1' }]], 'version_id is required'],
      [
        [{ statement_id: 's1', version_mode: 'fixed', version_id: 'v1' }],
        [[{ id: 's1' }], []],
        'must reference a version',
      ],
      [[{ statement_id: 's1', binding_type: 'unknown' }], [[{ id: 's1' }]], 'binding_type must be'],
    ] as const)('rejects invalid policy item relation %#', async (items, results, message) => {
      if (message.includes('YYYYMMDD')) mocks.validateVersion.mockReturnValueOnce(false);
      const response = await replace(
        Array.from(items) as unknown as Array<Record<string, unknown>>,
        Array.from(results, (result) => Array.from(result))
      );
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error_description: expect.stringContaining(message),
      });
      expect(mocks.adapter.execute).not.toHaveBeenCalled();
    });

    it('atomically replaces normalized current, minimum, and fixed policy items', async () => {
      const items = [
        { statement_id: 's-current' },
        {
          statement_id: 's-minimum',
          requirement: 'optional',
          version_mode: 'minimum',
          min_version: '20260101',
          checkbox_mode: 'optional',
          checkbox_default_checked: true,
          binding_type: 'scope',
          binding_value: 'profile',
          evidence_profile: 'standard',
          language_fallback: 'en',
          display_order: 5,
        },
        {
          statement_id: 's-fixed',
          requirement: 'hidden',
          version_mode: 'fixed',
          version_id: 'v-fixed',
          checkbox_mode: 'none',
          display_order: -1,
        },
      ];
      queueQueries(
        [{ id: 'policy-1' }],
        [{ id: 's-current' }],
        [{ id: 's-minimum' }],
        [{ id: 's-fixed' }],
        [{ id: 'v-fixed' }],
        [{ statement_id: 's-current' }]
      );

      const response = await adminConsentPolicyItemsReplaceHandler(context({ items }));

      expect(response.status).toBe(200);
      expect(mocks.adapter.execute).toHaveBeenCalledTimes(5);
      expect(mocks.adapter.execute).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO consent_policy_items'),
        expect.arrayContaining([
          's-minimum',
          'optional',
          'minimum',
          null,
          '20260101',
          'optional',
          1,
          'scope',
          'profile',
          'standard',
          'en',
          5,
        ])
      );
    });

    it('returns a stable replacement error', async () => {
      mocks.adapter.query.mockRejectedValueOnce(new Error('query failed'));
      expect((await adminConsentPolicyItemsReplaceHandler(context({ items: [] }))).status).toBe(
        500
      );
    });
  });

  describe('client trust and sign-in confirmation policies', () => {
    it.each([
      [{}, 'target_type is invalid'],
      [{ target_type: 'unknown', target_id: 'client-1' }, 'target_type is invalid'],
      [{ target_type: 'oidc_client', target_id: ' ' }, 'target_id is required'],
    ])('rejects invalid trust target %#', async (body, error) => {
      const response = await adminClientTrustPolicyUpsertHandler(context(body));
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error_description: error });
    });

    it.each([
      ['oidc_client', []],
      ['saml_sp', []],
      ['oidc_client', [{ id: 'existing' }]],
    ])('upserts %s trust policy with existing=%s', async (targetType, existing) => {
      queueQueries(existing, [{ target_type: targetType }]);
      const response = await adminClientTrustPolicyUpsertHandler(
        context({
          target_type: targetType,
          target_id: ' app-1 ',
          display_name: '',
          description: ' Description ',
          first_party: 1,
          trusted: true,
          skip_authorization_consent: true,
          is_active: false,
        })
      );
      expect(response.status).toBe(200);
      expect(mocks.adapter.execute).toHaveBeenCalledWith(
        expect.stringContaining(existing.length ? 'UPDATE' : 'INSERT'),
        expect.arrayContaining(['Description', 1, 1, 1, 0])
      );
    });

    it('lists trust policies and handles query failures', async () => {
      mocks.adapter.query.mockResolvedValueOnce([{ id: 'trust-1' }]);
      expect((await adminClientTrustPoliciesListHandler(context())).status).toBe(200);
      mocks.adapter.query.mockRejectedValueOnce(new Error('query failed'));
      expect((await adminClientTrustPoliciesListHandler(context())).status).toBe(500);
    });

    it('returns a stable trust upsert error', async () => {
      mocks.adapter.query.mockRejectedValueOnce(new Error('query failed'));
      expect(
        (
          await adminClientTrustPolicyUpsertHandler(
            context({ target_type: 'oidc_client', target_id: 'client-1' })
          )
        ).status
      ).toBe(500);
    });

    it('rejects unsupported sign-in confirmation modes', async () => {
      expect(
        (await adminSignInConfirmationPolicyUpsertHandler(context({ mode: 'sometimes' }))).status
      ).toBe(400);
    });

    it.each([
      [[], 'INSERT'],
      [[{ id: 'existing' }], 'UPDATE'],
    ])('upserts sign-in policy through %s path', async (existing, operation) => {
      queueQueries(existing, [{ mode: 'every_time' }]);
      const response = await adminSignInConfirmationPolicyUpsertHandler(
        context({
          mode: 'every_time',
          display_name: ' Confirm login ',
          description: null,
          remember_duration_days: 30,
          show_application_context: false,
          show_tenant_context: 0,
          is_active: true,
        })
      );
      expect(response.status).toBe(200);
      expect(mocks.adapter.execute).toHaveBeenCalledWith(
        expect.stringContaining(operation),
        expect.arrayContaining(['Confirm login', 'every_time', 30, 0, 0, 1])
      );
    });

    it.each([
      [undefined, 365],
      [-1, 365],
      [3651, 365],
      [1.5, 365],
      [0, 0],
    ])('normalizes remember_duration_days=%s to %s', async (input, expected) => {
      queueQueries([], []);
      await adminSignInConfirmationPolicyUpsertHandler(context({ remember_duration_days: input }));
      expect(mocks.adapter.execute).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining([expected])
      );
    });

    it('lists sign-in policies and handles failures', async () => {
      mocks.adapter.query.mockResolvedValueOnce([{ id: 'signin-1' }]);
      expect((await adminSignInConfirmationPoliciesListHandler(context())).status).toBe(200);
      mocks.adapter.query.mockRejectedValueOnce(new Error('query failed'));
      expect((await adminSignInConfirmationPoliciesListHandler(context())).status).toBe(500);
    });

    it('returns a stable sign-in upsert error', async () => {
      mocks.adapter.query.mockRejectedValueOnce(new Error('query failed'));
      expect((await adminSignInConfirmationPolicyUpsertHandler(context({}))).status).toBe(500);
    });
  });
});
