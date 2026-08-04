/**
 * Token Refresh Service
 * Handles proactive refresh of expiring access tokens for linked identities
 *
 * This service runs as part of the scheduled handler to ensure
 * access tokens remain valid for background operations.
 */

import type { Env } from '@authrim/ar-lib-core';
import {
  type DatabaseAdapter,
  type DatabaseSource,
  type AdminAuthContext,
  createObjectCatalogEntry,
  createLogger,
  ensureAdminDatabaseAdapter,
  ensureDatabaseAdapter,
  getDefaultTenantId,
  listEnvironmentTenantDefaultStores,
} from '@authrim/ar-lib-core';
import type { LinkedIdentity } from '../types';
import { getProvider } from './provider-store';
import { updateLinkedIdentity, decryptLinkedIdentityTokens } from './linked-identity-store';
import { OIDCRPClient } from '../clients/oidc-client';
import { decrypt, getEncryptionKeyOrUndefined } from '../utils/crypto';

const log = createLogger().module('TOKEN-REFRESH');

/**
 * Token refresh configuration
 * Configurable via KV: external_idp_token_refresh
 */
export interface TokenRefreshConfig {
  /** Refresh tokens that expire within this many seconds (default: 5 minutes) */
  refreshThresholdSeconds: number;
  /** Maximum number of tokens to refresh per run (default: 100) */
  batchSize: number;
  /** Maximum number of tenants to refresh per scheduled run (default: 25) */
  scheduledTenantBatchSize: number;
  /** Maximum tenant PII shards scanned per tenant step (default: 4, maximum: 32) */
  piiShardPageSize: number;
  /** Whether proactive scheduled token refresh is enabled (default: false) */
  enabled: boolean;
}

const DEFAULT_TOKEN_REFRESH_CONFIG: TokenRefreshConfig = {
  refreshThresholdSeconds: 3600, // 1 hour
  batchSize: 100,
  scheduledTenantBatchSize: 100,
  piiShardPageSize: 4,
  enabled: false,
};

const MAX_TOKEN_REFRESH_BATCH_SIZE = 1000;
const MAX_SCHEDULED_TENANT_BATCH_SIZE = 100;
const MAX_TOKEN_REFRESH_PII_SHARD_PAGE_SIZE = 32;
const TOKEN_REFRESH_CONFIG_KEY = 'external_idp_token_refresh';
const TOKEN_REFRESH_TENANT_CURSOR_KEY = 'external_idp_token_refresh:tenant_cursor';
const TOKEN_REFRESH_PII_SHARD_CURSOR_PREFIX = 'external_idp_token_refresh:pii_shard_cursor:';
const SAFE_SHARD_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;
const SAFE_BINDING_REF = /^[A-Z][A-Z0-9_]{0,127}$/u;

interface ExpiringIdentityCandidate {
  identity: LinkedIdentity;
  piiSource: DatabaseSource;
}

interface PiiSourcePage {
  cursorKey: string;
  entries: Array<{ shardId: string; source: DatabaseSource }>;
  wrapped: boolean;
}

export interface ScheduledTokenRefreshResult {
  runId: string | null;
  selectedTenants: string[];
  processedTenants: number;
  failedTenants: number;
  tokensRefreshed: number;
  cursorBefore: string | null;
  cursor: string | null;
  tenantResults: TokenRefreshTenantResult[];
}

export interface ManualTokenRefreshResult {
  runId: string | null;
  tenantId: string;
  tokensRefreshed: number;
  status: 'completed' | 'failed';
}

export interface TokenRefreshTenantResult {
  tenantId: string;
  status: 'completed' | 'failed' | 'skipped';
  tokensRefreshed: number;
  errorMessage?: string;
  startedAt: number;
  completedAt: number;
}

export interface TokenRefreshRunSummary {
  id: string;
  trigger_type: 'scheduled' | 'manual_tenant';
  status: 'running' | 'completed' | 'partial_failure' | 'failed';
  requested_tenant_id: string | null;
  actor_type: string | null;
  actor_id: string | null;
  selected_tenants_count: number;
  processed_tenants: number;
  failed_tenants: number;
  tokens_refreshed: number;
  cursor_before: string | null;
  cursor_after: string | null;
  detail_object_catalog_id: string | null;
  error_message: string | null;
  started_at: number;
  completed_at: number | null;
}

