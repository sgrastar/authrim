import { DatabaseSync, type SQLInputValue } from './test-sqlite';
import { describe, expect, it, vi } from 'vitest';

const holder = vi.hoisted(() => ({ adapter: null as unknown }));

vi.mock('@authrim/ar-lib-core', () => ({
  createLogger: () => ({ module: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }),
  ensureAdminDatabaseAdapter: () => holder.adapter,
  ensureDatabaseAdapter: vi.fn(),
  getDefaultTenantId: vi.fn(),
  isMultiTenantEnabled: vi.fn(),
  isValidTenantIdentifier: () => true,
  listEnvironmentTenantDefaultStores: vi.fn(),
  storeImmediateChunkedSensitiveDetailJson: vi.fn(),
}));

import { listTokenRefreshRuns } from '../services/token-refresh';

/**
 * A scheduled run is one pass over several tenants. What a tenant is shown of it is its own part;
 * the cursors name other tenants, the totals count them, and the configuration the run recorded is
 * the one every tenant shares.
 */

function database() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE admin_external_token_refresh_runs (
      id TEXT PRIMARY KEY, trigger_type TEXT NOT NULL, status TEXT NOT NULL,
      requested_tenant_id TEXT, actor_type TEXT, actor_id TEXT, config_json TEXT NOT NULL,
      selected_tenants_count INTEGER NOT NULL DEFAULT 0, processed_tenants INTEGER NOT NULL DEFAULT 0,
      failed_tenants INTEGER NOT NULL DEFAULT 0, tokens_refreshed INTEGER NOT NULL DEFAULT 0,
      cursor_before TEXT, cursor_after TEXT, detail_object_catalog_id TEXT, error_message TEXT,
      started_at INTEGER NOT NULL, completed_at INTEGER);
    CREATE TABLE admin_external_token_refresh_tenant_runs (
      run_id TEXT NOT NULL, tenant_id TEXT NOT NULL, status TEXT NOT NULL,
      tokens_refreshed INTEGER NOT NULL DEFAULT 0, error_message TEXT,
      started_at INTEGER NOT NULL, completed_at INTEGER NOT NULL, PRIMARY KEY (run_id, tenant_id));
    INSERT INTO admin_external_token_refresh_runs VALUES
      ('scheduled', 'scheduled', 'partial_failure', NULL, NULL, NULL, '{"secret":"shared"}',
       3, 3, 1, 12, 'tenant-a', 'tenant-z', 'detail-1', NULL, 100, 200),
      ('manual-a', 'manual_tenant', 'completed', 'tenant-a', 'admin', 'u1', '{"secret":"shared"}',
       1, 1, 0, 4, NULL, NULL, 'detail-2', NULL, 300, 400),
      ('manual-b', 'manual_tenant', 'completed', 'tenant-b', 'admin', 'u2', '{"secret":"shared"}',
       1, 1, 0, 9, NULL, NULL, NULL, NULL, 500, 600);
    INSERT INTO admin_external_token_refresh_tenant_runs VALUES
      ('scheduled', 'tenant-a', 'completed', 5, NULL, 100, 150),
      ('scheduled', 'tenant-b', 'failed', 7, 'boom', 100, 160);
  `);
  holder.adapter = {
    async query(sql: string, params: unknown[] = []) {
      return db.prepare(sql).all(...(params as SQLInputValue[])) as never;
    },
  };
}

describe('listTokenRefreshRuns', () => {
  it('shows a tenant its own part of a scheduled run and its own manual runs only', async () => {
    database();

    const runs = await listTokenRefreshRuns({} as never, 'tenant-a', 50, 'tenant');

    expect(runs.map((run) => run.id)).toEqual(['manual-a', 'scheduled']);
    const scheduled = runs.find((run) => run.id === 'scheduled');
    expect(scheduled).toMatchObject({
      // The pass as a whole ended in a partial failure; this tenant's part did not.
      status: 'completed',
      selected_tenants_count: 1,
      processed_tenants: 1,
      failed_tenants: 0,
      tokens_refreshed: 5,
      cursor_before: null,
      cursor_after: null,
      detail_object_catalog_id: null,
    });
    expect(JSON.stringify(runs)).not.toContain('tenant-z');
    expect(JSON.stringify(runs)).not.toContain('secret');
  });

  it("counts a failed tenant's own failure and its own error only", async () => {
    database();

    const runs = await listTokenRefreshRuns({} as never, 'tenant-b', 50, 'tenant');

    expect(runs.find((run) => run.id === 'scheduled')).toMatchObject({
      status: 'failed',
      processed_tenants: 0,
      failed_tenants: 1,
      tokens_refreshed: 7,
      error_message: 'boom',
    });
  });

  it('gives the platform the whole run, still without the recorded configuration', async () => {
    database();

    const runs = await listTokenRefreshRuns({} as never, 'tenant-a', 50, 'platform');

    expect(runs.find((run) => run.id === 'scheduled')).toMatchObject({
      selected_tenants_count: 3,
      cursor_after: 'tenant-z',
    });
    expect(JSON.stringify(runs)).not.toContain('secret');
  });
});
