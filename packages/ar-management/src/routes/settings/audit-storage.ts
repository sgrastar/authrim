/**
 * Audit Storage Configuration Settings API
 *
 * Manages audit log storage configuration including:
 * - Backend selection (D1, R2, Hyperdrive)
 * - Routing rules for directing logs to specific backends
 * - Retention policies
 * - Archive settings
 *
 * KV Keys:
 * - audit_storage_config: JSON-encoded AuditStorageConfig
 * - audit_retention_config: JSON-encoded AuditRetentionConfig
 *
 * @packageDocumentation
 */

import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import type {
  AuditProfile,
  AuditTarget,
  AuditStorageConfig,
  AuditRetentionConfig,
  AuditStorageRoutingRule,
} from '@authrim/ar-lib-core';
import {
  DEFAULT_AUDIT_STORAGE_CONFIG,
  buildAuditStorageConfigFromProfile,
  buildAuditStorageBackendsFromProfile,
  buildPrimaryBackendMap,
  createRuntimeProfileRegistryFromEnv,
  createSettingsManager,
  hasAuditStorageRoutingTargets,
  INFRASTRUCTURE_CATEGORY_META,
  loadEnvironmentProfileDefaultsFromEnv,
  normalizeAuditStorageRoutingTargets,
  targetToBackendId,
} from '@authrim/ar-lib-core';
import { getAuditHotQuerySupportForProfile } from '../../audit-hot-query';

// KV key constants
const KV_KEY_STORAGE_CONFIG = 'audit_storage_config';
const KV_KEY_RETENTION_CONFIG = 'audit_retention_config';
const KV_KEY_ROUTING_RULES = 'audit_routing_rules';
const MANAGED_AUDIT_PROFILE_ID = 'managed:audit:settings-default';

// Default retention config
const DEFAULT_RETENTION_CONFIG: AuditRetentionConfig = {
  eventLogRetentionDays: 90,
  piiLogRetentionDays: 365,
  archiveBeforeDelete: false,
};

function retentionConfigFromProfile(profile: AuditProfile): AuditRetentionConfig {
  return {
    eventLogRetentionDays:
      profile.retention?.eventLogRetentionDays ??
      profile.retention?.primaryDays ??
      DEFAULT_RETENTION_CONFIG.eventLogRetentionDays,
    piiLogRetentionDays:
      profile.retention?.piiLogRetentionDays ??
      profile.retention?.primaryDays ??
      DEFAULT_RETENTION_CONFIG.piiLogRetentionDays,
    archiveBeforeDelete:
      profile.retention?.archiveBeforeDelete ?? DEFAULT_RETENTION_CONFIG.archiveBeforeDelete,
    ...(profile.retention?.minimumRetentionDays != null
      ? { minimumRetentionDays: profile.retention.minimumRetentionDays }
      : {}),
  };
}

type AuditTargetStatus = {
  type: AuditTarget['type'];
  status: 'configured' | 'not_configured' | 'reference_only' | 'not_supported';
  target: AuditTarget;
};

function getEnvBinding(env: Env, ref: string | undefined): unknown {
  if (!ref) {
    return undefined;
  }
  return (env as unknown as Record<string, unknown>)[ref];
}

function describeAuditTargetStatus(env: Env, target: AuditTarget): AuditTargetStatus {
  if (target.type === 'd1') {
    return {
      type: target.type,
      status: getEnvBinding(env, target.bindingRef) ? 'configured' : 'not_configured',
      target,
    };
  }

  if (target.type === 'r2') {
    return {
      type: target.type,
      status: getEnvBinding(env, target.bucketRef) ? 'configured' : 'not_configured',
      target,
    };
  }

  if (target.type === 'postgres' || target.type === 'mysql') {
    return {
      type: target.type,
      status: target.bindingRef
        ? getEnvBinding(env, target.bindingRef)
          ? 'configured'
          : 'not_configured'
        : 'reference_only',
      target,
    };
  }

  return {
    type: target.type,
    status: 'configured',
    target,
  };
}