interface TokenRefreshRunStartInput {
  triggerType: 'scheduled' | 'manual_tenant';
  requestedTenantId?: string | null;
  actor?: Pick<AdminAuthContext, 'actorType' | 'actorId' | 'authMethod'> | null;
  config: TokenRefreshConfig;
  cursorBefore?: string | null;
}

interface TokenRefreshRunFinishInput {
  runId: string;
  triggerType: 'scheduled' | 'manual_tenant';
  requestedTenantId?: string | null;
  config: TokenRefreshConfig;
  selectedTenants: string[];
  tenantResults: TokenRefreshTenantResult[];
  tokensRefreshed: number;
  cursorBefore?: string | null;
  cursorAfter?: string | null;
  errorMessage?: string | null;
}

/**
 * Refresh tokens that are about to expire
 *
 * @returns Number of tokens successfully refreshed
 */
export async function refreshExpiringTokens(env: Env): Promise<number> {
  return refreshExpiringTokensForTenant(env, getDefaultTenantId(env));
}

/**
 * Refresh tokens that are about to expire for a single tenant.
 *
 * Multi-tenant deployments should call this per tenant from an explicit
 * scheduler/orchestrator. This keeps tenant-specific user-store and PII
 * runtime source resolution intact.
 *
 * @returns Number of tokens successfully refreshed
 */
export async function refreshExpiringTokensForTenant(env: Env, tenantId: string): Promise<number> {
  const config = await getTokenRefreshConfig(env);
  return refreshExpiringTokensForTenantWithConfig(env, tenantId, config);
}

export async function refreshExpiringTokensForTenantManual(
  env: Env,
  tenantId: string,
  actor?: Pick<AdminAuthContext, 'actorType' | 'actorId' | 'authMethod'> | null
): Promise<ManualTokenRefreshResult> {
  const config = await getTokenRefreshConfig(env);
  const runId = await startTokenRefreshRun(env, {
    triggerType: 'manual_tenant',
    requestedTenantId: tenantId,
    actor,
    config,
  });
  const startedAt = Date.now();

  try {
    const tokensRefreshed = await refreshExpiringTokensForTenantWithConfig(env, tenantId, {
      ...config,
      enabled: true,
    });
    const completedAt = Date.now();
    const tenantResults: TokenRefreshTenantResult[] = [
      {
        tenantId,
        status: 'completed',
        tokensRefreshed,
        startedAt,
        completedAt,
      },
    ];
    if (runId) {
      await finishTokenRefreshRun(env, {
        runId,
        triggerType: 'manual_tenant',
        requestedTenantId: tenantId,
        config,
        selectedTenants: [tenantId],
        tenantResults,
        tokensRefreshed,
      });
    }
    return { runId, tenantId, tokensRefreshed, status: 'completed' };
  } catch (error) {
    const completedAt = Date.now();
    const errorMessage = sanitizeErrorMessage(error);
    const tenantResults: TokenRefreshTenantResult[] = [
      {
        tenantId,
        status: 'failed',
        tokensRefreshed: 0,
        errorMessage,
        startedAt,
        completedAt,
      },
    ];
    if (runId) {
      await finishTokenRefreshRun(env, {
        runId,
        triggerType: 'manual_tenant',
        requestedTenantId: tenantId,
        config,
        selectedTenants: [tenantId],
        tenantResults,
        tokensRefreshed: 0,
        errorMessage,
      });
    }
    throw error;
  }
}

