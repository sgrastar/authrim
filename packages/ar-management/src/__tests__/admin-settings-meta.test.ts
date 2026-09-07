import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  adapter: { query: vi.fn(), queryOne: vi.fn(), execute: vi.fn() },
  audit: vi.fn(),
  authority: vi.fn(),
  tenantGuard: vi.fn(),
  singleTenant: vi.fn(),
  singleTenantError: vi.fn(),
  logger: { error: vi.fn() },
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getTenantIdFromContext: vi.fn(() => 'tenant-a'),
    createAuthContextFromHono: vi.fn(() => ({ coreAdapter: mocks.adapter })),
    createAuditLogFromContext: mocks.audit,
    createErrorResponse: vi.fn((c, code, options) => {
      const status =
        code === actual.AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND
          ? 404
          : code === actual.AR_ERROR_CODES.INTERNAL_ERROR
            ? 500
            : 400;
      return c.json({ error: code, ...options }, status);
    }),
    getLogger: vi.fn(() => ({ module: vi.fn(() => mocks.logger) })),
  };
});

vi.mock('../admin-tenant-access', () => ({
  requirePlatformTenantManagementAuthority: mocks.authority,
}));

vi.mock('../single-tenant-guard', () => ({
  ensureSupportedTenantId: mocks.tenantGuard,
  isSingleTenantMode: mocks.singleTenant,
  createSingleTenantMutationError: mocks.singleTenantError,
}));

vi.mock('../logging-tenant-key', () => ({ createOpaqueTenantKey: vi.fn(() => 'opaque-key') }));

import {
  adminSettingsDiffHandler,
  adminSettingsSchemaHandler,
  adminSettingsValidateHandler,
} from '../admin-settings-meta';

function context(
  options: {
    query?: Record<string, string | undefined>;
    body?: unknown;
    bodyError?: boolean;
    id?: string;
    env?: Record<string, unknown>;
  } = {}
) {
  const query = options.query ?? {};
  return {
    req: {
      query: vi.fn((name: string) => query[name]),
      param: vi.fn((name: string) => (name === 'id' ? (options.id ?? 'source') : undefined)),
      json: options.bodyError
        ? vi.fn().mockRejectedValue(new SyntaxError('bad json'))
        : vi.fn().mockResolvedValue(options.body ?? {}),
    },
    env: options.env ?? {},
    json: vi.fn((value: unknown, status = 200) => Response.json(value, { status })),
  } as never;
}

function history(category: string, settings: unknown, version = 1) {
  return {
    id: `${category}-${version}`,
    tenant_id: 'tenant-a',
    category,
    settings: JSON.stringify(settings),
    changed_by: 'admin',
    version,
    created_at: 1_700_000_000,
  };
}