function normalizeRoutingRule(
  rule: AuditStorageRoutingRule & { backend?: string }
): AuditStorageRoutingRule {
  const targets = normalizeAuditStorageRoutingTargets(rule.targets, rule.backend);

  return {
    name: rule.name,
    priority: rule.priority,
    enabled: rule.enabled,
    conditions: rule.conditions ?? {},
    targets,
    ...(rule.retention ? { retention: rule.retention } : {}),
  };
}

function validateRoutingRule(
  rule: Partial<AuditStorageRoutingRule> & { backend?: string },
  prefix: string
): string[] {
  const errors: string[] = [];

  if (!rule.name) {
    errors.push(`${prefix}: name is required`);
  }
  if (typeof rule.priority !== 'number') {
    errors.push(`${prefix}: priority must be a number`);
  }
  if (typeof rule.enabled !== 'boolean') {
    errors.push(`${prefix}: enabled must be a boolean`);
  }
  if (!rule.conditions) {
    errors.push(`${prefix}: conditions is required`);
  }

  const targets = normalizeAuditStorageRoutingTargets(rule.targets, rule.backend);
  if (!hasAuditStorageRoutingTargets(targets)) {
    errors.push(
      `${prefix}: at least one target is required (targets.primaryStore, archiveStores, forwardingSinks)`
    );
  }

  return errors;
}

function parseStoredRoutingRules(value: string | null): AuditStorageRoutingRule[] {
  if (!value) {
    return [];
  }

  const parsed = JSON.parse(value) as Array<AuditStorageRoutingRule & { backend?: string }>;
  return parsed.map((rule) => normalizeRoutingRule(rule));
}

type LegacyBatchConfig = AuditStorageConfig['batchConfig'];

function createManagedAuditProfile(base: AuditProfile): AuditProfile {
  return {
    ...base,
    id: MANAGED_AUDIT_PROFILE_ID,
    builtin: false,
    label: 'Managed Audit Profile',
    description:
      'Managed by /api/admin/settings/audit-storage. Acts as the environment default audit profile.',
  };
}

async function setEnvironmentDefaultAuditProfileId(env: Env, profileId: string): Promise<void> {
  if (!env.SETTINGS) {
    throw new Error('SETTINGS KV namespace is not configured');
  }

  const manager = createSettingsManager({
    env: env as unknown as Record<string, string | undefined>,
    kv: env.SETTINGS,
    cacheTTL: 0,
  });
  manager.registerCategory(INFRASTRUCTURE_CATEGORY_META);

  const current = await manager.getAll('infrastructure', { type: 'platform' });
  await manager.patch(
    'infrastructure',
    { type: 'platform' },
    {
      ifMatch: current.version,
      set: {
        'infra.default_audit_profile_id': profileId,
      },
    },
    'audit-storage'
  );
}

async function getResolvedAuditProfile(env: Env): Promise<{
  registry: ReturnType<typeof createRuntimeProfileRegistryFromEnv>;
  defaults: Awaited<ReturnType<typeof loadEnvironmentProfileDefaultsFromEnv>>;
  profile: AuditProfile;
}> {
  const registry = createRuntimeProfileRegistryFromEnv(env);
  const defaults = await loadEnvironmentProfileDefaultsFromEnv(env);
  const profile = await registry.get<AuditProfile>('audit', defaults.auditProfileId);
  if (!profile) {
    throw new Error(`audit_profile_not_found:${defaults.auditProfileId}`);
  }

  return { registry, defaults, profile };
}

async function ensureManagedAuditProfile(env: Env): Promise<AuditProfile> {
  const { registry, defaults, profile } = await getResolvedAuditProfile(env);
  if (defaults.auditProfileId === MANAGED_AUDIT_PROFILE_ID && !profile.builtin) {
    return profile;
  }

  const managedProfile = createManagedAuditProfile(profile);
  await registry.put(managedProfile);
  await setEnvironmentDefaultAuditProfileId(env, MANAGED_AUDIT_PROFILE_ID);
  return managedProfile;
}