async function refreshExpiringTokensForTenantWithConfig(
  env: Env,
  tenantId: string,
  config: TokenRefreshConfig
): Promise<number> {
  if (!config.enabled) {
    return 0;
  }

  const encryptionKey = getEncryptionKeyOrUndefined(env);
  if (!encryptionKey) {
    log.warn('Token refresh skipped: RP_TOKEN_ENCRYPTION_KEY not configured');
    return 0;
  }

  const now = Date.now();
  const threshold = now + config.refreshThresholdSeconds * 1000;

  // Find linked identities with tokens expiring soon
  const expiringIdentities = await findExpiringTokens(
    env,
    tenantId,
    threshold,
    config.batchSize,
    config.piiShardPageSize
  );

  if (expiringIdentities.length === 0) {
    return 0;
  }

  let refreshedCount = 0;

  for (const candidate of expiringIdentities) {
    try {
      const success = await refreshIdentityToken(
        env,
        candidate.identity,
        encryptionKey,
        candidate.piiSource
      );
      if (success) {
        refreshedCount++;
      }
    } catch (error) {
      // PII Protection: Don't log full error object (may contain token info)
      log.error('Failed to refresh token for identity', {
        errorName: error instanceof Error ? error.name : 'Unknown error',
      });
      // Continue with other tokens
    }
  }

  return refreshedCount;
}

/**
 * Refresh expiring tokens for a bounded batch of active tenants.
 *
 * The scheduled worker stores a tenant ID cursor in SETTINGS and advances it
 * after each run. This avoids scanning every tenant on every cron tick.
 */
export async function refreshExpiringTokensForScheduledTenants(
  env: Env
): Promise<ScheduledTokenRefreshResult> {
  const config = await getTokenRefreshConfig(env);
  if (!config.enabled) {
    return {
      runId: null,
      selectedTenants: [],
      processedTenants: 0,
      failedTenants: 0,
      tokensRefreshed: 0,
      cursorBefore: null,
      cursor: null,
      tenantResults: [],
    };
  }

  const cursorBefore = await getTokenRefreshCursor(env);
  const runId = await startTokenRefreshRun(env, {
    triggerType: 'scheduled',
    config,
    cursorBefore,
  });
  const tenantIds = await listNextTokenRefreshTenantIds(env, config.scheduledTenantBatchSize);
  let tokensRefreshed = 0;
  let processedTenants = 0;
  let failedTenants = 0;
  const tenantResults: TokenRefreshTenantResult[] = [];

  for (const tenantId of tenantIds) {
    const startedAt = Date.now();
    try {
      const tenantTokensRefreshed = await refreshExpiringTokensForTenantWithConfig(
        env,
        tenantId,
        config
      );
      tokensRefreshed += tenantTokensRefreshed;
      processedTenants += 1;
      tenantResults.push({
        tenantId,
        status: 'completed',
        tokensRefreshed: tenantTokensRefreshed,
        startedAt,
        completedAt: Date.now(),
      });
    } catch (error) {
      failedTenants += 1;
      tenantResults.push({
        tenantId,
        status: 'failed',
        tokensRefreshed: 0,
        errorMessage: sanitizeErrorMessage(error),
        startedAt,
        completedAt: Date.now(),
      });
      log.error('Scheduled token refresh failed for tenant', { tenantId }, error as Error);
    }
  }

  const cursor = tenantIds.at(-1) ?? null;
  if (cursor && env.SETTINGS) {
    await env.SETTINGS.put(TOKEN_REFRESH_TENANT_CURSOR_KEY, cursor);
  }

  if (runId) {
    await finishTokenRefreshRun(env, {
      runId,
      triggerType: 'scheduled',
      config,
      selectedTenants: tenantIds,
      tenantResults,
      tokensRefreshed,
      cursorBefore,
      cursorAfter: cursor,
    });
  }

  return {
    runId,
    selectedTenants: tenantIds,
    processedTenants,
    failedTenants,
    tokensRefreshed,
    cursorBefore,
    cursor,
    tenantResults,
  };
}

async function listNextTokenRefreshTenantIds(env: Env, batchSize: number): Promise<string[]> {
  const cursor = (await env.SETTINGS?.get(TOKEN_REFRESH_TENANT_CURSOR_KEY)) ?? null;
  const page = await listEnvironmentTenantDefaultStores(env, {
    limit: batchSize,
    afterTenantId: cursor ?? undefined,
  });
  if (page.length > 0 || !cursor) return page.map((entry) => entry.tenantId);
  return (
    await listEnvironmentTenantDefaultStores(env, {
      limit: batchSize,
    })
  ).map((entry) => entry.tenantId);
}

