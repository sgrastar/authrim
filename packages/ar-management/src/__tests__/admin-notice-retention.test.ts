import { describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter, Env, PreparedStatement } from '@authrim/ar-lib-core';

const mocks = vi.hoisted(() => {
  const values: Record<string, unknown> = {};
  const batches: PreparedStatement[][] = [];
  return { values, fail: false, batches };
});

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    resolvePlatformSettingsWithSources: vi.fn(async () => {
      if (mocks.fail) throw new Error('KV down');
      return { values: mocks.values, sources: {} };
    }),
    requireDedicatedAdminDatabaseAdapter: vi.fn(
      (): Partial<DatabaseAdapter> => ({
        batch: async (statements: PreparedStatement[]) => {
          mocks.batches.push(statements);
          return statements.map(() => ({ rowsAffected: 0, success: true }));
        },
      })
    ),
  };
});

import {
  adminNoticeRetentionDays,
  processScheduledAdminNoticeRetention,
} from '../admin-notice-retention';

const env = {} as Env;
const DAY = 24 * 60 * 60 * 1000;
const log = { info: vi.fn(), warn: vi.fn() };

describe('admin notice retention', () => {
  it('reads the platform setting and falls back to the default', async () => {
    mocks.fail = false;
    mocks.values = { 'admin-notices.retention_days': 14 };
    expect(await adminNoticeRetentionDays(env)).toBe(14);
    mocks.values = {};
    expect(await adminNoticeRetentionDays(env)).toBe(90);
    mocks.values = { 'admin-notices.retention_days': '30' };
    expect(await adminNoticeRetentionDays(env)).toBeNull();
    mocks.values = { 'admin-notices.retention_days': 0 };
    expect(await adminNoticeRetentionDays(env)).toBeNull();
    mocks.values = { 'admin-notices.retention_days': null };
    expect(await adminNoticeRetentionDays(env)).toBeNull();
    mocks.fail = true;
    expect(await adminNoticeRetentionDays(env)).toBeNull();
    mocks.fail = false;
  });

  it('deletes nothing while the retention cannot be read', async () => {
    mocks.fail = true;
    mocks.batches = [];
    expect(await processScheduledAdminNoticeRetention(env, log, 100 * DAY)).toBeNull();
    expect(mocks.batches).toEqual([]);
    expect(log.warn).toHaveBeenCalled();
    mocks.fail = false;
  });

  it('deletes what was handled before now minus the retention', async () => {
    mocks.values = { 'admin-notices.retention_days': 30 };
    mocks.batches = [];
    const now = 100 * DAY;
    expect(await processScheduledAdminNoticeRetention(env, log, now)).toEqual({
      deleted: 0,
      retentionDays: 30,
    });
    const [dismissals, notices] = mocks.batches[0];
    expect(dismissals.sql).toContain('DELETE FROM admin_notice_dismissals');
    expect(notices.sql).toContain('DELETE FROM admin_notices');
    expect(notices.params?.[0]).toBe(70 * DAY);
  });
});
