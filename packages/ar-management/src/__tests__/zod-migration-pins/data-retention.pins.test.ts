/**
 * zod 3 -> 4 migration pins for routes/settings/data-retention.ts (UpdateLookupRetentionSchema).
 *
 * The handler reports only `issues[0]`: `variables.field = path.join('.') || 'retention_days'` and
 * `variables.reason = message`. `createErrorResponse` is mocked (status from the real
 * implementation, body `{ error: code, ...options }`) so both strings are pinned.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  adapter: { queryOne: vi.fn(), execute: vi.fn(), batch: vi.fn() },
}));

vi.mock('../../admin-tenant-access', () => ({
  getAdminAuth: vi.fn(() => ({ userId: 'admin-a' })),
}));
vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getTenantIdFromContext: vi.fn(() => 'tenant-a'),
    createAuthContextFromHono: vi.fn(() => ({ coreAdapter: mocks.adapter })),
    createAuditLogFromContext: vi.fn(),
    getLogger: vi.fn(() => ({
      module: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
    })),
    resolveTenantAssignedDatabaseSourcesFromRegistry: vi.fn(async () => []),
    ensureDatabaseAdapter: vi.fn(() => mocks.adapter),
    createErrorResponse: vi.fn(
      async (...[c, code, options]: Parameters<typeof actual.createErrorResponse>) => {
        const real = await actual.createErrorResponse(c, code, options);
        return Response.json({ error: code, ...options }, { status: real.status });
      }
    ),
  };
});

import { updateCategoryRetention } from '../../routes/settings/data-retention';

function context(body: unknown, bodyError = false) {
  return {
    req: {
      path: '/api/admin/data-retention/categories/lookup_directory',
      header: vi.fn(() => undefined),
      param: vi.fn(() => 'lookup_directory'),
      query: vi.fn(),
      json: bodyError
        ? vi.fn().mockRejectedValue(new SyntaxError('bad'))
        : vi.fn().mockResolvedValue(body),
    },
    env: {},
    json: vi.fn((value: unknown, status: number = 200) => Response.json(value, { status })),
  } as never;
}

async function update(body: unknown, bodyError = false) {
  const response = await updateCategoryRetention(context(body, bodyError));
  return { status: response.status, body: await response.json<Record<string, unknown>>() };
}

const invalid = (field: string, reason: unknown) => ({
  status: 400,
  body: { error: 'AR130003', variables: { field, reason } },
});

describe('zod pins: UpdateLookupRetentionSchema (PUT /data-retention/categories/lookup_directory)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.adapter.queryOne.mockReset();
    mocks.adapter.execute.mockReset();
    mocks.adapter.batch.mockReset();
    mocks.adapter.queryOne.mockResolvedValue(null);
    mocks.adapter.execute.mockResolvedValue({ success: true, rowsAffected: 1 });
    mocks.adapter.batch.mockImplementation(async (statements: unknown[]) =>
      statements.map(() => ({ success: true, rowsAffected: 1 }))
    );
  });

  it('root issues fall back to field "retention_days" (empty path)', async () => {
    expect(await update(null)).toEqual(invalid('retention_days', 'Expected object, received null'));
    expect(await update([])).toEqual(invalid('retention_days', 'Expected object, received array'));
    expect(await update('x')).toEqual(
      invalid('retention_days', 'Expected object, received string')
    );
    expect(await update(undefined, true)).toEqual(
      invalid('retention_days', 'Expected object, received null')
    );
  });

  it('first issue only, with the failing field as path', async () => {
    expect(await update({})).toEqual(invalid('retention_days', 'Required'));
    expect(await update({ retention_days: '30' })).toEqual(
      invalid('retention_days', 'Expected number, received string')
    );
    expect(await update({ retention_days: null })).toEqual(
      invalid('retention_days', 'Expected number, received null')
    );
    expect(await update({ retention_days: 30.5 })).toEqual(
      invalid('retention_days', 'Expected integer, received float')
    );
    expect(await update({ retention_days: 0 })).toEqual(
      invalid(
        'retention_days',
        expect.stringMatching(/^Number must be greater than or equal to \d+$/)
      )
    );
    expect(await update({ retention_days: 100000 })).toEqual(
      invalid('retention_days', expect.stringMatching(/^Number must be less than or equal to \d+$/))
    );
    expect(await update({ retention_days: 90, confirm_shortening: 'yes' })).toEqual(
      invalid('confirm_shortening', 'Expected boolean, received string')
    );
    expect(await update({ retention_days: 90, confirm_shortening: null })).toEqual(
      invalid('confirm_shortening', 'Expected boolean, received null')
    );
    expect(await update({ retention_days: 90, expected_current_retention_days: '180' })).toEqual(
      invalid('expected_current_retention_days', 'Expected number, received string')
    );
    expect(await update({ retention_days: 90, expected_current_retention_days: 1.5 })).toEqual(
      invalid('expected_current_retention_days', 'Expected integer, received float')
    );
    expect(await update({ retention_days: 90, expected_current_retention_days: 0 })).toEqual(
      invalid(
        'expected_current_retention_days',
        expect.stringMatching(/^Number must be greater than or equal to \d+$/)
      )
    );
  });

  it('first issue is chosen in schema order, not input order', async () => {
    expect(
      await update({
        expected_current_retention_days: 'x',
        confirm_shortening: 'y',
        retention_days: 'z',
      })
    ).toEqual(invalid('retention_days', 'Expected number, received string'));
    expect(
      await update({
        retention_days: 90,
        expected_current_retention_days: 'x',
        confirm_shortening: 'y',
      })
    ).toEqual(invalid('confirm_shortening', 'Expected boolean, received string'));
  });

  it('bounds: the exact min/max from lib-core are accepted, one outside is rejected', async () => {
    const probe = await update({ retention_days: 0 });
    const min = Number(/(\d+)$/.exec((probe.body.variables as { reason: string }).reason)?.[1]);
    const probeMax = await update({ retention_days: 10_000_000 });
    const max = Number(/(\d+)$/.exec((probeMax.body.variables as { reason: string }).reason)?.[1]);
    expect({ min, max }).toEqual({ min: 30, max: 3650 });
    // 30 days shortens the stored 180: accepted by the schema, then needs confirmation (409)
    expect((await update({ retention_days: min })).status).toBe(409);
    expect(
      (
        await update({
          retention_days: min,
          confirm_shortening: true,
          expected_current_retention_days: 180,
        })
      ).status
    ).toBe(200);
    expect((await update({ retention_days: max })).status).toBe(200);
    expect((await update({ retention_days: min - 1 })).status).toBe(400);
    expect((await update({ retention_days: max + 1 })).status).toBe(400);
  });

  it('accepted: optional fields, unknown keys stripped, response echoes retention_days', async () => {
    const result = await update({ retention_days: 365, extra: 'ignored' });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      category: 'lookup_directory',
      retention_days: 365,
      updated_at: expect.any(String) as unknown,
    });
    // shortening below the stored 180 needs confirmation + the matching current value
    expect(await update({ retention_days: 60 })).toEqual({
      status: 409,
      body: {
        error: 'retention_shortening_confirmation_required',
        error_description:
          'Shortening retention requires a fresh estimate and explicit confirmation',
        category: 'lookup_directory',
        current_retention_days: 180,
        requested_retention_days: 60,
      },
    });
    expect(
      (
        await update({
          retention_days: 60,
          confirm_shortening: true,
          expected_current_retention_days: 180,
        })
      ).status
    ).toBe(200);
  });
});