/**
 * Find linked identities with tokens expiring before threshold
 */
async function findExpiringTokens(
  env: Env,
  tenantId: string,
  threshold: number,
  limit: number,
  piiShardPageSize: number
): Promise<ExpiringIdentityCandidate[]> {
  const piiSourcePage = await listPiiSources(env, tenantId, piiShardPageSize);
  const piiSources = piiSourcePage.entries;
  const candidates: ExpiringIdentityCandidate[] = [];
  let lastProcessedShardId: string | null = null;

  for (const pii of piiSources) {
    const remaining = limit - candidates.length;
    if (remaining <= 0) break;
    const adapter: DatabaseAdapter = ensureDatabaseAdapter(pii.source, 'bridge-token-refresh');
    const result = await adapter.query<DbLinkedIdentity>(
      `SELECT * FROM linked_identities
       WHERE tenant_id = ?
         AND provisioning_state = 'active'
         AND token_expires_at IS NOT NULL
         AND token_expires_at < ?
         AND token_expires_at > ?
         AND refresh_token_encrypted IS NOT NULL
       ORDER BY token_expires_at ASC
       LIMIT ?`,
      [tenantId, threshold, Date.now(), remaining]
    );
    candidates.push(
      ...result.map((row) => ({ identity: mapDbToLinkedIdentity(row), piiSource: pii.source }))
    );
    lastProcessedShardId = pii.shardId;
  }

  if (lastProcessedShardId) {
    const scannedWholePage = lastProcessedShardId === piiSourcePage.entries.at(-1)?.shardId;
    if (scannedWholePage && piiSourcePage.wrapped) {
      await env.SETTINGS?.delete(piiSourcePage.cursorKey);
    } else {
      await env.SETTINGS?.put(piiSourcePage.cursorKey, lastProcessedShardId);
    }
  }

  candidates.sort(
    (left, right) =>
      (left.identity.tokenExpiresAt ?? Number.MAX_SAFE_INTEGER) -
        (right.identity.tokenExpiresAt ?? Number.MAX_SAFE_INTEGER) ||
      left.identity.id.localeCompare(right.identity.id)
  );
  return candidates.slice(0, limit);
}

async function listPiiSources(
  env: Env,
  tenantId: string,
  pageSize: number
): Promise<PiiSourcePage> {
  if (!env.SETTINGS || !env.EXTERNAL_IDP_ACCOUNT_PROVISIONER) {
    throw new Error('external_idp_token_refresh_shard_inventory_unavailable');
  }
  const cursorKey = `${TOKEN_REFRESH_PII_SHARD_CURSOR_PREFIX}${tenantId}`;
  const afterShardId = await env.SETTINGS.get(cursorKey);
  let shards = await env.EXTERNAL_IDP_ACCOUNT_PROVISIONER.listExternalIdpPiiSourceShards({
    schemaVersion: 1,
    afterShardId,
    limit: pageSize,
  });
  if (!Array.isArray(shards) || shards.length > pageSize) {
    throw new Error('external_idp_token_refresh_shard_inventory_invalid');
  }
  let wrapped = shards.length < pageSize;
  if (shards.length === 0 && afterShardId !== null) {
    shards = await env.EXTERNAL_IDP_ACCOUNT_PROVISIONER.listExternalIdpPiiSourceShards({
      schemaVersion: 1,
      afterShardId: null,
      limit: pageSize,
    });
    if (!Array.isArray(shards) || shards.length > pageSize) {
      throw new Error('external_idp_token_refresh_shard_inventory_invalid');
    }
    wrapped = shards.length < pageSize;
  }
  if (shards.length === 0) throw new Error('external_idp_token_refresh_shard_inventory_empty');

  const seen = new Set<string>();
  const entries = shards.map((shard) => {
    const raw = shard as unknown as Record<string, unknown>;
    if (
      !raw ||
      typeof raw !== 'object' ||
      Array.isArray(raw) ||
      Object.keys(raw).length !== 4 ||
      !SAFE_SHARD_ID.test(shard.shardId) ||
      seen.has(shard.shardId) ||
      !SAFE_BINDING_REF.test(shard.bindingRef) ||
      !SAFE_SHARD_ID.test(shard.residencyPartition) ||
      !Number.isSafeInteger(shard.routeGeneration) ||
      shard.routeGeneration < 1
    ) {
      throw new Error('external_idp_token_refresh_shard_inventory_invalid');
    }
    seen.add(shard.shardId);
    const source = (env as unknown as Record<string, unknown>)[shard.bindingRef];
    ensureDatabaseAdapter(source as DatabaseSource, 'bridge-token-refresh-shard-binding');
    return { shardId: shard.shardId, source: source as DatabaseSource };
  });
  return { cursorKey, entries, wrapped };
}

