import type { Env } from '@authrim/ar-lib-core';
import {
  ensureDatabaseAdapter,
  resolveUserStoreRuntimeSourcesFromEnv,
  type DatabaseAdapter,
} from '@authrim/ar-lib-core';

async function resolveUserStoreAdapters(
  env: Env,
  tenantId: string
): Promise<{ coreAdapter: DatabaseAdapter; piiAdapter: DatabaseAdapter | null }> {
  const sources = await resolveUserStoreRuntimeSourcesFromEnv(env, tenantId);
  return {
    coreAdapter: ensureDatabaseAdapter(sources.coreDb, 'saml-user-core'),
    piiAdapter: sources.piiDb ? ensureDatabaseAdapter(sources.piiDb, 'saml-user-pii') : null,
  };
}

export async function findActiveSamlUserByEmail(
  env: Env,
  tenantId: string,
  email: string
): Promise<{ id: string } | null> {
  const { coreAdapter, piiAdapter } = await resolveUserStoreAdapters(env, tenantId);
  if (!piiAdapter) {
    return null;
  }

  const userPII = await piiAdapter.queryOne<{ id: string }>(
    'SELECT id FROM users_pii WHERE tenant_id = ? AND email = ?',
    [tenantId, email]
  );
  if (!userPII) {
    return null;
  }

  const userCore = await coreAdapter.queryOne<{ id: string }>(
    'SELECT id FROM users_core WHERE id = ? AND tenant_id = ? AND is_active = 1',
    [userPII.id, tenantId]
  );

  return userCore ? { id: userCore.id } : null;
}

export async function getSamlUserNameIdById(
  env: Env,
  tenantId: string,
  userId: string
): Promise<string | null> {
  const { piiAdapter } = await resolveUserStoreAdapters(env, tenantId);
  if (!piiAdapter) {
    return null;
  }

  const userPII = await piiAdapter.queryOne<{ email: string }>(
    'SELECT email FROM users_pii WHERE id = ? AND tenant_id = ?',
    [userId, tenantId]
  );
  return userPII?.email ?? null;
}

export async function getSamlUserInfoById(
  env: Env,
  tenantId: string,
  userId: string
): Promise<{ id: string; email: string; name?: string } | null> {
  const { coreAdapter, piiAdapter } = await resolveUserStoreAdapters(env, tenantId);
  const userCore = await coreAdapter.queryOne<{ id: string }>(
    'SELECT id FROM users_core WHERE id = ? AND tenant_id = ? AND is_active = 1',
    [userId, tenantId]
  );

  if (!userCore || !piiAdapter) {
    return null;
  }

  const userPII = await piiAdapter.queryOne<{ email: string; name: string | null }>(
    'SELECT email, name FROM users_pii WHERE id = ? AND tenant_id = ?',
    [userId, tenantId]
  );

  if (!userPII?.email) {
    return null;
  }

  return {
    id: userCore.id,
    email: userPII.email,
    name: userPII.name ?? undefined,
  };
}
