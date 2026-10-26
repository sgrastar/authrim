import type { Env } from '../../types/env';
import { generateVersion } from '../../utils/settings-manager';
import { readSettingsFlag } from '../../utils/tenant-settings';

type RuntimeSettingsEnv = Pick<Env, 'DB_ADMIN' | 'KEY_MANAGER' | 'PAIRWISE_SALT'>;
const FLOW_KEYS = [
  'feature.enable_login_runtime_flow',
  'feature.login_runtime_flow.enabled',
  'feature.flow_runtime.enabled',
] as const;

function unavailable(): never {
  throw new Error('saml_dr_runtime_settings_authority_unavailable');
}

function requireTenant(tenantId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(tenantId)) unavailable();
}

/** DR runtime reads the same primary, versioned documents that its source snapshot captures. */
export async function readSamlDrFlowRuntimeEnabled(
  env: Pick<RuntimeSettingsEnv, 'DB_ADMIN'>,
  tenantId: string
): Promise<boolean> {
  requireTenant(tenantId);
  if (typeof env.DB_ADMIN?.withSession !== 'function') unavailable();
  const result = await env.DB_ADMIN.withSession('first-primary')
    .prepare(
      `SELECT 'platform' AS scope_type, document_json, version
       FROM platform_settings_documents WHERE category = 'feature-flags'
       UNION ALL
       SELECT 'tenant' AS scope_type, document_json, version
       FROM tenant_settings_documents WHERE tenant_id = ? AND scope_type = 'tenant'
         AND scope_id = ? AND category = 'feature-flags'`
    )
    .bind(tenantId, tenantId)
    .all<{ scope_type: string; document_json: string; version: string }>();
  if (!result.success || !Array.isArray(result.results)) unavailable();
  const documents = new Map<string, Record<string, unknown>>();
  for (const row of result.results) {
    if (
      !['platform', 'tenant'].includes(row.scope_type) ||
      documents.has(row.scope_type) ||
      typeof row.document_json !== 'string' ||
      new TextEncoder().encode(row.document_json).byteLength > 1048576
    )
      unavailable();
    let data: unknown;
    try {
      data = JSON.parse(row.document_json);
    } catch {
      unavailable();
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) unavailable();
    const record = data as Record<string, unknown>;
    if (generateVersion(record) !== row.version) unavailable();
    documents.set(row.scope_type, record);
  }
  const effective = { ...documents.get('platform'), ...documents.get('tenant') };
  const flags = FLOW_KEYS.map((key) => readSettingsFlag(effective, key));
  if (flags.includes(true)) return true;
  if (flags.includes(false)) return false;
  // Legacy KV and environment fallbacks are not a versioned authority for a frozen export.
  return unavailable();
}

/** Read only: enabling export never creates or replaces an existing tenant's consent salt. */
export async function readSamlDrConsentIpSalt(
  env: Pick<RuntimeSettingsEnv, 'KEY_MANAGER'>,
  tenantId: string
): Promise<string> {
  requireTenant(tenantId);
  if (!env.KEY_MANAGER) unavailable();
  const secretRef = `tenant:${tenantId}:consent:ip-salt`;
  const stub = env.KEY_MANAGER.get(env.KEY_MANAGER.idFromName(secretRef));
  if (typeof stub.getExistingSecretRpc !== 'function') unavailable();
  const secret = await stub.getExistingSecretRpc(secretRef);
  if (
    !secret ||
    secret.secretRef !== secretRef ||
    typeof secret.active?.value !== 'string' ||
    secret.active.value.length < 32 ||
    typeof secret.active.kid !== 'string' ||
    secret.active.kid.length === 0 ||
    !Number.isSafeInteger(secret.active.createdAt) ||
    secret.active.createdAt < 0 ||
    !Number.isSafeInteger(secret.updatedAt) ||
    secret.updatedAt < secret.active.createdAt
  )
    unavailable();
  return secret.active.value;
}

export async function readSamlDrRuntimeSettings(env: RuntimeSettingsEnv, tenantId: string) {
  const [sourceFlowRuntimeEnabled, consentIpSalt] = await Promise.all([
    readSamlDrFlowRuntimeEnabled(env, tenantId),
    readSamlDrConsentIpSalt(env, tenantId),
  ]);
  if (!sourceFlowRuntimeEnabled) unavailable();
  if (env.PAIRWISE_SALT !== undefined && env.PAIRWISE_SALT.length < 32) unavailable();
  return {
    sourceFlowRuntimeEnabled,
    consentIpSalt,
    ...(env.PAIRWISE_SALT ? { sourcePairwiseFallbackSecret: env.PAIRWISE_SALT } : {}),
  };
}
