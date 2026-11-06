import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ADMIN_PERMISSIONS, type Env } from '@authrim/ar-lib-core';

const mocks = vi.hoisted(() => ({
  coreQueryOne: vi.fn(),
  resolveStores: vi.fn(),
  storeQueries: new Map<string, ReturnType<typeof vi.fn>>(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    createAuthContextFromHono: vi.fn(() => ({ coreAdapter: { queryOne: mocks.coreQueryOne } })),
    getTenantIdFromContext: vi.fn(() => 'tenant_a'),
    getLogger: vi.fn(() => ({ module: vi.fn(() => ({ error: vi.fn() })) })),
    resolveTenantAssignedDatabaseSourcesFromRegistry: mocks.resolveStores,
    ensureDatabaseAdapter: vi.fn((source: string) => ({ query: mocks.storeQueries.get(source) })),
  };
});

import {
  adminScreenResponsesHandler,
  decodeScreenResponsesCursor,
  encodeScreenResponsesCursor,
  mergeScreenResponsePages,
  type ScreenResponseItem,
} from '../admin-screen-responses';
import { findAdminRouteAccessRule } from '../admin-route-access';

const item = (id: string, createdAt: number): ScreenResponseItem => ({
  id,
  user_id: `user_${id}`,
  screen_key: 'survey',
  flow_id: 'flow_1',
  flow_version_id: 'version_1',
  interaction_id: 'interaction_1',
  step_id: 'screen:step',
  answers: { plan: 'pro' },
  created_at: createdAt,
  updated_at: createdAt,
});

const row = (id: string, createdAt: number) => ({
  ...item(id, createdAt),
  answers: undefined,
  answers_json: JSON.stringify({ plan: 'pro', bad: { nested: true } }),
});

function app() {
  const hono = new Hono<{ Bindings: Env }>();
  hono.get('/api/admin/screens/:id/responses', adminScreenResponsesHandler);
  return hono;
}

function storesHolding(pages: Record<string, ReturnType<typeof row>[]>) {
  mocks.storeQueries.clear();
  mocks.resolveStores.mockResolvedValue(
    Object.keys(pages).map((source) => ({ source, bindingRef: source }))
  );
  for (const [source, rows] of Object.entries(pages)) {
    mocks.storeQueries.set(
      source,
      vi.fn(async () => rows)
    );
  }
}

describe('screen response records', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.coreQueryOne.mockResolvedValue({ id: 'screen_1' });
  });

  it('merges the PII databases newest first and gives the cursor to the next page', async () => {
    storesHolding({
      pii_a: [row('a3', 300), row('a1', 100)],
      pii_b: [row('b2', 200), row('b0', 50)],
    });

    const response = await app().request('/api/admin/screens/screen_1/responses?limit=2', {}, {});
    const body = await response.json<{
      responses: ScreenResponseItem[];
      next_cursor: string | null;
    }>();

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(body.responses.map((response) => response.id)).toEqual(['a3', 'b2']);
    expect(body.responses[0].answers).toEqual({ plan: 'pro' });
    expect(decodeScreenResponsesCursor(body.next_cursor ?? undefined)).toEqual({
      createdAt: 200,
      id: 'b2',
    });
    expect(mocks.resolveStores).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tenantId: 'tenant_a', role: 'tenant_pii' })
    );
    for (const query of mocks.storeQueries.values()) {
      expect(query).toHaveBeenCalledWith(expect.stringContaining('LIMIT ?'), [
        'tenant_a',
        'screen_1',
        3,
      ]);
    }
  });

  it('reads after the cursor in every database', async () => {
    storesHolding({ pii_a: [] });
    const cursor = encodeScreenResponsesCursor({ createdAt: 200, id: 'b2' });

    const response = await app().request(
      `/api/admin/screens/screen_1/responses?cursor=${cursor}`,
      {},
      {}
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ responses: [], next_cursor: null });
    expect(mocks.storeQueries.get('pii_a')).toHaveBeenCalledWith(
      expect.stringContaining('(created_at < ? OR (created_at = ? AND id < ?))'),
      ['tenant_a', 'screen_1', 200, 200, 'b2', 51]
    );
  });

  it('refuses a limit or a cursor it cannot read, and a screen the tenant does not have', async () => {
    storesHolding({ pii_a: [] });
    for (const query of [
      'limit=0',
      'limit=101',
      'limit=abc',
      'cursor=bm90LWpzb24',
      'cursor=%2F%2F',
    ]) {
      const response = await app().request(
        `/api/admin/screens/screen_1/responses?${query}`,
        {},
        {}
      );
      expect(response.status).toBe(400);
    }

    mocks.coreQueryOne.mockResolvedValue(null);
    const missing = await app().request('/api/admin/screens/other/responses', {}, {});
    expect(missing.status).toBe(404);
    expect(mocks.storeQueries.get('pii_a')).not.toHaveBeenCalled();
  });

  it('breaks a tie in time by id, as each database orders its page', () => {
    const merged = mergeScreenResponsePages(
      [[item('x', 100)], [item('y', 100), item('w', 100)]],
      2
    );

    expect(merged.responses.map((response) => response.id)).toEqual(['y', 'x']);
    expect(decodeScreenResponsesCursor(merged.next_cursor ?? undefined)).toEqual({
      createdAt: 100,
      id: 'x',
    });
  });

  it('is read with the permission to read users, not the screen settings', () => {
    const responses = findAdminRouteAccessRule('GET', '/api/admin/screens/screen_1/responses');
    const screen = findAdminRouteAccessRule('GET', '/api/admin/screens/screen_1');

    expect(responses?.permissions).toEqual([ADMIN_PERMISSIONS.USERS_READ]);
    expect(screen?.permissions).toEqual([ADMIN_PERMISSIONS.SETTINGS_READ]);
  });
});
