import { createLogReadAdapter } from './log-read-adapter';
import type { Context } from 'hono';
import type { Env, DatabaseAdapter, AuditProfile } from '@authrim/ar-lib-core';
import { resolveTenantRuntimeProfilesFromEnv } from '@authrim/ar-lib-core';

export type AuditHotQueryStatus = 'supported' | 'not_supported' | 'pending_runtime_support';
export type AuditHotQueryMode = 'legacy' | 'unified';
export type AuditHotQueryDialect = 'sqlite' | 'postgres' | 'mysql';
export type AuditCreatedAtUnit = 'seconds' | 'milliseconds';

export interface AuditHotQueryContext {
  adapter: DatabaseAdapter;
  mode: AuditHotQueryMode;
  dialect: AuditHotQueryDialect;
  createdAtUnit: AuditCreatedAtUnit;
  auditProfileId: string;
  archiveRead?: ReturnType<typeof createLogReadAdapter>;
}

export interface AuditHotQuerySqlSpec {
  tableName: 'audit_log' | 'event_log';
  actionColumn: 'action' | 'event_type';
  detailsColumn: 'metadata_json' | 'details_json';
}

export interface AuditHotQuerySupport {
  supported: boolean;
  status: AuditHotQueryStatus;
  auditProfileId: string;
  reason?: string;
  context?: AuditHotQueryContext;
}

export function getAuditHotQuerySupportForProfile(
  env: Env,
  auditProfile: AuditProfile,
  tenantId: string
): AuditHotQuerySupport {
  // Log query capabilities belong to the explicit Iceberg mode, not the former primary store.
  const read = createLogReadAdapter({ env, tenantId, dataset: 'core.event_log' });
  return {
    supported: true,
    status: 'supported',
    auditProfileId: auditProfile.id,
    context: {
      adapter: read.adapter,
      mode: 'unified',
      dialect: 'sqlite',
      createdAtUnit: 'milliseconds',
      auditProfileId: auditProfile.id,
      archiveRead: read,
    },
  };
}

export async function getAuditHotQuerySupport(
  env: Env,
  tenantId: string,
  readOptions?: Pick<
    Parameters<typeof createLogReadAdapter>[0],
    'window' | 'page' | 'onCoverage'
  > & {
    storedCursorTime?: number;
  }
): Promise<AuditHotQuerySupport> {
  const resolved = await resolveTenantRuntimeProfilesFromEnv(env, tenantId);
  const support = getAuditHotQuerySupportForProfile(env, resolved.auditProfile, tenantId);
  if (support.context) {
    const { storedCursorTime, ...options } = readOptions ?? {};
    const read = createLogReadAdapter({
      env,
      tenantId,
      dataset: 'core.event_log',
      ...options,
      window:
        storedCursorTime === undefined
          ? options.window
          : {
              ...options.window,
              toMs: Math.min(options.window?.toMs ?? Number.MAX_SAFE_INTEGER, storedCursorTime),
            },
    });
    support.context = { ...support.context, adapter: read.adapter, archiveRead: read };
  }
  return support;
}

export function getAuditHotQuerySqlSpec(context: AuditHotQueryContext): AuditHotQuerySqlSpec {
  if (context.mode === 'unified') {
    return {
      tableName: 'event_log',
      actionColumn: 'event_type',
      detailsColumn: 'details_json',
    };
  }

  return {
    tableName: 'audit_log',
    actionColumn: 'action',
    detailsColumn: 'metadata_json',
  };
}

export function getAuditTimeRange(
  fromTs: number,
  toTs: number,
  context: AuditHotQueryContext
): [number, number] {
  if (context.createdAtUnit === 'milliseconds') {
    return [fromTs * 1000, toTs * 1000];
  }
  return [fromTs, toTs];
}

export function fromStoredAuditTimestamp(createdAt: number, context: AuditHotQueryContext): string {
  return new Date(
    context.createdAtUnit === 'milliseconds' ? createdAt : createdAt * 1000
  ).toISOString();
}

export function createAuditHotQueryUnsupportedResponse(
  c: Context<{ Bindings: Env }>,
  support: AuditHotQuerySupport
): Response {
  return c.json(
    {
      error: 'not_supported',
      error_description: support.reason,
      profile_id: support.auditProfileId,
      hot_query_status: support.status,
    },
    501
  );
}

export async function requireAuditHotQuerySupport(
  c: Context<{ Bindings: Env }>,
  tenantId: string
): Promise<Response | null> {
  const support = await getAuditHotQuerySupport(c.env, tenantId);
  if (support.supported) {
    return null;
  }

  return createAuditHotQueryUnsupportedResponse(c, support);
}
