import type { Context } from 'hono';
import type { Env, DatabaseAdapter, AuditProfile } from '@authrim/ar-lib-core';
import {
  createAuditPrimaryDatabaseAdapter,
  resolveTenantRuntimeProfilesFromEnv,
} from '@authrim/ar-lib-core';

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
  auditProfile: AuditProfile
): AuditHotQuerySupport {
  if (!auditProfile.primary) {
    return {
      supported: false,
      status: 'not_supported',
      auditProfileId: auditProfile.id,
      reason: 'archive-only audit profiles do not expose a hot query store',
    };
  }

  if (auditProfile.primary.type === 'd1') {
    const adapter = createAuditPrimaryDatabaseAdapter(
      env as unknown as Record<string, unknown>,
      auditProfile.primary,
      'audit-hot-query'
    );
    if (!adapter) {
      return {
        supported: false,
        status: 'pending_runtime_support',
        auditProfileId: auditProfile.id,
        reason: `d1 audit primary binding was not resolved: ${auditProfile.primary.bindingRef ?? 'DB'}`,
      };
    }

    return {
      supported: true,
      status: 'supported',
      auditProfileId: auditProfile.id,
      context: {
        adapter,
        mode: 'unified',
        dialect: 'sqlite',
        createdAtUnit: 'milliseconds',
        auditProfileId: auditProfile.id,
      },
    };
  }

  if (auditProfile.primary.type === 'postgres') {
    const adapter = createAuditPrimaryDatabaseAdapter(
      env as unknown as Record<string, unknown>,
      auditProfile.primary,
      'audit-hot-query'
    );
    if (!adapter) {
      return {
        supported: false,
        status: 'pending_runtime_support',
        auditProfileId: auditProfile.id,
        reason: 'postgres audit primary is configured but no Hyperdrive binding was resolved',
      };
    }

    return {
      supported: true,
      status: 'supported',
      auditProfileId: auditProfile.id,
      context: {
        adapter,
        mode: 'unified',
        dialect: 'postgres',
        createdAtUnit: 'milliseconds',
        auditProfileId: auditProfile.id,
      },
    };
  }

  if (auditProfile.primary.type === 'mysql') {
    const adapter = createAuditPrimaryDatabaseAdapter(
      env as unknown as Record<string, unknown>,
      auditProfile.primary,
      'audit-hot-query'
    );
    if (!adapter) {
      return {
        supported: false,
        status: 'pending_runtime_support',
        auditProfileId: auditProfile.id,
        reason: 'mysql audit primary is configured but no Hyperdrive binding was resolved',
      };
    }

    return {
      supported: true,
      status: 'supported',
      auditProfileId: auditProfile.id,
      context: {
        adapter,
        mode: 'unified',
        dialect: 'mysql',
        createdAtUnit: 'milliseconds',
        auditProfileId: auditProfile.id,
      },
    };
  }

  return {
    supported: false,
    status: 'pending_runtime_support',
    auditProfileId: auditProfile.id,
    reason: `audit primary type "${auditProfile.primary.type}" is not implemented yet`,
  };
}

export async function getAuditHotQuerySupport(
  env: Env,
  tenantId: string
): Promise<AuditHotQuerySupport> {
  const resolved = await resolveTenantRuntimeProfilesFromEnv(env, tenantId);
  return getAuditHotQuerySupportForProfile(env, resolved.auditProfile);
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