async function loadLegacyBatchConfig(env: Env): Promise<LegacyBatchConfig> {
  const defaults = DEFAULT_AUDIT_STORAGE_CONFIG.batchConfig;

  if (!env.AUTHRIM_CONFIG) {
    return { ...defaults };
  }

  try {
    const kvValue = await env.AUTHRIM_CONFIG.get(KV_KEY_STORAGE_CONFIG);
    if (!kvValue) {
      return { ...defaults };
    }
    const stored = JSON.parse(kvValue) as Partial<AuditStorageConfig>;
    return {
      maxBufferSize: stored.batchConfig?.maxBufferSize ?? defaults.maxBufferSize,
      flushIntervalMs: stored.batchConfig?.flushIntervalMs ?? defaults.flushIntervalMs,
      maxBatchSize: stored.batchConfig?.maxBatchSize ?? defaults.maxBatchSize,
    };
  } catch {
    return { ...defaults };
  }
}

async function persistLegacyBatchConfig(env: Env, batchConfig: LegacyBatchConfig): Promise<void> {
  if (!env.AUTHRIM_CONFIG) {
    return;
  }

  let existingConfig: AuditStorageConfig = { ...DEFAULT_AUDIT_STORAGE_CONFIG };
  try {
    const kvValue = await env.AUTHRIM_CONFIG.get(KV_KEY_STORAGE_CONFIG);
    if (kvValue) {
      existingConfig = JSON.parse(kvValue) as AuditStorageConfig;
    }
  } catch {
    // Keep defaults
  }

  existingConfig.batchConfig = batchConfig;
  await env.AUTHRIM_CONFIG.put(KV_KEY_STORAGE_CONFIG, JSON.stringify(existingConfig));
}

async function buildStorageView(env: Env): Promise<{
  profile: AuditProfile;
  batchConfig: LegacyBatchConfig;
  config: AuditStorageConfig;
  source: 'builtin' | 'runtime_profile';
}> {
  const { profile } = await getResolvedAuditProfile(env);
  const batchConfig = await loadLegacyBatchConfig(env);
  const config = buildAuditStorageConfigFromProfile(profile, {
    batchConfig,
  });

  return {
    profile,
    batchConfig,
    config,
    source: profile.builtin ? 'builtin' : 'runtime_profile',
  };
}

function isD1SplitPrimaryPair(
  eventBackend: string | undefined,
  piiBackend: string | undefined
): boolean {
  return (
    (eventBackend === 'd1-core' && piiBackend === 'd1-pii') ||
    (eventBackend === 'd1-pii' && piiBackend === 'd1-core')
  );
}

async function listAvailableAuditProfiles(env: Env): Promise<
  Array<{
    id: string;
    label: string;
    builtin: boolean;
    primaryType: AuditTarget['type'] | 'archive-only';
  }>
> {
  const registry = createRuntimeProfileRegistryFromEnv(env);
  const profiles = await registry.list<AuditProfile>('audit');

  return profiles.map((profile) => ({
    id: profile.id,
    label: profile.label,
    builtin: Boolean(profile.builtin),
    primaryType: profile.primary?.type ?? 'archive-only',
  }));
}

/**
 * GET /api/admin/settings/audit-storage
 * Get audit storage configuration
 */
