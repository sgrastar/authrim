import type { Env } from '@authrim/ar-lib-core';
import {
  ensureDatabaseAdapter,
  CanonicalRuntimeUserProjectionRepository,
  CanonicalSensitiveValueResolver,
  resolveCustomClaimRuntimeSourcesFromEnv,
  resolveUserStoreRuntimeSourcesFromEnv,
  type DatabaseAdapter,
} from '@authrim/ar-lib-core';
import type { SAMLAttributeSubject } from '../idp/attributes';

export type SAMLUserInfo = SAMLAttributeSubject;

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

function createCanonicalProjectionRepository(
  _env: Env,
  tenantId: string,
  coreAdapter: DatabaseAdapter,
  piiAdapter: DatabaseAdapter | null
): CanonicalRuntimeUserProjectionRepository | null {
  if (!piiAdapter) {
    return null;
  }
  return new CanonicalRuntimeUserProjectionRepository(
    coreAdapter,
    tenantId,
    new CanonicalSensitiveValueResolver(piiAdapter)
  );
}

export async function findActiveSamlUserByEmail(
  env: Env,
  tenantId: string,
  email: string
): Promise<{ id: string } | null> {
  const { coreAdapter, piiAdapter } = await resolveUserStoreAdapters(env, tenantId);
  const projectionRepository = createCanonicalProjectionRepository(
    env,
    tenantId,
    coreAdapter,
    piiAdapter
  );
  if (!piiAdapter || !projectionRepository) {
    return null;
  }

  const sensitiveEmail = await piiAdapter.queryOne<{ owner_id: string }>(
    `SELECT owner_id
       FROM identity_sensitive_values
      WHERE tenant_id = ?
        AND owner_type = 'runtime_user'
        AND value_key = 'email'
        AND value_json = ?
        AND lifecycle_state = 'active'
      LIMIT 1`,
    [tenantId, JSON.stringify(email)]
  );
  if (!sensitiveEmail) {
    return null;
  }

  const projection = await projectionRepository.findByLegacyUserId(sensitiveEmail.owner_id);
  return projection?.active ? { id: projection.id } : null;
}

export async function getSamlUserNameIdById(
  env: Env,
  tenantId: string,
  userId: string
): Promise<string | null> {
  const { coreAdapter, piiAdapter } = await resolveUserStoreAdapters(env, tenantId);
  const canonicalProjection = await createCanonicalProjectionRepository(
    env,
    tenantId,
    coreAdapter,
    piiAdapter
  )?.findByLegacyUserId(userId);
  if (canonicalProjection) {
    return canonicalProjection.email;
  }
  return null;
}

export async function getSamlUserInfoById(
  env: Env,
  tenantId: string,
  userId: string
): Promise<SAMLUserInfo | null> {
  const { coreAdapter, piiAdapter } = await resolveUserStoreAdapters(env, tenantId);
  const canonicalProjection = await createCanonicalProjectionRepository(
    env,
    tenantId,
    coreAdapter,
    piiAdapter
  )?.findByLegacyUserId(userId);
  if (canonicalProjection) {
    return {
      id: canonicalProjection.id,
      ...(canonicalProjection.email ? { email: canonicalProjection.email } : {}),
      name: canonicalProjection.name ?? undefined,
      customClaims: await getNonPiiCustomClaims(env, tenantId, userId),
      customFields: parseCustomFields(canonicalProjection.custom_attributes_json),
    };
  }
  return null;
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
