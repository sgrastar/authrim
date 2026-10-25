/** Actual Admin/Core SQLite and D1 adapter; RP transport/audit delivery are explicit seams. */
import { readFileSync } from 'node:fs';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter, Env } from '@authrim/ar-lib-core';
import { DatabaseSync, type SQLiteDatabase } from './test-sqlite';
import { d1OverSqlite } from './helpers/d1-over-sqlite';
import { insertTenant, openCoreDatabase } from './helpers/core-database';

const state = vi.hoisted(() => ({
  core: null as DatabaseAdapter | null,
  audit: vi.fn(),
  targets: vi.fn(),
}));
vi.mock('@authrim/ar-lib-core', async (original) => {
  const actual = await original<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getTenantIdFromContext: () => 'tenant-a',
    createAuthContextFromHono: () => ({ coreAdapter: state.core }),
    resolveAuthCorePersistenceAdapterFromEnv: async () => state.core,
    resolveLogoutIssuer: async () => 'https://issuer.example.test',
    resolveLogoutConfig: async () => actual.DEFAULT_LOGOUT_CONFIG,
    resolveLogoutWebhookConfig: async () => actual.DEFAULT_LOGOUT_WEBHOOK_CONFIG,
    resolveLogoutTargetsFromSessionClientStore: state.targets,
    purgeEndedSessionsFromSessionClientStore: async () => undefined,
    createAuditLog: state.audit,
    emitRuntimeLogRecords: async () => ({ tenantKey: 'tk_test', targetResults: [] }),
  };
});

import { ensureDatabaseAdapter } from '@authrim/ar-lib-core';
import { phase8RestoreHoldReason } from '@authrim/ar-lib-core/services/tenant-portability/phase8-restore-holds';
import { TENANT_DATASET_POLICIES } from '@authrim/ar-lib-core/services/tenant-portability/dataset-registry';
import {
  processGenericAdminJobNow,
  processPendingGenericAdminJobs,
  processPendingSessionEndLogoutJobs,
} from '../admin-job-executor';
import {
  adminJobGetHandler,
  adminJobsListHandler,
  registerAdminJobPermissionMiddleware,
} from '../admin-jobs';
import {
  enqueueSessionEndLogout,
  SESSION_END_LOGOUT_JOB_TYPE,
  SESSION_REVOKE_LOGOUT_JOB_TYPE,
} from '../session-end-logout';

const log = { info: vi.fn(), error: vi.fn() };
type Job = {
  id: string;
  tenant_id: string;
  job_type: string;
  status: string;
  config: string;
  attempt_count: number;
  next_run_at: number | null;
  dead_lettered_at: number | null;
};