export async function getAuditStorageConfig(c: Context<{ Bindings: Env }>) {
  const storageView = await buildStorageView(c.env);
  const availableProfiles = await listAvailableAuditProfiles(c.env);
  let retentionConfig: AuditRetentionConfig = retentionConfigFromProfile(storageView.profile);
  let routingRules: AuditStorageRoutingRule[] = [];
  let retentionSource: 'builtin' | 'runtime_profile' = storageView.source;

  if (c.env.AUTHRIM_CONFIG) {
    try {
      const routingValue = await c.env.AUTHRIM_CONFIG.get(KV_KEY_ROUTING_RULES);

      if (routingValue) {
        routingRules = parseStoredRoutingRules(routingValue);
      }
    } catch {
      // KV read error - use defaults
    }
  }

  return c.json({
    storage: {
      config: storageView.config,
      source: storageView.source,
      profile_id: storageView.profile.id,
      available_profiles: availableProfiles,
      batch_config_source: c.env.AUTHRIM_CONFIG ? 'kv' : 'default',
    },
    retention: {
      config: retentionConfig,
      source: retentionSource,
      kv_key: KV_KEY_RETENTION_CONFIG,
      constraints: {
        min_event_log_retention_days: 1,
        max_event_log_retention_days: 730,
        min_pii_log_retention_days: 1,
        max_pii_log_retention_days: 2555,
      },
    },
    routing_rules: {
      rules: routingRules,
      kv_key: KV_KEY_ROUTING_RULES,
    },
    defaults: {
      storage: DEFAULT_AUDIT_STORAGE_CONFIG,
      retention: DEFAULT_RETENTION_CONFIG,
    },
    backend_types: {
      D1: 'Cloudflare D1 (SQLite) - Hot data, fast queries',
      R2: 'Cloudflare R2 (Object Storage) - Archive, cost-efficient',
      HYPERDRIVE: 'External PostgreSQL / MySQL - Enterprise, external compliance',
      LOGPUSH: 'Forwarding sink for Cloudflare Logpush delivery',
      FIREHOSE: 'Forwarding sink for external stream delivery',
    },
    note: 'Changes take effect within 10 seconds (cache TTL)',
  });
}

/**
 * PUT /api/admin/settings/audit-storage
 * Update audit storage configuration
 */
