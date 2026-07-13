import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  adapter: { query: vi.fn(), execute: vi.fn() },
  validateVersion: vi.fn(),
  activateVersion: vi.fn(),
  logger: { info: vi.fn(), error: vi.fn() },
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getTenantIdFromContext: vi.fn(() => 'tenant-a'),
    createAuthContextFromHono: vi.fn(() => ({ coreAdapter: mocks.adapter })),
    getLogger: vi.fn(() => ({ module: vi.fn(() => mocks.logger) })),
    validateVersionFormat: mocks.validateVersion,
    activateVersion: mocks.activateVersion,
  };
});

import {
  adminConsentStatementCreateHandler,
  adminConsentStatementDeleteHandler,
  adminConsentStatementGetHandler,
  adminConsentStatementUpdateHandler,
  adminConsentStatementsListHandler,
  adminConsentLocalizationDeleteHandler,
  adminConsentLocalizationsListHandler,
  adminConsentLocalizationUpsertHandler,
  adminConsentOverrideDeleteHandler,
  adminConsentOverridesListHandler,
  adminConsentOverrideUpsertHandler,
  adminConsentRequirementDeleteHandler,
  adminConsentRequirementsListHandler,
  adminConsentRequirementUpsertHandler,
  adminConsentVersionActivateHandler,
  adminConsentVersionCreateHandler,
  adminConsentVersionDeleteHandler,
  adminConsentVersionGetHandler,
  adminConsentVersionUpdateHandler,
  adminConsentVersionsListHandler,
  adminUserConsentHistoryHandler,
  adminUserConsentRecordsListHandler,
  adminUserConsentWithdrawHandler,
} from '../admin-consent-statements';

function context(options: { params?: Record<string, string>; body?: unknown; bodyError?: boolean } = {}) {
  return {
    req: {
      param: vi.fn((name: string) => options.params?.[name] ?? name),
      json: options.bodyError
        ? vi.fn().mockRejectedValue(new SyntaxError('bad json'))
        : vi.fn().mockResolvedValue(options.body ?? {}),
    },
    env: {},
    json: vi.fn((value: unknown, status = 200) => Response.json(value, { status })),
  } as never;
}

