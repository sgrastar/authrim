/**
 * The lookup retention policy is written only if it is still the generation the decision (and
 * the step-up) was made on, on the real Core schema. A write that loses reports nothing written:
 * no policy change, no projection outbox row, no history row.
 */
const state = vi.hoisted(() => ({
  adapter: undefined as unknown as import('@authrim/ar-lib-core').DatabaseAdapter,
  gate: vi.fn(async (): Promise<Response | null> => null),
}));
vi.mock('../admin-step-up-gate', () => ({
  requireAdminStepUp: state.gate,
  refuseAdminFreshAuth: vi.fn(),
}));
vi.mock('../admin-tenant-access', () => ({
  getAdminAuth: vi.fn(() => ({ userId: 'admin-a' })),
}));
vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getTenantIdFromContext: vi.fn(() => 'tenant-a'),
    createAuthContextFromHono: vi.fn(() => ({ coreAdapter: state.adapter })),
    createAuditLogFromContext: vi.fn(async () => undefined),
    getLogger: vi.fn(() => ({
      module: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
    })),
    ensureDatabaseAdapter: vi.fn(() => state.adapter),
  };
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { updateCategoryRetention } from '../routes/settings/data-retention';
import { openCoreStore } from './helpers/core-schema-sqlite';

function context(body: Record<string, unknown>) {
  return {
    req: { param: vi.fn(() => 'lookup_directory'), json: vi.fn(async () => body) },
    env: {},
    json: (value: unknown, status: number = 200): Response =>
      new Response(JSON.stringify(value), { status }),
  } as unknown as Parameters<typeof updateCategoryRetention>[0];
}

describe('lookup retention is written against the generation that was read', () => {
  let db: ReturnType<typeof openCoreStore>['db'];
  const count = (table: string) =>
    (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  const policy = () =>
    db
      .prepare(
        'SELECT retention_days, policy_generation FROM lookup_retention_policies WHERE tenant_id = ?'
      )
      .get('tenant-a') as { retention_days: number; policy_generation: number } | undefined;

  beforeEach(() => {
    const store = openCoreStore('tenant-a');
    db = store.db;
    state.adapter = store.adapter;
    // Creating the tenant seeds a policy; these tests set the starting point themselves.
    for (const table of [
      'lookup_retention_policy_projection_outbox',
      'lookup_retention_policies',
      'settings_history',
    ])
      db.prepare(`DELETE FROM ${table}`).run();
    state.gate.mockReset();
    state.gate.mockResolvedValue(null);
  });

  it('creates the policy when there was none', async () => {
    expect((await updateCategoryRetention(context({ retention_days: 365 }))).status).toBe(200);
    expect(policy()).toEqual({ retention_days: 365, policy_generation: 1 });
    expect(count('lookup_retention_policy_projection_outbox')).toBe(1);
    expect(count('settings_history')).toBe(1);
  });

  it('refuses a create when a policy appeared meanwhile, writing nothing', async () => {
    state.gate.mockImplementationOnce(async () => null);
    // The read sees no row; the row is inserted before the write (a shortening needs the gate, so
    // use it to interleave).
    const response = await (async () => {
      const original = state.adapter as { queryOne: (...args: unknown[]) => Promise<unknown> };
      const queryOne = original.queryOne.bind(original);
      original.queryOne = async (...args: unknown[]) => {
        const result = await queryOne(...args);
        db.prepare(
          `INSERT INTO lookup_retention_policies VALUES ('tenant-a', 500, 7, 'other', 1, 1)`
        ).run();
        return result;
      };
      return updateCategoryRetention(context({ retention_days: 365 }));
    })();
    expect(response.status).toBe(409);
    expect(policy()).toEqual({ retention_days: 500, policy_generation: 7 });
    expect(count('lookup_retention_policy_projection_outbox')).toBe(0);
    expect(count('settings_history')).toBe(0);
  });

  it('refuses a shortening when the policy changed during the step-up, writing nothing', async () => {
    db.prepare(
      `INSERT INTO lookup_retention_policies VALUES ('tenant-a', 400, 3, 'admin-a', 1, 1)`
    ).run();
    state.gate.mockImplementationOnce(async () => {
      db.prepare(
        `UPDATE lookup_retention_policies SET retention_days = 1000, policy_generation = 4 WHERE tenant_id = 'tenant-a'`
      ).run();
      return null;
    });
    const response = await updateCategoryRetention(
      context({
        retention_days: 90,
        confirm_shortening: true,
        expected_current_retention_days: 400,
      })
    );
    expect(response.status).toBe(409);
    expect(policy()).toEqual({ retention_days: 1000, policy_generation: 4 });
    expect(count('lookup_retention_policy_projection_outbox')).toBe(0);
    expect(count('settings_history')).toBe(0);
  });

  it('writes the next generation when nothing changed', async () => {
    db.prepare(
      `INSERT INTO lookup_retention_policies VALUES ('tenant-a', 400, 3, 'admin-a', 1, 1)`
    ).run();
    expect((await updateCategoryRetention(context({ retention_days: 500 }))).status).toBe(200);
    expect(policy()).toEqual({ retention_days: 500, policy_generation: 4 });
    expect(count('lookup_retention_policy_projection_outbox')).toBe(1);
    expect(count('settings_history')).toBe(1);
  });

  it('answers the loser of two identical concurrent writes with a conflict, not an error', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    db.prepare(
      `INSERT INTO lookup_retention_policies VALUES ('tenant-a', 400, 3, 'admin-a', 1, 1)`
    ).run();
    const adapter = state.adapter as unknown as {
      queryOne: (...args: unknown[]) => Promise<unknown>;
    };
    const queryOne = adapter.queryOne.bind(adapter);
    let inner: Response | undefined;
    let interleaved = false;
    adapter.queryOne = async (...args: unknown[]) => {
      const result = await queryOne(...args);
      // The outer request has read generation 3; an identical request completes before it writes.
      if (!interleaved) {
        interleaved = true;
        inner = await updateCategoryRetention(context({ retention_days: 500 }));
      }
      return result;
    };
    const outer = await updateCategoryRetention(context({ retention_days: 500 }));
    vi.restoreAllMocks();
    expect(inner?.status).toBe(200);
    expect(outer.status).toBe(409);
    expect(policy()).toEqual({ retention_days: 500, policy_generation: 4 });
    expect(count('lookup_retention_policy_projection_outbox')).toBe(1);
    expect(count('settings_history')).toBe(1);
  });
});