export async function updateAuditStorageConfig(c: Context<{ Bindings: Env }>) {
  if (!c.env.SETTINGS) {
    return c.json(
      {
        error: 'server_error',
        error_description: 'SETTINGS KV namespace is not configured',
        error_code: 'AR100001',
      },
      500
    );
  }

  const body = await c.req.json<Partial<AuditStorageConfig> & { auditProfileId?: string }>();
  const registry = createRuntimeProfileRegistryFromEnv(c.env);
  const hasStorageMutation =
    body.defaultEventBackend !== undefined ||
    body.defaultPiiBackend !== undefined ||
    body.batchConfig !== undefined ||
    Array.isArray(body.backends);
  let requestedProfile: AuditProfile | null = null;

  if (body.auditProfileId !== undefined) {
    requestedProfile = await registry.get<AuditProfile>('audit', body.auditProfileId);
    if (!requestedProfile) {
      return c.json(
        {
          error: 'not_found',
          error_description: `Audit profile "${body.auditProfileId}" not found`,
        },
        404
      );
    }

    if (hasStorageMutation && body.auditProfileId !== MANAGED_AUDIT_PROFILE_ID) {
      return c.json(
        {
          error: 'invalid_request',
          error_description:
            'auditProfileId cannot be combined with storage mutations unless it targets the managed audit profile.',
        },
        400
      );
    }

    if (!hasStorageMutation) {
      await setEnvironmentDefaultAuditProfileId(c.env, requestedProfile.id);
      const storageView = await buildStorageView(c.env);
      return c.json({
        success: true,
        config: storageView.config,
        source: storageView.source,
        profile_id: storageView.profile.id,
        note: 'Default audit profile updated.',
      });
    }
  }

  const errors: string[] = [];
  const managedProfile = await ensureManagedAuditProfile(c.env);
  const nextProfile: AuditProfile = {
    ...managedProfile,
    sinks: [...managedProfile.sinks],
  };
  const batchConfig = await loadLegacyBatchConfig(c.env);
  const primaryBackendMap = buildPrimaryBackendMap(managedProfile, body.backends);
  const validPrimaryBackends = [...primaryBackendMap.keys()];

  // Validate and merge defaultEventBackend
  if (body.defaultEventBackend !== undefined) {
    if (!primaryBackendMap.has(body.defaultEventBackend)) {
      errors.push(
        `Invalid defaultEventBackend. Valid backends: ${validPrimaryBackends.join(', ')}`
      );
    } else {
      nextProfile.primary = primaryBackendMap.get(body.defaultEventBackend) ?? null;
    }
  }

  // Validate and merge defaultPiiBackend
  if (body.defaultPiiBackend !== undefined) {
    if (!primaryBackendMap.has(body.defaultPiiBackend)) {
      errors.push(`Invalid defaultPiiBackend. Valid backends: ${validPrimaryBackends.join(', ')}`);
    } else if (body.defaultEventBackend === undefined) {
      nextProfile.primary = primaryBackendMap.get(body.defaultPiiBackend) ?? null;
    } else if (
      body.defaultPiiBackend !== body.defaultEventBackend &&
      !isD1SplitPrimaryPair(body.defaultEventBackend, body.defaultPiiBackend)
    ) {
      errors.push(
        'Audit profiles currently support a single primary target. defaultEventBackend and defaultPiiBackend must match.'
      );
    }
  }

  // Validate and merge batchConfig
  if (body.batchConfig) {
    if (body.batchConfig.maxBufferSize !== undefined) {
      if (body.batchConfig.maxBufferSize < 1 || body.batchConfig.maxBufferSize > 1000) {
        errors.push('batchConfig.maxBufferSize must be between 1 and 1000');
      } else {
        batchConfig.maxBufferSize = body.batchConfig.maxBufferSize;
      }
    }

    if (body.batchConfig.flushIntervalMs !== undefined) {
      if (body.batchConfig.flushIntervalMs < 100 || body.batchConfig.flushIntervalMs > 60000) {
        errors.push('batchConfig.flushIntervalMs must be between 100 and 60000');
      } else {
        batchConfig.flushIntervalMs = body.batchConfig.flushIntervalMs;
      }
    }

    if (body.batchConfig.maxBatchSize !== undefined) {
      if (body.batchConfig.maxBatchSize < 1 || body.batchConfig.maxBatchSize > 500) {
        errors.push('batchConfig.maxBatchSize must be between 1 and 500');
      } else {
        batchConfig.maxBatchSize = body.batchConfig.maxBatchSize;
      }
    }
  }

  if (Array.isArray(body.backends)) {
    const enabledArchive = body.backends.find((backend) => backend.enabled && backend.type === 'R2');
    if (enabledArchive?.r2Config?.binding) {
      nextProfile.archive = {
        type: 'r2',
        bucketRef: enabledArchive.r2Config.binding,
        prefix: enabledArchive.r2Config.pathPrefix,
      };
    } else {
      nextProfile.archive = null;
    }

    nextProfile.sinks = body.backends.flatMap<AuditTarget>((backend) => {
      if (!backend.enabled) {
        return [];
      }
      if (backend.type === 'LOGPUSH' && backend.logpushConfig?.destinationRef) {
        return [
          {
            type: 'logpush' as const,
            destinationRef: backend.logpushConfig.destinationRef,
            ...(backend.logpushConfig.dataset
              ? { dataset: backend.logpushConfig.dataset }
              : {}),
          },
        ];
      }
      if (backend.type === 'FIREHOSE' && backend.firehoseConfig?.streamRef) {
        return [
          {
            type: 'firehose' as const,
            streamRef: backend.firehoseConfig.streamRef,
          },
        ];
      }
      return [];
    });
  }

  if (errors.length > 0) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: errors.join('; '),
      },
      400
    );
  }

  await registry.put(nextProfile);
  await persistLegacyBatchConfig(c.env, batchConfig);
  const storageView = await buildStorageView(c.env);

  return c.json({
    success: true,
    config: storageView.config,
    source: 'runtime_profile',
    profile_id: MANAGED_AUDIT_PROFILE_ID,
    note:
      'Storage configuration updated via the managed audit profile. Batch settings remain transitional.',
  });
}

// ============================================
// Retention Configuration
// ============================================

/**
 * GET /api/admin/settings/audit-storage/retention
 * Get retention configuration
 */