describe('admin settings metadata APIs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.adapter.query.mockResolvedValue([]);
    mocks.adapter.queryOne.mockResolvedValue(null);
    mocks.adapter.execute.mockResolvedValue({ success: true, rowsAffected: 1 });
    mocks.audit.mockResolvedValue(undefined);
    mocks.authority.mockResolvedValue(null);
    mocks.tenantGuard.mockResolvedValue(null);
    mocks.singleTenant.mockReturnValue(false);
    mocks.singleTenantError.mockImplementation((c) => c.json({ error: 'single_tenant' }, 400));
  });

  describe('settings diff', () => {
    it.each([
      [{}, 'from_version'],
      [{ from_version: '0' }, 'from_version'],
      [{ from_version: 'nope' }, 'from_version'],
      [{ from_version: '1', to_version: '0' }, 'to_version'],
      [{ from_version: '1', to_version: 'nope' }, 'to_version'],
      [{ from_version: '1', category: 'unknown' }, 'category'],
    ])('rejects invalid query %#', async (query, field) => {
      const response = await adminSettingsDiffHandler(context({ query }));
      expect(response.status).toBe(400);
      expect(JSON.stringify(await response.json())).toContain(field);
    });

    it('returns not found when the source version is absent', async () => {
      expect(
        (await adminSettingsDiffHandler(context({ query: { from_version: '1' } }))).status
      ).toBe(404);
    });

    it('reports nested additions, removals, changes, and unchanged categories', async () => {
      mocks.adapter.query
        .mockResolvedValueOnce([
          history('oauth', { nested: { kept: true, removed: 1, changed: 1 }, list: [1] }),
          history('security', { old: true }),
          history('logging', { same: true }),
        ])
        .mockResolvedValueOnce([
          history('oauth', { nested: { kept: true, added: 2, changed: 2 }, list: [2] }, 2),
          history('mfa', { fresh: true }, 2),
          history('logging', { same: true }, 2),
        ]);

      const response = await adminSettingsDiffHandler(
        context({ query: { from_version: '1', to_version: '2' } })
      );
      const body = (await response.json()) as {
        diffs: Array<{ category: string; changes: unknown[] }>;
      };
      expect(body.diffs.find((item) => item.category === 'oauth')?.changes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: 'nested.removed', type: 'removed' }),
          expect.objectContaining({ path: 'nested.added', type: 'added' }),
          expect.objectContaining({ path: 'nested.changed', type: 'changed' }),
          expect.objectContaining({ path: 'list', type: 'changed' }),
        ])
      );
      expect(body.diffs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ category: 'security' }),
          expect.objectContaining({ category: 'mfa' }),
        ])
      );
      expect(body.diffs.some((item) => item.category === 'logging')).toBe(false);
    });

    it('filters both history queries by category', async () => {
      mocks.adapter.query
        .mockResolvedValueOnce([history('oauth', { issuer: 'https://old.example' })])
        .mockResolvedValueOnce([history('oauth', { issuer: 'https://new.example' }, 2)]);
      await adminSettingsDiffHandler(
        context({ query: { category: 'oauth', from_version: '1', to_version: '2' } })
      );
      expect(mocks.adapter.query).toHaveBeenNthCalledWith(1, expect.any(String), [
        'tenant-a',
        1,
        'oauth',
      ]);
      expect(mocks.adapter.query).toHaveBeenNthCalledWith(2, expect.any(String), [
        'tenant-a',
        2,
        'oauth',
      ]);
    });

    it.each([
      [null, {}],
      [{ settings: null, updated_at: 0 }, {}],
      [{ settings: '{', updated_at: 0 }, {}],
      [{ settings: '[]', updated_at: 0 }, {}],
      [
        { settings: JSON.stringify({ oauth: { require_pkce: false } }), updated_at: 1 },
        { require_pkce: false },
      ],
    ])('compares a category with current tenant settings %#', async (current, expected) => {
      mocks.adapter.query.mockResolvedValueOnce([history('oauth', { require_pkce: true })]);
      mocks.adapter.queryOne.mockResolvedValueOnce(current);
      const body = (await (
        await adminSettingsDiffHandler(context({ query: { category: 'oauth', from_version: '1' } }))
      ).json()) as { to_version: string; diffs: Array<{ changes: unknown[] }> };
      expect(body.to_version).toBe('current');
      if (current) {
        expect(mocks.adapter.queryOne).toHaveBeenCalled();
      }
      expect(body.diffs).toHaveLength(1);
    });

    it.each([
      [null, 0],
      [{ settings: '', updated_at: 0 }, 0],
      [{ settings: '{', updated_at: 0 }, 1],
      [{ settings: '[]', updated_at: 0 }, 1],
      [{ settings: JSON.stringify({ oauth: { require_pkce: true } }), updated_at: 0 }, 1],
    ])('compares all categories with current tenant settings %#', async (tenant, _expected) => {
      mocks.adapter.query.mockResolvedValueOnce([history('oauth', { require_pkce: false })]);
      mocks.adapter.queryOne.mockResolvedValueOnce(tenant);
      const response = await adminSettingsDiffHandler(context({ query: { from_version: '1' } }));
      expect(response.status).toBe(200);
    });

    it('returns internal_error for invalid stored history JSON', async () => {
      mocks.adapter.query.mockResolvedValueOnce([{ ...history('oauth', {}), settings: '{' }]);
      expect(
        (await adminSettingsDiffHandler(context({ query: { from_version: '1' } }))).status
      ).toBe(500);
      expect(mocks.logger.error).toHaveBeenCalled();
    });
  });

  describe('settings schema', () => {
    it('returns all ten categories and their setting counts', async () => {
      const body = (await (await adminSettingsSchemaHandler(context())).json()) as {
        total_categories: number;
        total_settings: number;
      };
      expect(body.total_categories).toBe(10);
      expect(body.total_settings).toBeGreaterThan(40);
    });

    it('returns only the requested category', async () => {
      const body = (await (
        await adminSettingsSchemaHandler(context({ query: { category: 'oauth' } }))
      ).json()) as { categories: Array<{ category: string; settings_count: number }> };
      expect(body.categories).toEqual([
        expect.objectContaining({ category: 'oauth', settings_count: 9 }),
      ]);
    });

    it('rejects unknown categories', async () => {
      expect(
        (await adminSettingsSchemaHandler(context({ query: { category: 'bad' } }))).status
      ).toBe(400);
    });
  });

  describe('settings validation', () => {
    it.each([[null], [{}], [{ settings: [] }], [{ category: 1, settings: {} }]])(
      'rejects malformed request %#',
      async (body) => {
        expect((await adminSettingsValidateHandler(context({ body }))).status).toBe(400);
      }
    );

    it('rejects an unknown category', async () => {
      expect(
        (await adminSettingsValidateHandler(context({ body: { category: 'bad', settings: {} } })))
          .status
      ).toBe(400);
    });

    it('validates required, types, ranges, patterns, enum values, and unknown keys', async () => {
      const body = (await (
        await adminSettingsValidateHandler(
          context({
            body: {
              settings: {
                oauth: {
                  access_token_lifetime: 1,
                  refresh_token_lifetime: 99_999_999,
                  id_token_lifetime: Number.NaN,
                  require_pkce: 'yes',
                  unknown: true,
                },
                security: { fapi_profile: 'invalid', password_min_length: 10 },
                mfa: { mfa_methods: 'totp' },
                ui: { primary_color: 'blue' },
                compliance: { gdpr_mode: {} },
              },
            },
          })
        )
      ).json()) as { valid: boolean; errors: Array<{ path: string }>; warnings: string[] };
      expect(body.valid).toBe(false);
      expect(body.errors.map((error) => error.path)).toEqual(
        expect.arrayContaining([
          'oauth.issuer',
          'oauth.access_token_lifetime',
          'oauth.refresh_token_lifetime',
          'oauth.id_token_lifetime',
          'oauth.require_pkce',
          'security.fapi_profile',
          'mfa.mfa_methods',
          'ui.primary_color',
          'compliance.gdpr_mode',
        ])
      );
      expect(body.warnings).toEqual(
        expect.arrayContaining([
          'Unknown setting: oauth.unknown',
          expect.stringContaining('Password minimum length'),
        ])
      );
    });

    it('accepts representative valid values for every supported setting type', async () => {
      const response = await adminSettingsValidateHandler(
        context({
          body: {
            settings: {
              oauth: { issuer: 'https://issuer.example', require_pkce: true },
              security: { fapi_profile: 'fapi2', password_min_length: 12 },
              mfa: { mfa_methods: ['totp'] },
              ui: { primary_color: '#AABBCC' },
            },
          },
        })
      );
      await expect(response.json()).resolves.toMatchObject({ valid: true, warnings: [] });
    });

    it('adds security warnings for insecure OAuth choices', async () => {
      const body = (await (
        await adminSettingsValidateHandler(
          context({
            body: {
              category: 'oauth',
              settings: {
                issuer: 'https://issuer.example',
                allow_implicit_flow: true,
                require_pkce: false,
              },
            },
          })
        )
      ).json()) as { warnings: string[] };
      expect(body.warnings).toHaveLength(2);
    });

    it('handles non-object category values without throwing', async () => {
      const response = await adminSettingsValidateHandler(
        context({ body: { settings: { oauth: 'invalid' } } })
      );
      expect(response.status).toBe(200);
    });

    it('returns internal_error when JSON parsing fails', async () => {
      expect((await adminSettingsValidateHandler(context({ bodyError: true }))).status).toBe(500);
    });
  });
});