describe('admin consent statement lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.adapter.query.mockReset();
    mocks.adapter.execute.mockReset();
    mocks.adapter.query.mockResolvedValue([]);
    mocks.adapter.execute.mockResolvedValue({ success: true, rowsAffected: 1 });
    mocks.validateVersion.mockReturnValue(true);
    mocks.activateVersion.mockResolvedValue(undefined);
  });

  it('lists only the current tenant statements and handles failures', async () => {
    mocks.adapter.query.mockResolvedValueOnce([{ id: 'statement-1' }]);
    await expect((await adminConsentStatementsListHandler(context())).json()).resolves.toEqual({
      statements: [{ id: 'statement-1' }],
    });
    expect(mocks.adapter.query).toHaveBeenCalledWith(expect.any(String), ['tenant-a']);
    mocks.adapter.query.mockRejectedValueOnce(new Error('failure'));
    expect((await adminConsentStatementsListHandler(context())).status).toBe(500);
  });

  it.each([[{}], [{ slug: 1 }], [{ slug: '' }]])('requires a string statement slug %#', async (body) => {
    expect((await adminConsentStatementCreateHandler(context({ body }))).status).toBe(400);
  });

  it('rejects duplicate statement slugs', async () => {
    mocks.adapter.query.mockResolvedValueOnce([{ id: 'existing' }]);
    expect(
      (await adminConsentStatementCreateHandler(context({ body: { slug: 'privacy' } }))).status
    ).toBe(409);
  });

  it.each([-1, 1.5, '30'])('rejects invalid retention days %#', async (value) => {
    expect(
      (
        await adminConsentStatementCreateHandler(
          context({ body: { slug: 'privacy', record_retention_days: value } })
        )
      ).status
    ).toBe(400);
  });

  it.each([-1, 1.5, '30'])('rejects invalid reconsent interval %#', async (value) => {
    expect(
      (
        await adminConsentStatementCreateHandler(
          context({ body: { slug: 'privacy', reconsent_interval_days: value } })
        )
      ).status
    ).toBe(400);
  });

  it.each([false, true])('creates a statement with explicit flags=%s', async (defaults) => {
    const body = defaults
      ? { slug: 'privacy' }
      : {
          slug: 'marketing', category: 'marketing', legal_basis: 'consent',
          processing_purpose: 'Email offers', display_order: 0, record_retention_days: 0,
          withdrawal_allowed: false, withdrawal_impact: '  No more offers  ',
          reconsent_on_version_change: false, reconsent_interval_days: null,
        };
    mocks.adapter.query.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 'created' }]);
    const response = await adminConsentStatementCreateHandler(context({ body }));
    expect(response.status).toBe(201);
    expect(mocks.adapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO consent_statements'),
      expect.arrayContaining(['tenant-a', body.slug])
    );
  });

  it('normalizes blank optional withdrawal impact and handles create errors', async () => {
    mocks.adapter.execute.mockRejectedValueOnce(new Error('failure'));
    expect(
      (
        await adminConsentStatementCreateHandler(
          context({ body: { slug: 'privacy', withdrawal_impact: ' ' } })
        )
      ).status
    ).toBe(500);
  });

  it.each([[[]], [[{ id: 'statement-1' }]]])('gets statement result %#', async (rows) => {
    mocks.adapter.query.mockResolvedValueOnce(rows);
    expect((await adminConsentStatementGetHandler(context())).status).toBe(rows.length ? 200 : 404);
  });

  it('handles statement get failures', async () => {
    mocks.adapter.query.mockRejectedValueOnce(new Error('failure'));
    expect((await adminConsentStatementGetHandler(context())).status).toBe(500);
  });

  it('does not update a missing statement or accept an empty update', async () => {
    expect((await adminConsentStatementUpdateHandler(context({ body: {} }))).status).toBe(404);
    mocks.adapter.query.mockResolvedValueOnce([{ id: 'statement-1' }]);
    expect((await adminConsentStatementUpdateHandler(context({ body: {} }))).status).toBe(400);
  });

  it.each([
    [{ record_retention_days: -1 }],
    [{ reconsent_interval_days: 2.5 }],
  ])('rejects invalid statement update numeric fields %#', async (body) => {
    mocks.adapter.query.mockResolvedValueOnce([{ id: 'statement-1' }]);
    expect((await adminConsentStatementUpdateHandler(context({ body }))).status).toBe(400);
  });

  it('updates every mutable statement field including false, zero, and null', async () => {
    const body = {
      slug: 'privacy-v2', category: 'legal', legal_basis: 'contract', processing_purpose: '',
      display_order: 0, is_active: false, record_retention_days: null,
      withdrawal_allowed: false, withdrawal_impact: '', reconsent_on_version_change: false,
      reconsent_interval_days: 0,
    };
    mocks.adapter.query
      .mockResolvedValueOnce([{ id: 'statement-1' }])
      .mockResolvedValueOnce([{ id: 'statement-1', slug: 'privacy-v2' }]);
    expect((await adminConsentStatementUpdateHandler(context({ body }))).status).toBe(200);
    expect(mocks.adapter.execute.mock.calls[0][1]).toEqual(
      expect.arrayContaining(['privacy-v2', 'legal', 'contract', '', 0, 0, null, 0, null, 0, 0])
    );
  });

  it('handles statement update failures', async () => {
    mocks.adapter.query.mockRejectedValueOnce(new Error('failure'));
    expect((await adminConsentStatementUpdateHandler(context({ body: {} }))).status).toBe(500);
  });

  it.each([[[]], [[{ id: 'statement-1' }]]])('deletes statement graph result %#', async (rows) => {
    mocks.adapter.query.mockResolvedValueOnce(rows);
    const response = await adminConsentStatementDeleteHandler(context());
    expect(response.status).toBe(rows.length ? 200 : 404);
    expect(mocks.adapter.execute).toHaveBeenCalledTimes(rows.length ? 8 : 0);
  });

  it('handles statement cascade deletion failures', async () => {
    mocks.adapter.query.mockResolvedValueOnce([{ id: 'statement-1' }]);
    mocks.adapter.execute.mockRejectedValueOnce(new Error('failure'));
    expect((await adminConsentStatementDeleteHandler(context())).status).toBe(500);
  });

  it('lists tenant-scoped versions and handles failures', async () => {
    mocks.adapter.query.mockResolvedValueOnce([{ id: 'version-1' }]);
    await expect((await adminConsentVersionsListHandler(context())).json()).resolves.toEqual({
      versions: [{ id: 'version-1' }],
    });
    mocks.adapter.query.mockRejectedValueOnce(new Error('failure'));
    expect((await adminConsentVersionsListHandler(context())).status).toBe(500);
  });

  it.each([
    [{}, 'version'],
    [{ version: 'bad', effective_at: 100 }, 'version'],
    [{ version: '20260101' }, 'effective_at'],
    [{ version: '20260101', effective_at: 100, effective_until: 100 }, 'effective_until'],
  ])('validates version creation %#', async (body, _field) => {
    mocks.validateVersion.mockReturnValue(!('version' in body) || body.version !== 'bad');
    expect((await adminConsentVersionCreateHandler(context({ body }))).status).toBe(400);
  });

  it('rejects duplicate versions', async () => {
    mocks.adapter.query.mockResolvedValueOnce([{ id: 'existing' }]);
    expect(
      (
        await adminConsentVersionCreateHandler(
          context({ body: { version: '20260101', effective_at: 100 } })
        )
      ).status
    ).toBe(409);
  });

  it.each([false, true])('creates version with optional end=%s', async (withEnd) => {
    mocks.adapter.query.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 'version-1' }]);
    const body = {
      version: '20260101', effective_at: 100,
      ...(withEnd ? { effective_until: 200, content_type: 'inline' } : {}),
    };
    expect((await adminConsentVersionCreateHandler(context({ body }))).status).toBe(201);
  });

  it('handles version create failures', async () => {
    mocks.adapter.query.mockRejectedValueOnce(new Error('failure'));
    expect(
      (
        await adminConsentVersionCreateHandler(
          context({ body: { version: '20260101', effective_at: 100 } })
        )
      ).status
    ).toBe(500);
  });

  it.each([[[]], [[{ id: 'version-1' }]]])('gets version result %#', async (rows) => {
    mocks.adapter.query.mockResolvedValueOnce(rows);
    expect((await adminConsentVersionGetHandler(context())).status).toBe(rows.length ? 200 : 404);
  });

  it('validates draft-only version updates', async () => {
    expect((await adminConsentVersionUpdateHandler(context({ body: {} }))).status).toBe(404);
    mocks.adapter.query.mockResolvedValueOnce([{ status: 'active', effective_at: 100 }]);
    expect((await adminConsentVersionUpdateHandler(context({ body: {} }))).status).toBe(400);
  });

  it.each([
    [{ version: 'bad' }],
    [{ effective_until: 100 }],
    [{}],
  ])('rejects invalid draft version update %#', async (body) => {
    mocks.adapter.query.mockResolvedValueOnce([{ status: 'draft', effective_at: 100 }]);
    mocks.validateVersion.mockReturnValue(!('version' in body) || body.version !== 'bad');
    expect((await adminConsentVersionUpdateHandler(context({ body }))).status).toBe(400);
  });

  it('updates all draft version fields', async () => {
    mocks.adapter.query
      .mockResolvedValueOnce([{ status: 'draft', effective_at: 100 }])
      .mockResolvedValueOnce([{ id: 'version-1' }]);
    expect(
      (
        await adminConsentVersionUpdateHandler(
          context({ body: { version: '20260202', content_type: 'inline', effective_at: 200, effective_until: null } })
        )
      ).status
    ).toBe(200);
  });

  it.each([
    [new Error('version not found'), 400],
    [new Error('localization required'), 400],
    [new Error('D1 unavailable'), 500],
  ])('maps activation failure %#', async (error, status) => {
    mocks.activateVersion.mockRejectedValueOnce(error);
    expect((await adminConsentVersionActivateHandler(context())).status).toBe(status);
  });

  it('activates through the shared version service and returns the activated row', async () => {
    mocks.adapter.query.mockResolvedValueOnce([{ id: 'version-1', status: 'active' }]);
    expect((await adminConsentVersionActivateHandler(context())).status).toBe(200);
    expect(mocks.activateVersion).toHaveBeenCalledWith(mocks.adapter, 'tenant-a', 'sid', 'vid');
  });

  it.each([
    [[], 404],
    [[{ status: 'active' }], 400],
    [[{ status: 'draft' }], 200],
  ])('deletes draft version result %#', async (rows, status) => {
    mocks.adapter.query.mockResolvedValueOnce(rows);
    expect((await adminConsentVersionDeleteHandler(context())).status).toBe(status);
  });

  it('lists user records/history and withdraws only granted withdrawable consent', async () => {
    mocks.adapter.query.mockResolvedValueOnce([{ id: 'record-1' }]);
    await expect((await adminUserConsentRecordsListHandler(context())).json()).resolves.toEqual({
      records: [{ id: 'record-1' }],
    });
    mocks.adapter.query.mockResolvedValueOnce([{ id: 'history-1' }]);
    await expect((await adminUserConsentHistoryHandler(context())).json()).resolves.toEqual({
      history: [{ id: 'history-1' }],
    });
    mocks.adapter.query.mockResolvedValueOnce([
      {
        status: 'granted', version_id: 'version-1', version: '20260101', expires_at: null,
        withdrawal_allowed: 1, record_retention_days: 30, reconsent_interval_days: null,
      },
    ]);
    expect((await adminUserConsentWithdrawHandler(context())).status).toBe(200);
    expect(mocks.adapter.execute).toHaveBeenCalledTimes(3);
  });

  it.each([
    [[], 404],
    [[{ status: 'withdrawn', withdrawal_allowed: 1 }], 400],
    [[{ status: 'granted', withdrawal_allowed: 0 }], 400],
  ])('rejects invalid withdrawal state %#', async (rows, status) => {
    mocks.adapter.query.mockResolvedValueOnce(rows);
    expect((await adminUserConsentWithdrawHandler(context())).status).toBe(status);
  });

  it('supports no-retention withdrawal and handles persistence failure', async () => {
    mocks.adapter.query.mockResolvedValueOnce([
      {
        status: 'granted', version_id: 'v', version: '20260101', expires_at: null,
        withdrawal_allowed: null, record_retention_days: null, reconsent_interval_days: 0,
      },
    ]);
    mocks.adapter.execute.mockRejectedValueOnce(new Error('failure'));
    expect((await adminUserConsentWithdrawHandler(context())).status).toBe(500);
  });

  it('lists and deletes localizations with tenant/version/language scope', async () => {
    mocks.adapter.query.mockResolvedValueOnce([{ language: 'en' }]);
    await expect((await adminConsentLocalizationsListHandler(context())).json()).resolves.toEqual({
      localizations: [{ language: 'en' }],
    });
    expect((await adminConsentLocalizationDeleteHandler(context())).status).toBe(200);
    expect(mocks.adapter.execute).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM'), [
      'vid',
      'lang',
      'tenant-a',
    ]);
  });

  it.each([
    [{}],
    [{ title: 'Title' }],
  ])('requires localization title and description %#', async (body) => {
    expect((await adminConsentLocalizationUpsertHandler(context({ body }))).status).toBe(400);
  });

  it.each([undefined, null, '', ' https://example.com/notice '])(
    'inserts localization with public link %#',
    async (document_url) => {
      mocks.adapter.query
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: 'localization-1' }]);
      const response = await adminConsentLocalizationUpsertHandler(
        context({
          body: {
            title: 'Privacy',
            description: 'Privacy notice',
            document_url,
            processing_purpose: 'Account',
            withdrawal_impact: 'Deletion',
            inline_content: '<p>notice</p>',
          },
        })
      );
      expect(response.status).toBe(200);
      expect(mocks.adapter.execute.mock.calls[0][0]).toContain('INSERT INTO');
    }
  );

  it('updates an existing localization and falls back for legacy schemas', async () => {
    mocks.adapter.query
      .mockResolvedValueOnce([{ id: 'localization-1' }])
      .mockResolvedValueOnce([{ id: 'localization-1' }]);
    mocks.adapter.execute
      .mockRejectedValueOnce(new Error('no column named withdrawal_impact'))
      .mockResolvedValueOnce({ success: true });
    expect(
      (
        await adminConsentLocalizationUpsertHandler(
          context({ body: { title: 'Privacy', description: 'Notice' } })
        )
      ).status
    ).toBe(200);
    expect(mocks.adapter.execute).toHaveBeenCalledTimes(2);
  });

  it('does not hide unrelated localization persistence failures', async () => {
    mocks.adapter.execute.mockRejectedValueOnce(new Error('D1 unavailable'));
    expect(
      (
        await adminConsentLocalizationUpsertHandler(
          context({ body: { title: 'Privacy', description: 'Notice' } })
        )
      ).status
    ).toBe(500);
  });

  it('lists and deletes tenant requirements', async () => {
    mocks.adapter.query.mockResolvedValueOnce([{ statement_id: 'statement-1' }]);
    await expect((await adminConsentRequirementsListHandler(context())).json()).resolves.toEqual({
      requirements: [{ statement_id: 'statement-1' }],
    });
    expect((await adminConsentRequirementDeleteHandler(context())).status).toBe(200);
  });

  it.each([
    [{ is_required: true, min_version: 'bad' }],
    [{ is_required: true, deletion_url: 'javascript:alert(1)' }],
  ])('rejects invalid requirement input %#', async (body) => {
    mocks.validateVersion.mockReturnValue(false);
    expect((await adminConsentRequirementUpsertHandler(context({ body }))).status).toBe(400);
  });

  it.each([false, true])('upserts existing=%s tenant requirement', async (existing) => {
    mocks.adapter.query
      .mockResolvedValueOnce(existing ? [{ id: 'requirement-1' }] : [])
      .mockResolvedValueOnce([{ id: 'requirement-1' }]);
    const response = await adminConsentRequirementUpsertHandler(
      context({
        body: {
          is_required: existing,
          min_version: '20260101',
          enforcement: 'warn',
          show_deletion_link: true,
          deletion_url: 'https://example.com/delete',
          conditional_rules: [{ country: 'JP' }],
          display_order: 0,
        },
      })
    );
    expect(response.status).toBe(200);
    expect(mocks.adapter.execute.mock.calls[0][0]).toContain(existing ? 'UPDATE' : 'INSERT');
  });

  it('uses requirement defaults and handles storage failure', async () => {
    mocks.adapter.execute.mockRejectedValueOnce(new Error('failure'));
    expect(
      (
        await adminConsentRequirementUpsertHandler(
          context({ body: { is_required: false, deletion_url: '' } })
        )
      ).status
    ).toBe(500);
  });

  it('lists and deletes client-specific consent overrides', async () => {
    mocks.adapter.query.mockResolvedValueOnce([{ statement_id: 'statement-1' }]);
    await expect((await adminConsentOverridesListHandler(context())).json()).resolves.toEqual({
      overrides: [{ statement_id: 'statement-1' }],
    });
    expect((await adminConsentOverrideDeleteHandler(context())).status).toBe(200);
  });

  it('rejects an invalid override minimum version', async () => {
    mocks.validateVersion.mockReturnValueOnce(false);
    expect(
      (
        await adminConsentOverrideUpsertHandler(
          context({ body: { requirement: 'required', min_version: 'bad' } })
        )
      ).status
    ).toBe(400);
  });

  it.each([false, true])('upserts existing=%s client override', async (existing) => {
    mocks.adapter.query
      .mockResolvedValueOnce(existing ? [{ id: 'override-1' }] : [])
      .mockResolvedValueOnce([{ id: 'override-1' }]);
    const response = await adminConsentOverrideUpsertHandler(
      context({
        body: {
          requirement: existing ? 'optional' : undefined,
          min_version: '20260101',
          enforcement: existing ? 'warn' : undefined,
          conditional_rules: existing ? [{ group: 'staff' }] : undefined,
          display_order: existing ? 0 : undefined,
        },
      })
    );
    expect(response.status).toBe(200);
    expect(mocks.adapter.execute.mock.calls[0][0]).toContain(existing ? 'UPDATE' : 'INSERT');
  });

  it.each([
    [adminConsentLocalizationsListHandler],
    [adminConsentLocalizationDeleteHandler],
    [adminConsentRequirementsListHandler],
    [adminConsentRequirementDeleteHandler],
    [adminConsentOverridesListHandler],
    [adminConsentOverrideDeleteHandler],
  ])('returns server_error when auxiliary consent operation fails %#', async (handler) => {
    mocks.adapter.query.mockRejectedValueOnce(new Error('failure'));
    mocks.adapter.execute.mockRejectedValueOnce(new Error('failure'));
    expect((await handler(context())).status).toBe(500);
  });
});