export async function getRetentionConfig(c: Context<{ Bindings: Env }>) {
  const { profile } = await getResolvedAuditProfile(c.env);
  const config = retentionConfigFromProfile(profile);
  const source: 'builtin' | 'runtime_profile' = profile.builtin ? 'builtin' : 'runtime_profile';

  return c.json({
    config,
    source,
    default: DEFAULT_RETENTION_CONFIG,
    kv_key: KV_KEY_RETENTION_CONFIG,
    constraints: {
      event_log: {
        min_days: 1,
        max_days: 730,
        description: 'Event logs (non-PII) retention period',
      },
      pii_log: {
        min_days: 1,
        max_days: 2555,
        description: 'PII logs retention period (may be required by regulations)',
      },
    },
    archive_note:
      'When archiveBeforeDelete is enabled, logs are copied to R2 before deletion ' +
      'for compliance and recovery purposes.',
  });
}

/**
 * PUT /api/admin/settings/audit-storage/retention
 * Update retention configuration
 */
export async function updateRetentionConfig(c: Context<{ Bindings: Env }>) {
  if (!c.env.SETTINGS) {
    return c.json(
      {
        error: 'server_error',
        error_description: 'SETTINGS KV namespace is not configured',
        error_code: 'AR100001',
      },
      500
    );
  }

  const body = await c.req.json<Partial<AuditRetentionConfig>>();
  const errors: string[] = [];
  const managedProfile = await ensureManagedAuditProfile(c.env);
  const nextProfile: AuditProfile = {
    ...managedProfile,
    retention: {
      ...managedProfile.retention,
    },
  };
  const existingConfig = retentionConfigFromProfile(managedProfile);

  // Validate eventLogRetentionDays
  if (body.eventLogRetentionDays !== undefined) {
    if (body.eventLogRetentionDays < 1 || body.eventLogRetentionDays > 730) {
      errors.push('eventLogRetentionDays must be between 1 and 730');
    } else {
      existingConfig.eventLogRetentionDays = body.eventLogRetentionDays;
      nextProfile.retention!.eventLogRetentionDays = body.eventLogRetentionDays;
    }
  }

  // Validate piiLogRetentionDays
  if (body.piiLogRetentionDays !== undefined) {
    if (body.piiLogRetentionDays < 1 || body.piiLogRetentionDays > 2555) {
      errors.push('piiLogRetentionDays must be between 1 and 2555');
    } else {
      existingConfig.piiLogRetentionDays = body.piiLogRetentionDays;
      nextProfile.retention!.piiLogRetentionDays = body.piiLogRetentionDays;
    }
  }

  // Validate archiveBeforeDelete
  if (body.archiveBeforeDelete !== undefined) {
    if (typeof body.archiveBeforeDelete !== 'boolean') {
      errors.push('archiveBeforeDelete must be a boolean');
    } else {
      existingConfig.archiveBeforeDelete = body.archiveBeforeDelete;
      nextProfile.retention!.archiveBeforeDelete = body.archiveBeforeDelete;
    }
  }

  // Validate minimumRetentionDays
  if (body.minimumRetentionDays !== undefined) {
    if (body.minimumRetentionDays < 1 || body.minimumRetentionDays > 2555) {
      errors.push('minimumRetentionDays must be between 1 and 2555');
    } else {
      existingConfig.minimumRetentionDays = body.minimumRetentionDays;
      nextProfile.retention!.minimumRetentionDays = body.minimumRetentionDays;
    }
  }

  if (errors.length > 0) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: errors.join('; '),
      },
      400
    );
  }

  const registry = createRuntimeProfileRegistryFromEnv(c.env);
  await registry.put(nextProfile);

  return c.json({
    success: true,
    config: existingConfig,
    source: 'runtime_profile',
    profile_id: MANAGED_AUDIT_PROFILE_ID,
    note: 'Retention configuration updated via the managed audit profile.',
  });
}

// ============================================
// Routing Rules
// ============================================

/**
 * GET /api/admin/settings/audit-storage/routing-rules
 * Get all routing rules
 */