/**
 * Refresh token for a single linked identity
 */
async function refreshIdentityToken(
  env: Env,
  identity: LinkedIdentity,
  encryptionKey: string,
  piiSource: DatabaseSource
): Promise<boolean> {
  // Get provider configuration
  const provider = await getProvider(env, identity.tenantId, identity.providerId);
  if (!provider) {
    // PII Protection: Don't log identity.id (technical identifier)
    log.warn('Provider not found for token refresh');
    return false;
  }

  // Decrypt refresh token
  const { refreshToken } = await decryptLinkedIdentityTokens(env, identity);
  if (!refreshToken) {
    // PII Protection: Don't log identity.id
    log.warn('No refresh token available for identity');
    return false;
  }

  // Decrypt client secret
  const clientSecret = await decrypt(provider.clientSecretEncrypted, encryptionKey);

  // Create OIDC client
  // Note: We don't need a callback URI for token refresh
  const client = OIDCRPClient.fromProvider(provider, '', clientSecret);

  // Refresh the token
  const tokens = await client.refreshTokens(refreshToken);

  // Update the linked identity with new tokens
  await updateLinkedIdentity(
    env,
    identity.tenantId,
    identity.id,
    {
      tokens,
    },
    piiSource
  );

  // PII Protection: Don't log identity.id
  log.info('Successfully refreshed external IdP token');
  return true;
}

/**
 * Get token refresh configuration from KV or use defaults
 */
export async function getTokenRefreshConfig(env: Env): Promise<TokenRefreshConfig> {
  try {
    const stored = await env.SETTINGS?.get(TOKEN_REFRESH_CONFIG_KEY);
    if (stored) {
      return normalizeTokenRefreshConfig(JSON.parse(stored) as Partial<TokenRefreshConfig>);
    }
  } catch {
    // Use defaults if KV fails
  }
  return DEFAULT_TOKEN_REFRESH_CONFIG;
}

export async function setTokenRefreshConfig(
  env: Env,
  config: Partial<TokenRefreshConfig>
): Promise<TokenRefreshConfig> {
  const normalized = normalizeTokenRefreshConfig(config);
  if (!env.SETTINGS) {
    throw new Error('SETTINGS is not configured');
  }
  await env.SETTINGS.put(TOKEN_REFRESH_CONFIG_KEY, JSON.stringify(normalized));
  return normalized;
}

export async function listTokenRefreshRuns(
  env: Env,
  tenantId: string,
  limit: number = 50
): Promise<TokenRefreshRunSummary[]> {
  const adapter = ensureAdminDatabaseAdapter(env, 'bridge-token-refresh-runs');
  if (!adapter) {
    return [];
  }
  const safeLimit = Math.min(Math.max(Math.floor(limit), 1), 100);
  try {
    return await adapter.query<TokenRefreshRunSummary>(
      `SELECT *
       FROM admin_external_token_refresh_runs
       WHERE requested_tenant_id = ?
          OR id IN (
            SELECT run_id
            FROM admin_external_token_refresh_tenant_runs
            WHERE tenant_id = ?
          )
       ORDER BY started_at DESC
       LIMIT ?`,
      [tenantId, tenantId, safeLimit]
    );
  } catch (error) {
    log.warn('Token refresh run history unavailable', {
      errorName: error instanceof Error ? error.name : 'UnknownError',
    });
    return [];
  }
}