describe('versioned single-session logout: actual job storage', () => {
  let admin: SQLiteDatabase;
  let core: SQLiteDatabase;
  let env: Env;
  let now: number;

  beforeEach(() => {
    now = Date.parse('2026-10-25T00:00:00Z');
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    state.audit.mockReset().mockResolvedValue(undefined);
    state.targets.mockReset().mockResolvedValue({ backchannelClients: [], webhookClients: [] });
    core = openCoreDatabase();
    insertTenant(core, 'tenant-a');
    insertTenant(core, 'tenant-b');
    core.exec('PRAGMA foreign_keys=ON');
    admin = new DatabaseSync(':memory:');
    admin.exec(
      readFileSync(
        new URL('../../../../migrations/admin/d1/001_0_4_0_admin_baseline.sql', import.meta.url),
        'utf8'
      )
        .replaceAll('__AUTHRIM_NOW_PRECISE_EPOCH_MILLISECONDS__', '(unixepoch() * 1000)')
        .replaceAll('__AUTHRIM_NOW_EPOCH_MILLISECONDS__', '(unixepoch() * 1000)')
        .replaceAll('__AUTHRIM_NOW_EPOCH_SECONDS__', 'unixepoch()')
    );
    admin.exec('PRAGMA foreign_keys=ON');
    env = { DB: d1OverSqlite(core), DB_ADMIN: d1OverSqlite(admin) } as Env;
    state.core = ensureDatabaseAdapter(env.DB, 'version-compat-core');
  });
  afterEach(() => {
    core.close();
    admin.close();
    vi.restoreAllMocks();
  });

  async function enqueue(action: 'session.revoke' | 'user.suspend', tenantId = 'tenant-a') {
    const [id] = await enqueueSessionEndLogout(env, {
      tenantId,
      sessions: [{ userId: 'user-a', sessionId: 'ended-session-a' }],
      trigger: { action, actorId: 'admin-a' },
    });
    if (!id) throw new Error('fixture_job_missing');
    return id;
  }
  function row(id: string) {
    return admin.prepare('SELECT * FROM admin_jobs WHERE id=?').get(id) as Job;
  }

  it('keeps an unknown future type untouched by scheduled/inline consumers while legacy jobs still run', async () => {
    const currentId = await enqueue('session.revoke');
    const legacyId = await enqueue('user.suspend');
    expect(row(currentId).job_type).toBe('users/session-end-logout-v2');
    expect(row(legacyId).job_type).toBe(SESSION_END_LOGOUT_JOB_TYPE);
    const futureType = 'users/session-end-logout-future';
    admin.prepare('UPDATE admin_jobs SET job_type=? WHERE id=?').run(futureType, currentId);
    const before = row(currentId);

    for (const elapsed of [0, 60, 360]) {
      now = Date.parse('2026-10-25T00:00:00Z') + elapsed * 1000;
      await processPendingSessionEndLogoutJobs(env, log);
      await processGenericAdminJobNow(env, log, 'tenant-a', currentId);
      expect(row(currentId)).toEqual(before);
    }
    expect(row(legacyId).status).toBe('completed');
    expect(state.targets).toHaveBeenCalledTimes(1);

    // This is a job SQL/claim test, not just a whitelist/string assertion.
    await processPendingGenericAdminJobs(env, log);
    expect(row(currentId)).toEqual(before);
    admin
      .prepare('UPDATE admin_jobs SET job_type=? WHERE id=?')
      .run(SESSION_REVOKE_LOGOUT_JOB_TYPE, currentId);
    await processPendingSessionEndLogoutJobs(env, log);
    expect(row(currentId)).toMatchObject({ status: 'completed', attempt_count: 0 });
    expect(state.targets).toHaveBeenCalledTimes(2);
  });

  it.each(['suspended', 'frozen', 'deleting'])(
    'delivers new logout jobs for a %s tenant',
    async (lifecycle) => {
      core.prepare('UPDATE tenants SET lifecycle_state=? WHERE id=?').run(lifecycle, 'tenant-a');
      const id = await enqueue('session.revoke');
      await processPendingSessionEndLogoutJobs(env, log);
      expect(row(id)).toMatchObject({ status: 'completed', attempt_count: 0 });
    }
  );

  it('preserves legacy job fields, Jobs permissions and tenant-scoped visibility for the versioned type', async () => {
    const ids = [await enqueue('user.suspend'), await enqueue('session.revoke')];
    const foreign = await enqueue('session.revoke', 'tenant-b');
    function app(permissions: string[]) {
      const server = new Hono<{ Bindings: Env; Variables: { adminAuth: unknown } }>();
      server.use('*', async (c, next) => {
        c.set('adminAuth', {
          userId: 'admin-a',
          authMethod: 'session',
          tenantId: 'tenant-a',
          roles: ['tenant_admin'],
          permissions,
          hierarchyLevel: 50,
          mfaVerified: true,
        });
        await next();
      });
      registerAdminJobPermissionMiddleware(server);
      server.get('/api/admin/jobs', adminJobsListHandler);
      server.get('/api/admin/jobs/:id', adminJobGetHandler);
      return server;
    }
    const allowed = app(['admin:jobs:read']);
    const list = await allowed.request('/api/admin/jobs', {}, env);
    expect(list.status).toBe(200);
    const body = await list.json<{ data: Array<{ job_id: string }> }>();
    expect(body.data.map((job) => job.job_id).sort()).toEqual([...ids].sort());
    for (const id of ids) {
      const response = await allowed.request(`/api/admin/jobs/${id}`, {}, env);
      expect(response.status).toBe(200);
      const detail = await response.json<{ parameters: unknown }>();
      expect(detail.parameters).toEqual(JSON.parse(row(id).config));
      expect(Object.keys(detail.parameters as object).sort()).toEqual(['sessions', 'trigger']);
      expect((await app([]).request(`/api/admin/jobs/${id}`, {}, env)).status).toBe(403);
    }
    expect((await allowed.request(`/api/admin/jobs/${foreign}`, {}, env)).status).toBe(404);
  });

  it('retains the existing Admin workflow DR classification and never restores new jobs as live work', async () => {
    const id = await enqueue('session.revoke');
    expect(row(id).job_type).toBe(SESSION_REVOKE_LOGOUT_JOB_TYPE);
    expect(
      TENANT_DATASET_POLICIES.find(
        (policy) => policy.family === 'admin' && policy.table === 'admin_jobs'
      )?.kind
    ).toBe('admin');
    for (const status of ['pending', 'processing', 'completed', 'failed']) {
      const portable = JSON.stringify({
        job_type: ['text', row(id).job_type],
        status: ['text', status],
      });
      expect(phase8RestoreHoldReason('admin.admin_jobs', portable)).toBe('source_admin_workflow');
    }
  });
});
