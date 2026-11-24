/* eslint-disable @typescript-eslint/no-explicit-any -- shared fakes for untyped admin route tests */
import { Hono } from 'hono';
import type { Mock } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';
import {
  adminLoggingRouter,
  destinationsRouter,
  loggingPoliciesRouter,
  notificationsRouter,
} from '../routes/admin-management/logging-control';
import { must } from './helpers/must';

/** Shared fakes for the logging-control mutation tests (no vi.mock here: each test file hoists its own). */

type AnyMock = Mock<(...args: any[]) => any>;

export interface FakeAdapter {
  query: AnyMock;
  queryOne: AnyMock;
  execute: AnyMock;
  batch: AnyMock;
  transaction: AnyMock;
}

export type SqlRule = {
  match: RegExp;
  result: unknown;
};

function resolveRule(rules: SqlRule[], sql: string, params: unknown[], fallback: unknown) {
  const rule = rules.find((r) => r.match.test(sql));
  if (!rule) return fallback;
  return typeof rule.result === 'function'
    ? (rule.result as (s: string, p: unknown[]) => unknown)(sql, params)
    : rule.result;
}

/** SQL-keyed responses: the first rule whose regex matches wins; unmatched queries are empty. */
export function routeSql(
  adapter: FakeAdapter,
  rules: { one?: SqlRule[]; many?: SqlRule[]; exec?: SqlRule[] }
) {
  adapter.queryOne.mockImplementation(async (sql: string, params: unknown[] = []) =>
    resolveRule(rules.one ?? [], sql, params, null)
  );
  adapter.query.mockImplementation(async (sql: string, params: unknown[] = []) =>
    resolveRule(rules.many ?? [], sql, params, [])
  );
  adapter.execute.mockImplementation(async (sql: string, params: unknown[] = []) =>
    resolveRule(rules.exec ?? [], sql, params, { rowsAffected: 1 })
  );
}

export function resetAdapter(adapter: FakeAdapter) {
  adapter.query.mockReset().mockResolvedValue([]);
  adapter.queryOne.mockReset().mockResolvedValue(null);
  adapter.execute.mockReset().mockResolvedValue({ rowsAffected: 1 });
  adapter.batch.mockReset().mockResolvedValue([{ rowsAffected: 1 }]);
  adapter.transaction
    .mockReset()
    .mockImplementation(async (cb: (a: unknown) => unknown) => cb(adapter));
}

export function createApp(
  permissions: string[] = [],
  options: { platform?: boolean; tenantId?: string } = {}
) {
  const platform = options.platform ?? false;
  const roles = platform ? ['ar_super_admin'] : ['ar_tenant_admin'];
  const app = new Hono<{ Bindings: Env; Variables: { adminAuth?: unknown; tenantId?: string } }>();
  app.use('*', async (c, next) => {
    c.set('tenantId', options.tenantId ?? 'tenant-a');
    c.set('adminAuth', {
      userId: 'admin-1',
      permissions,
      roles,
      globalRoles: platform ? roles : [],
      globalPermissions: platform ? permissions : [],
      tenantScope: platform ? ['*'] : ['tenant-a'],
    });
    await next();
  });
  app.route('/api/admin/destinations', destinationsRouter);
  app.route('/api/admin/logging-policies', loggingPoliciesRouter);
  app.route('/api/admin/admin-logging', adminLoggingRouter);
  app.route('/api/admin/notifications', notificationsRouter);
  return app;
}

export function json(body: unknown, init: RequestInit = {}): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    body: JSON.stringify(body),
    ...init,
  };
}

export function destinationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'dest_1',
    scope_type: 'platform',
    scope_id: 'global',
    destination_kind: 'object_storage',
    provider: 'r2',
    name: 'archive',
    display_name: 'Archive',
    description: null,
    lifecycle_status: 'active',
    health_status: 'configured',
    rotation_status: 'none',
    provider_config: JSON.stringify({ bindingRef: 'AUDIT_ARCHIVE' }),
    credential_ref: null,
    credential_version: 0,
    next_credential_ref: null,
    next_credential_version: null,
    previous_credential_ref: null,
    previous_credential_retire_after: null,
    allowed_tenant_ids: null,
    allowed_log_types: null,
    allowed_planes: null,
    region: null,
    critical_allowed: 0,
    default_fallback_eligible: 0,
    retention_days: 30,
    encryption_mode: 'platform_managed',
    last_health_check_at: null,
    version: 1,
    ...overrides,
  };
}

/**
 * Fake for logging_message_jobs: INSERTs are recorded, and reads of a job id rebuild the row from the
 * inserted column list. Other SQL falls through to `fallback` (default: no row / empty).
 */
export function installMessageJobStore(
  adapter: FakeAdapter,
  fallback: { one?: SqlRule[]; many?: SqlRule[]; exec?: SqlRule[] } = {}
) {
  const jobs = new Map<string, Record<string, unknown>>();
  const inserts: Array<Record<string, unknown>> = [];
  adapter.execute.mockImplementation(async (sql: string, params: unknown[] = []) => {
    if (/INSERT INTO logging_message_jobs\s*\(/.test(sql)) {
      const cols = must(/INSERT INTO logging_message_jobs\s*\(([\s\S]*?)\)\s*VALUES/.exec(sql))[1]
        .split(',')
        .map((s) => s.trim());
      const row: Record<string, unknown> = {};
      cols.forEach((col, index) => (row[col] = params[index]));
      jobs.set(String(row.id), row);
      inserts.push(row);
      return { rowsAffected: 1 };
    }
    return resolveRule(fallback.exec ?? [], sql, params, { rowsAffected: 1 });
  });
  adapter.queryOne.mockImplementation(async (sql: string, params: unknown[] = []) => {
    if (/FROM logging_message_jobs/.test(sql) && /WHERE id = \?/.test(sql)) {
      return jobs.get(String(params[0])) ?? null;
    }
    return resolveRule(fallback.one ?? [], sql, params, null);
  });
  adapter.query.mockImplementation(async (sql: string, params: unknown[] = []) =>
    resolveRule(fallback.many ?? [], sql, params, [])
  );
  return { jobs, inserts };
}

/** An R2 object whose text()/size mimic an object body. */
export function textObject(text: string, extra: Record<string, unknown> = {}) {
  return {
    size: new TextEncoder().encode(text).byteLength,
    text: async () => text,
    ...extra,
  } as unknown as R2ObjectBody;
}

export function fanoutPayload(tenantKey: string, overrides: Record<string, unknown> = {}) {
  return {
    payload_type: 'delivery_fanout',
    schema_version: 1,
    payload_id: 'qpl_original',
    tenant_key: tenantKey,
    lane: 'default',
    created_at: 1000,
    catalog_id: 'obj_1',
    object_key: 'logs/chunk.jsonl',
    destination_id: 'dest_1',
    log_type: 'diagnostic',
    plane: 'diagnostic_detail',
    record_count: 3,
    ...overrides,
  };
}