export function normalizeTokenRefreshConfig(
  config: Partial<TokenRefreshConfig>
): TokenRefreshConfig {
  return {
    enabled:
      typeof config.enabled === 'boolean' ? config.enabled : DEFAULT_TOKEN_REFRESH_CONFIG.enabled,
    refreshThresholdSeconds: normalizePositiveInteger(
      config.refreshThresholdSeconds,
      DEFAULT_TOKEN_REFRESH_CONFIG.refreshThresholdSeconds
    ),
    batchSize: normalizePositiveInteger(
      config.batchSize,
      DEFAULT_TOKEN_REFRESH_CONFIG.batchSize,
      MAX_TOKEN_REFRESH_BATCH_SIZE
    ),
    scheduledTenantBatchSize: normalizePositiveInteger(
      config.scheduledTenantBatchSize,
      DEFAULT_TOKEN_REFRESH_CONFIG.scheduledTenantBatchSize,
      MAX_SCHEDULED_TENANT_BATCH_SIZE
    ),
    piiShardPageSize: normalizePositiveInteger(
      config.piiShardPageSize,
      DEFAULT_TOKEN_REFRESH_CONFIG.piiShardPageSize,
      MAX_TOKEN_REFRESH_PII_SHARD_PAGE_SIZE
    ),
  };
}

function normalizePositiveInteger(value: unknown, fallback: number, max?: number): number {
  const normalized =
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
  return typeof max === 'number' ? Math.min(normalized, max) : normalized;
}

async function getTokenRefreshCursor(env: Env): Promise<string | null> {
  try {
    return (await env.SETTINGS?.get(TOKEN_REFRESH_TENANT_CURSOR_KEY)) ?? null;
  } catch {
    return null;
  }
}

async function startTokenRefreshRun(
  env: Env,
  input: TokenRefreshRunStartInput
): Promise<string | null> {
  const adapter = ensureAdminDatabaseAdapter(env, 'bridge-token-refresh-runs');
  if (!adapter) {
    return null;
  }

  const runId = `etr_${crypto.randomUUID().replace(/-/g, '')}`;
  const now = Date.now();
  const actorType =
    input.actor?.actorType ??
    (input.actor?.authMethod === 'machine_access_token' ? 'machine' : null);
  const actorId = input.actor?.actorId ?? null;

  try {
    await adapter.execute(
      `INSERT INTO admin_external_token_refresh_runs (
        id, trigger_type, status, requested_tenant_id, actor_type, actor_id,
        config_json, cursor_before, started_at
      ) VALUES (?, ?, 'running', ?, ?, ?, ?, ?, ?)`,
      [
        runId,
        input.triggerType,
        input.requestedTenantId ?? null,
        actorType,
        actorId,
        JSON.stringify(input.config),
        input.cursorBefore ?? null,
        now,
      ]
    );
    return runId;
  } catch (error) {
    log.warn('Token refresh run storage unavailable', {
      errorName: error instanceof Error ? error.name : 'UnknownError',
    });
    return null;
  }
}

