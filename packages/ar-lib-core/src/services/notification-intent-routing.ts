import type { D1Database } from '@cloudflare/workers-types';
import type { AuthCorePersistenceEnv } from './auth-core-persistence-context';
import { resolveTenantDatabaseSourceFromRegistry } from './tenant-database-resolver';

export const PLATFORM_NOTIFICATION_NAMESPACE = 'authrim-platform';
export const PLATFORM_NOTIFICATION_BINDING_REF = 'PLATFORM_NOTIFICATION_DB';

export interface NotificationIntentRoutingEnv extends AuthCorePersistenceEnv {
  PLATFORM_NOTIFICATION_DB?: D1Database;
}

export type NotificationIntentOwner = { owner: 'platform' } | { owner: 'tenant'; tenantId: string };

export interface ResolvedNotificationIntentTarget {
  tenantId: string;
  db: D1Database;
  bindingRef: string;
}

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u;
const SAFE_BINDING = /^(?:[A-Z][A-Z0-9_]*_)?TDB_[A-Z0-9_]{1,120}$/u;

function d1(value: unknown, errorCode: string): D1Database {
  const candidate = value as Partial<D1Database> | null | undefined;
  if (
    !candidate ||
    typeof candidate.prepare !== 'function' ||
    typeof candidate.withSession !== 'function'
  ) {
    throw new Error(errorCode);
  }
  return candidate as D1Database;
}

function platformTarget(env: NotificationIntentRoutingEnv, tenantId: string) {
  return {
    tenantId,
    db: d1(env.PLATFORM_NOTIFICATION_DB, 'notification_intent_platform_database_unavailable'),
    bindingRef: PLATFORM_NOTIFICATION_BINDING_REF,
  };
}

export async function resolveNotificationIntentTarget(
  env: NotificationIntentRoutingEnv,
  input: NotificationIntentOwner
): Promise<ResolvedNotificationIntentTarget> {
  if (input.owner === 'platform') {
    return platformTarget(env, PLATFORM_NOTIFICATION_NAMESPACE);
  }
  if (!SAFE_ID.test(input.tenantId) || input.tenantId === PLATFORM_NOTIFICATION_NAMESPACE) {
    throw new Error('notification_intent_tenant_invalid');
  }

  const resolved = await resolveTenantDatabaseSourceFromRegistry(env, {
    tenantId: input.tenantId,
    role: 'tenant_core',
    dataRole: 'tenant_core/default',
    shardGroup: 'default',
    shardIndex: 0,
    deploymentTarget: env.AUTHRIM_DEPLOYMENT_TARGET,
  });
  if (!SAFE_BINDING.test(resolved.bindingRef)) {
    throw new Error('notification_intent_binding_invalid');
  }
  return {
    tenantId: input.tenantId,
    db: d1(resolved.source, 'notification_intent_tenant_database_unavailable'),
    bindingRef: resolved.bindingRef,
  };
}