export async function getRoutingRules(c: Context<{ Bindings: Env }>) {
  let rules: AuditStorageRoutingRule[] = [];

  if (c.env.AUTHRIM_CONFIG) {
    try {
      const kvValue = await c.env.AUTHRIM_CONFIG.get(KV_KEY_ROUTING_RULES);
      if (kvValue) {
        rules = parseStoredRoutingRules(kvValue);
      }
    } catch {
      // No rules
    }
  }

  return c.json({
    rules,
    count: rules.length,
    kv_key: KV_KEY_ROUTING_RULES,
    example_rule: {
      name: 'eu-tenant-routing',
      priority: 10,
      enabled: true,
      conditions: {
        tenantId: ['tenant-eu-1', 'tenant-eu-2'],
        logType: '*',
        region: 'EU',
      },
      targets: {
        primaryStore: 'hyperdrive-eu',
        archiveStores: ['r2-eu-archive'],
        forwardingSinks: ['logpush-eu'],
      },
      retention: {
        piiLogRetentionDays: 365,
      },
    },
    description:
      'Routing rules direct audit logs to specific backends based on conditions. ' +
      'Lower priority numbers are evaluated first.',
  });
}

/**
 * PUT /api/admin/settings/audit-storage/routing-rules
 * Update all routing rules (replace)
 */
export async function updateRoutingRules(c: Context<{ Bindings: Env }>) {
  if (!c.env.AUTHRIM_CONFIG) {
    return c.json(
      {
        error: 'server_error',
        error_description: 'AUTHRIM_CONFIG KV namespace is not configured',
        error_code: 'AR100001',
      },
      500
    );
  }

  const body = await c.req.json<{ rules: AuditStorageRoutingRule[] }>();
  const { rules } = body;

  if (!Array.isArray(rules)) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: 'rules must be an array',
      },
      400
    );
  }

  const errors = rules.flatMap((rule, index) => validateRoutingRule(rule, `Rule ${index}`));

  if (errors.length > 0) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: errors.join('; '),
      },
      400
    );
  }

  // Sort by priority
  const sortedRules = [...rules]
    .map((rule) => normalizeRoutingRule(rule))
    .sort((a, b) => a.priority - b.priority);

  await c.env.AUTHRIM_CONFIG.put(KV_KEY_ROUTING_RULES, JSON.stringify(sortedRules));

  return c.json({
    success: true,
    rules: sortedRules,
    count: sortedRules.length,
    kv_key: KV_KEY_ROUTING_RULES,
    note: 'Routing rules updated and sorted by priority.',
  });
}

/**
 * POST /api/admin/settings/audit-storage/routing-rules
 * Add a new routing rule
 */
export async function addRoutingRule(c: Context<{ Bindings: Env }>) {
  if (!c.env.AUTHRIM_CONFIG) {
    return c.json(
      {
        error: 'server_error',
        error_description: 'AUTHRIM_CONFIG KV namespace is not configured',
        error_code: 'AR100001',
      },
      500
    );
  }

  const newRule = await c.req.json<AuditStorageRoutingRule>();

  // Validate rule
  const errors = validateRoutingRule(newRule, 'Rule');

  if (errors.length > 0) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: errors.join('; '),
      },
      400
    );
  }

  // Get existing rules
  let rules: AuditStorageRoutingRule[] = [];
  try {
    const kvValue = await c.env.AUTHRIM_CONFIG.get(KV_KEY_ROUTING_RULES);
    if (kvValue) {
      rules = parseStoredRoutingRules(kvValue);
    }
  } catch {
    // No existing rules
  }

  // Check for duplicate name
  if (rules.some((r) => r.name === newRule.name)) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: `Rule with name "${newRule.name}" already exists`,
      },
      400
    );
  }

  // Add and sort
  const normalizedRule = normalizeRoutingRule(newRule);
  rules.push(normalizedRule);
  rules.sort((a, b) => a.priority - b.priority);

  await c.env.AUTHRIM_CONFIG.put(KV_KEY_ROUTING_RULES, JSON.stringify(rules));

  return c.json({
    success: true,
    rule: normalizedRule,
    total_rules: rules.length,
    note: 'Routing rule added.',
  });
}