async function finishTokenRefreshRun(env: Env, input: TokenRefreshRunFinishInput): Promise<void> {
  const adapter = ensureAdminDatabaseAdapter(env, 'bridge-token-refresh-runs');
  if (!adapter) {
    return;
  }

  const completedAt = Date.now();
  const status =
    input.errorMessage ||
    (input.tenantResults.length > 0 &&
      input.tenantResults.every((result) => result.status === 'failed'))
      ? 'failed'
      : input.tenantResults.some((result) => result.status === 'failed')
        ? 'partial_failure'
        : 'completed';

  try {
    for (const result of input.tenantResults) {
      await adapter.execute(
        `INSERT OR REPLACE INTO admin_external_token_refresh_tenant_runs (
          run_id, tenant_id, status, tokens_refreshed, error_message, started_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          input.runId,
          result.tenantId,
          result.status,
          result.tokensRefreshed,
          result.errorMessage ?? null,
          result.startedAt,
          result.completedAt,
        ]
      );
    }

    const detailObjectCatalogId = await writeTokenRefreshDetailArtifact(env, adapter, input);

    await adapter.execute(
      `UPDATE admin_external_token_refresh_runs
       SET status = ?,
           selected_tenants_count = ?,
           processed_tenants = ?,
           failed_tenants = ?,
           tokens_refreshed = ?,
           cursor_after = ?,
           detail_object_catalog_id = ?,
           error_message = ?,
           completed_at = ?
       WHERE id = ?`,
      [
        status,
        input.selectedTenants.length,
        input.tenantResults.filter((result) => result.status === 'completed').length,
        input.tenantResults.filter((result) => result.status === 'failed').length,
        input.tokensRefreshed,
        input.cursorAfter ?? null,
        detailObjectCatalogId,
        input.errorMessage ?? null,
        completedAt,
        input.runId,
      ]
    );
  } catch (error) {
    log.warn('Failed to persist token refresh run summary', {
      errorName: error instanceof Error ? error.name : 'UnknownError',
    });
  }
}

async function writeTokenRefreshDetailArtifact(
  env: Env,
  adapter: DatabaseAdapter,
  input: TokenRefreshRunFinishInput
): Promise<string | null> {
  if (!env.SENSITIVE_DETAILS) {
    return null;
  }

  try {
    const payload = {
      runId: input.runId,
      triggerType: input.triggerType,
      requestedTenantId: input.requestedTenantId ?? null,
      selectedTenants: input.selectedTenants,
      tenantResults: input.tenantResults,
      tokensRefreshed: input.tokensRefreshed,
      cursorBefore: input.cursorBefore ?? null,
      cursorAfter: input.cursorAfter ?? null,
      errorMessage: input.errorMessage ?? null,
      generatedAt: Date.now(),
    };
    const json = JSON.stringify(payload);
    const objectKey = `external-token-refresh/${input.runId}.json`;
    const bytes = new TextEncoder().encode(json);
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    const checksumSha256 = Array.from(new Uint8Array(hash))
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');

    await env.SENSITIVE_DETAILS.put(objectKey, json, {
      httpMetadata: { contentType: 'application/json' },
    });

    const catalog = await createObjectCatalogEntry(adapter, {
      tenantId: input.requestedTenantId ?? getDefaultTenantId(env),
      objectClass: 'operational_log_detail',
      objects: [
        {
          representation: 'canonical_json',
          objectKind: 'single',
          bucketBinding: 'SENSITIVE_DETAILS',
          objectKey,
          keyVersion: 1,
          checksumSha256,
          totalBytes: bytes.byteLength,
        },
      ],
    });
    return catalog.catalogId;
  } catch (error) {
    log.warn('Token refresh detail artifact unavailable', {
      errorName: error instanceof Error ? error.name : 'UnknownError',
    });
    return null;
  }
}

function sanitizeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message.slice(0, 500);
  }
  return String(error).slice(0, 500);
}

// =============================================================================
// Database Types (duplicated from linked-identity-store to avoid circular deps)
// =============================================================================

interface DbLinkedIdentity {
  id: string;
  tenant_id: string;
  user_id: string;
  provider_id: string;
  provider_user_id: string;
  provider_email: string | null;
  email_verified: number;
  access_token_encrypted: string | null;
  refresh_token_encrypted: string | null;
  token_expires_at: number | null;
  raw_claims: string | null;
  profile_data: string | null;
  linked_at: number;
  last_login_at: number | null;
  updated_at: number;
}

function mapDbToLinkedIdentity(db: DbLinkedIdentity): LinkedIdentity {
  return {
    id: db.id,
    tenantId: db.tenant_id,
    userId: db.user_id,
    providerId: db.provider_id,
    providerUserId: db.provider_user_id,
    providerEmail: db.provider_email || undefined,
    emailVerified: db.email_verified === 1,
    accessTokenEncrypted: db.access_token_encrypted || undefined,
    refreshTokenEncrypted: db.refresh_token_encrypted || undefined,
    tokenExpiresAt: db.token_expires_at || undefined,
    rawClaims: db.raw_claims ? JSON.parse(db.raw_claims) : undefined,
    profileData: db.profile_data ? JSON.parse(db.profile_data) : undefined,
    linkedAt: db.linked_at,
    lastLoginAt: db.last_login_at || undefined,
    updatedAt: db.updated_at,
  };
}
