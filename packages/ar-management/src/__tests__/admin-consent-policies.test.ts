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
  adminSignInConfirmationPoliciesListHandler,
  adminSignInConfirmationPolicyUpsertHandler,
} from '../admin-consent-policies';

function context(body: unknown = {}, id = 'policy-1', env: Record<string, unknown> = {}) {
  return {
    req: {
      json: vi.fn().mockResolvedValue(body),
      param: vi.fn((name: string) => (name === 'id' ? id : undefined)),
    },
    env,
    json: vi.fn((value: unknown, status = 200) => Response.json(value, { status })),
  } as never;
}

function queueQueries(...results: unknown[][]) {
  for (const result of results) mocks.adapter.query.mockResolvedValueOnce(result);
}

describe('admin client trust and sign-in confirmation policy APIs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.adapter.query.mockResolvedValue([]);
    mocks.adapter.execute.mockResolvedValue({ success: true, rowsAffected: 1 });
    mocks.validateVersion.mockReturnValue(true);
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
      if (targetType === 'oidc_client') {
        queueQueries([{ client_id: 'app-1' }], existing, [{ target_type: targetType }]);
      } else {
        queueQueries(existing, [{ target_type: targetType }]);
      }
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

    it('rejects a missing or cross-tenant OIDC client target', async () => {
      const response = await adminClientTrustPolicyUpsertHandler(
        context({
          target_type: 'oidc_client',
          target_id: 'other-tenant-client',
          first_party: true,
          trusted: true,
          skip_authorization_consent: true,
        })
      );

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toMatchObject({
        error: 'not_found',
        error_description: 'OIDC client was not found',
      });
      expect(mocks.adapter.query).toHaveBeenCalledWith(
        expect.stringContaining('tenant_id = ? AND client_id = ?'),
        ['tenant-a', 'other-tenant-client']
      );
      expect(mocks.adapter.execute).not.toHaveBeenCalled();
    });

    it('rejects disabling first-party trust while App Login is enabled', async () => {
      queueQueries([{ client_id: 'app-1' }]);
      const settings = {
        get: vi.fn().mockResolvedValue(JSON.stringify({ 'client.app_login_enabled': true })),
      };
      const response = await adminClientTrustPolicyUpsertHandler(
        context(
          {
            target_type: 'oidc_client',
            target_id: 'app-1',
            first_party: false,
            is_active: true,
          },
          'policy-1',
          { SETTINGS: settings }
        )
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error_description: expect.stringContaining('first-party Client Trust Policy'),
      });
      expect(mocks.adapter.execute).not.toHaveBeenCalled();
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