/**
 * DELETE /api/admin/settings/audit-storage/routing-rules/:name
 * Delete a routing rule by name
 */
export async function deleteRoutingRule(c: Context<{ Bindings: Env }>) {
  if (!c.env.AUTHRIM_CONFIG) {
    return c.json(
      {
        error: 'server_error',
        error_description: 'AUTHRIM_CONFIG KV namespace is not configured',
        error_code: 'AR100001',
      },
      500
    );
  }

  const ruleName = c.req.param('name')!;

  if (!ruleName) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: 'Rule name is required',
      },
      400
    );
  }

  // Get existing rules
  let rules: AuditStorageRoutingRule[] = [];
  try {
    const kvValue = await c.env.AUTHRIM_CONFIG.get(KV_KEY_ROUTING_RULES);
    if (kvValue) {
      rules = parseStoredRoutingRules(kvValue);
    }
  } catch {
    // No existing rules
  }

  const originalLength = rules.length;
  rules = rules.filter((r) => r.name !== ruleName);

  if (rules.length === originalLength) {
    return c.json(
      {
        error: 'not_found',
        error_description: `Rule with name "${ruleName}" not found`,
      },
      404
    );
  }

  await c.env.AUTHRIM_CONFIG.put(KV_KEY_ROUTING_RULES, JSON.stringify(rules));

  return c.json({
    success: true,
    deleted_rule: ruleName,
    remaining_rules: rules.length,
    note: 'Routing rule deleted.',
  });
}

// ============================================
// Maintenance Operations
// ============================================

/**
 * POST /api/admin/settings/audit-storage/cleanup
 * Trigger retention cleanup (manual)
 */
export async function triggerRetentionCleanup(c: Context<{ Bindings: Env }>) {
  const { profile } = await getResolvedAuditProfile(c.env);
  const hotQuery = getAuditHotQuerySupportForProfile(c.env, profile);

  return c.json({
    success: true,
    profile_id: profile.id,
    source: profile.builtin ? 'builtin' : 'runtime_profile',
    note:
      'Retention cleanup is typically handled by scheduled tasks. ' +
      'For manual cleanup, use the Queue Consumer functions directly.',
    hot_query: {
      status: hotQuery.status,
      reason: hotQuery.reason,
    },
    scheduled_cleanup: {
      event_log: hotQuery.supported ? 'Daily at 02:00 UTC' : null,
      pii_log: hotQuery.supported ? 'Daily at 03:00 UTC' : null,
    },
    functions: {
      event_log: hotQuery.supported ? 'cleanupExpiredEventLogs(db, tenantId?, batchSize?)' : null,
      pii_log: hotQuery.supported ? 'cleanupExpiredPIILogs(db, tenantId?, batchSize?)' : null,
    },
  });
}

/**
 * GET /api/admin/settings/audit-storage/stats
 * Get storage statistics (placeholder - would need actual backend queries)
 */
export async function getStorageStats(c: Context<{ Bindings: Env }>) {
  const { profile } = await getResolvedAuditProfile(c.env);
  const primary = profile.primary ? describeAuditTargetStatus(c.env, profile.primary) : null;
  const archive = profile.archive ? describeAuditTargetStatus(c.env, profile.archive) : null;
  const sinks = profile.sinks.map((target) => describeAuditTargetStatus(c.env, target));
  const hotQuery = getAuditHotQuerySupportForProfile(c.env, profile);

  return c.json({
    note: 'Configuration-aware storage status derived from the resolved audit profile.',
    profile_id: profile.id,
    source: profile.builtin ? 'builtin' : 'runtime_profile',
    hot_query: {
      status: hotQuery.status,
      reason: hotQuery.reason,
      supported: hotQuery.supported,
    },
    targets: {
      primary,
      archive,
      sinks,
    },
    queue: {
      audit_queue: {
        status: c.env.AUDIT_QUEUE ? 'configured' : 'not_configured',
        binding: 'AUDIT_QUEUE',
      },
    },
  });
}
