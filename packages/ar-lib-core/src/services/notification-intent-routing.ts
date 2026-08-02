import type { D1Database } from '@cloudflare/workers-types';
import {
  getCachedAuthCorePersistenceContextFromEnv,
  type AuthCorePersistenceEnv,
} from './auth-core-persistence-context';
import { resolveTenantDatabaseSourceForTarget } from './tenant-database-resolver';

export const PLATFORM_NOTIFICATION_NAMESPACE = 'authrim-platform';
export const SHARED_NOTIFICATION_BINDING_REF = 'TDB_SHARED_CORE';

export interface NotificationIntentRoutingEnv extends AuthCorePersistenceEnv {
  TDB_SHARED_CORE?: D1Database;
}

export type NotificationIntentOwner = { owner: 'platform' } | { owner: 'tenant'; tenantId: string };

export interface ResolvedNotificationIntentTarget {
  tenantId: string;
  db: D1Database;
  bindingRef: string;
}

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u;
const SAFE_BINDING = /^TDB_[A-Z0-9_]{1,120}$/u;

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

function sharedTarget(env: NotificationIntentRoutingEnv, tenantId: string) {
  return {
    tenantId,
    db: d1(env.TDB_SHARED_CORE, 'notification_intent_shared_d1_unavailable'),
    bindingRef: SHARED_NOTIFICATION_BINDING_REF,
  };
}

export async function resolveNotificationIntentTarget(
  env: NotificationIntentRoutingEnv,
  input: NotificationIntentOwner
): Promise<ResolvedNotificationIntentTarget> {
  if (input.owner === 'platform') {
    return sharedTarget(env, PLATFORM_NOTIFICATION_NAMESPACE);
  }
  if (!SAFE_ID.test(input.tenantId) || input.tenantId === PLATFORM_NOTIFICATION_NAMESPACE) {
    throw new Error('notification_intent_tenant_invalid');
  }

  const context = await getCachedAuthCorePersistenceContextFromEnv(env);
  if (!context.coreTarget.resolverRef) {
    return sharedTarget(env, input.tenantId);
  }
  const resolved = await resolveTenantDatabaseSourceForTarget(
    env,
    input.tenantId,
    context.coreTarget,
    {
      deploymentTarget: env.AUTHRIM_DEPLOYMENT_TARGET,
      runtimeSnapshotMode:
        context.storageProfile.id === 'builtin:storage:tenant-d1' && env.TENANT_RUNTIME_REGISTRY
          ? 'required'
          : 'optional',
    }
  );
  if (!SAFE_BINDING.test(resolved.bindingRef)) {
    throw new Error('notification_intent_binding_invalid');
  }
  return {
    tenantId: input.tenantId,
    db: d1(resolved.source, 'notification_intent_tenant_d1_unavailable'),
    bindingRef: resolved.bindingRef,
  };
}
