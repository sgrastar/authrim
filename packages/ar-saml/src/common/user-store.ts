import type { Env } from '@authrim/ar-lib-core';
import {
  ensureDatabaseAdapter,
  resolveCustomClaimRuntimeSourcesFromEnv,
  resolveUserStoreRuntimeSourcesFromEnv,
  type DatabaseAdapter,
} from '@authrim/ar-lib-core';
import type { SAMLAttributeSubject } from '../idp/attributes';

export interface SAMLUserInfo extends SAMLAttributeSubject {
  email: string;
}

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
): Promise<SAMLUserInfo | null> {
  const { coreAdapter, piiAdapter } = await resolveUserStoreAdapters(env, tenantId);
  const userCore = await coreAdapter.queryOne<{ id: string }>(
    'SELECT id FROM users_core WHERE id = ? AND tenant_id = ? AND is_active = 1',
    [userId, tenantId]
  );

  if (!userCore || !piiAdapter) {
    return null;
  }

  const userPII = await piiAdapter.queryOne<{
    email: string;
    name: string | null;
    custom_attributes_json: string | null;
  }>('SELECT email, name, custom_attributes_json FROM users_pii WHERE id = ? AND tenant_id = ?', [
    userId,
    tenantId,
  ]);

  if (!userPII?.email) {
    return null;
  }

  return {
    id: userCore.id,
    email: userPII.email,
    name: userPII.name ?? undefined,
    customClaims: await getNonPiiCustomClaims(env, tenantId, userId),
    customFields: parseCustomFields(userPII.custom_attributes_json),
  };
}

async function getNonPiiCustomClaims(
  env: Env,
  tenantId: string,
  userId: string
): Promise<Record<string, unknown>> {
  try {
    const { nonPiiDb } = await resolveCustomClaimRuntimeSourcesFromEnv(env, tenantId);
    const adapter = ensureDatabaseAdapter(nonPiiDb, 'saml-custom-claims');
    const rows = await adapter.query<{ field_name: string; field_value: string | null }>(
      'SELECT field_name, field_value FROM user_custom_fields WHERE user_id = ? AND tenant_id = ?',
      [userId, tenantId]
    );

    return Object.fromEntries(
      rows
        .filter((row) => row.field_value !== null)
        .map((row) => [row.field_name, parseCustomAttributeValue(row.field_value)])
    );
  } catch {
    return {};
  }
}

function parseCustomFields(value: string | null | undefined): Record<string, unknown> {
  if (!value) {
    return {};
  }

  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseCustomAttributeValue(value: string | null): unknown {
  if (value === null) {
    return undefined;
  }

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
