/** Audit storage reports the Setup-owned mode. These routes only edit retention. */
import { DatabaseSettingsCanonicalStore } from '@authrim/ar-lib-core/services/settings-canonical-store';
import type { Context } from 'hono';
import type { AuditProfile, AuditStorageRoutingRule, Env } from '@authrim/ar-lib-core';
import {
  createRuntimeProfileRegistryFromEnv,
  createSettingsManager,
  INFRASTRUCTURE_CATEGORY_META,
  loadEnvironmentProfileDefaultsFromEnv,
  requireDedicatedAdminDatabaseAdapter,
} from '@authrim/ar-lib-core';
import {
  resolveLogIcebergConfig,
  assertLogIcebergActivated,
} from '@authrim/ar-lib-core/services/log-iceberg-config';

const KV_KEY_ROUTING_RULES = 'audit_routing_rules';
const MANAGED_AUDIT_PROFILE_ID = 'managed:audit:settings-default';
const DEFAULT_RETENTION_CONFIG = { eventLogRetentionDays: 90, piiLogRetentionDays: 365 };
type RetentionConfig = typeof DEFAULT_RETENTION_CONFIG;
const RETENTION_LIMITS = { eventLogRetentionDays: 730, piiLogRetentionDays: 2555 } as const;

function retentionConfigFromProfile(profile: AuditProfile): RetentionConfig {
  return {
    eventLogRetentionDays:
      profile.retention?.eventLogRetentionDays ??
      profile.retention?.primaryDays ??
      profile.retention?.archiveDays ??
      DEFAULT_RETENTION_CONFIG.eventLogRetentionDays,
    piiLogRetentionDays:
      profile.retention?.piiLogRetentionDays ??
      profile.retention?.primaryDays ??
      profile.retention?.archiveDays ??
      DEFAULT_RETENTION_CONFIG.piiLogRetentionDays,
  };
}
function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function wholeDaysWithin(value: unknown, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= max;
}
function retentionErrors(value: unknown, allowPartial: boolean): string[] {
  if (!object(value)) return ['retention must be an object'];
  const errors: string[] = [];
  for (const name of Object.keys(value)) {
    if (!Object.hasOwn(RETENTION_LIMITS, name))
      errors.push(`${name} is not supported; only event and PII retention days can be changed`);
  }
  if (!allowPartial && Object.keys(value).length === 0)
    errors.push('at least one retention in days is required');
  for (const [name, max] of Object.entries(RETENTION_LIMITS)) {
    if (name in value && !wholeDaysWithin(value[name], max))
      errors.push(`${name} must be a whole number of days between 1 and ${max}`);
  }
  return errors;
}
function normalizeRoutingRule(value: unknown): AuditStorageRoutingRule {
  if (!object(value)) throw new Error('audit_retention_rule_invalid');
  const errors: string[] = [];
  for (const key of Object.keys(value))
    if (!['name', 'priority', 'enabled', 'conditions', 'retention'].includes(key))
      errors.push(`${key} is not supported; routing rules only select retention`);
  if (typeof value.name !== 'string' || !value.name || value.name.length > 256)
    errors.push('name is required');
  if (typeof value.priority !== 'number' || !Number.isSafeInteger(value.priority))
    errors.push('priority must be an integer');
  if (typeof value.enabled !== 'boolean') errors.push('enabled must be a boolean');
  if (!object(value.conditions)) errors.push('conditions must be an object');
  else
    for (const [name, condition] of Object.entries(value.conditions)) {
      if (!['tenantId', 'clientId', 'logType', 'eventCategory', 'region'].includes(name))
        errors.push(`unknown condition ${name}`);
      if (name === 'region') {
        if (condition !== '*')
          errors.push('region must be omitted or *; log writes do not carry a region');
      } else if (name === 'logType') {
        if (typeof condition !== 'string' || !['event', 'pii', '*'].includes(condition))
          errors.push('logType must be event, pii or *');
      } else if (
        !(typeof condition === 'string' && condition.length > 0) &&
        !(
          Array.isArray(condition) &&
          condition.length > 0 &&
          condition.every((v) => typeof v === 'string' && v.length > 0)
        )
      )
        errors.push(`invalid condition ${name}`);
    }
  errors.push(...retentionErrors(value.retention, false));
  if (errors.length) throw new Error(errors.join('; '));
  return {
    name: value.name as string,
    priority: value.priority as number,
    enabled: value.enabled as boolean,
    conditions: structuredClone(value.conditions) as AuditStorageRoutingRule['conditions'],
    retention: { ...(value.retention as Partial<RetentionConfig>) },
  };
}
async function loadRoutingRules(env: Env): Promise<AuditStorageRoutingRule[]> {
  if (!env.AUTHRIM_CONFIG) return [];
  const text = await env.AUTHRIM_CONFIG.get(KV_KEY_ROUTING_RULES);
  if (text === null) return [];
  const value: unknown = JSON.parse(text);
  if (!Array.isArray(value)) throw new Error('audit_retention_rules_invalid');
  return value.map(normalizeRoutingRule);
}
function storageState(env: Env) {
  const config = resolveLogIcebergConfig(env);
  let active = true;
  try {
    assertLogIcebergActivated(config);
  } catch {
    active = false;
  }
  return {
    source: 'setup',
    read_only: true,
    mode: config.mode,
    generation: config.generation,
    schema_version: config.schemaVersion,
    activated_at: new Date(config.activatedAt).toISOString(),
    active,
    local_staging_only: config.localStagingOnly === true,
    db_retention_days: config.dbRetentionDays,
    export_interval_minutes: config.exportIntervalMinutes,
  };
}
function unavailable(c: Context<{ Bindings: Env }>) {
  return c.json(
    {
      error: 'temporarily_unavailable',
      error_description: 'Audit storage configuration could not be resolved.',
    },
    503
  );
}
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
    // Platform documents are saved through the canonical store, as the Settings API saves them.
    canonicalStore: new DatabaseSettingsCanonicalStore(
      requireDedicatedAdminDatabaseAdapter(env, 'settings-canonical')
    ),
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

export async function getAuditStorageConfig(c: Context<{ Bindings: Env }>) {
  try {
    const storage = storageState(c.env);
    const { profile } = await getResolvedAuditProfile(c.env);
    return c.json({
      storage,
      retention: {
        config: retentionConfigFromProfile(profile),
        source: profile.builtin ? 'builtin' : 'runtime_profile',
      },
      routing_rules: { rules: await loadRoutingRules(c.env) },
      note: 'Storage mode and resources are managed by Setup.',
    });
  } catch {
    return unavailable(c);
  }
}
export function updateAuditStorageConfig(c: Context<{ Bindings: Env }>) {
  return c.json(
    {
      error: 'not_supported',
      error_description:
        'Storage mode, backends, batches and profile selection are managed by Setup. Use retention settings to change log retention.',
    },
    501
  );
}
export async function getRetentionConfig(c: Context<{ Bindings: Env }>) {
  const { profile } = await getResolvedAuditProfile(c.env);
  return c.json({
    config: retentionConfigFromProfile(profile),
    source: profile.builtin ? 'builtin' : 'runtime_profile',
    default: DEFAULT_RETENTION_CONFIG,
    constraints: {
      event_log: { min_days: 1, max_days: 730 },
      pii_log: { min_days: 1, max_days: 2555 },
    },
    note: 'Retention is fixed on each new log at occurrence time; storage mode is managed by Setup.',
  });
}
export async function updateRetentionConfig(c: Context<{ Bindings: Env }>) {
  const body: unknown = await c.req.json();
  const errors = retentionErrors(body, false);
  if (errors.length || !object(body))
    return c.json({ error: 'invalid_request', error_description: errors.join('; ') }, 400);
  if (!c.env.SETTINGS)
    return c.json(
      { error: 'server_error', error_description: 'SETTINGS KV namespace is not configured' },
      500
    );
  const profile = await ensureManagedAuditProfile(c.env);
  const next = {
    ...profile,
    retention: { ...profile.retention, ...(body as Partial<RetentionConfig>) },
  };
  await createRuntimeProfileRegistryFromEnv(c.env).put(next);
  return c.json({
    success: true,
    config: retentionConfigFromProfile(next),
    source: 'runtime_profile',
    profile_id: next.id,
    note: 'Retention applies to newly occurring logs.',
  });
}
export async function getRoutingRules(c: Context<{ Bindings: Env }>) {
  try {
    const rules = await loadRoutingRules(c.env);
    return c.json({
      rules,
      count: rules.length,
      kv_key: KV_KEY_ROUTING_RULES,
      description:
        'Matching conditions override retention days. Lower priority numbers are evaluated first. Storage mode and destinations are managed separately.',
    });
  } catch {
    return unavailable(c);
  }
}
function invalidRule(c: Context<{ Bindings: Env }>, error: unknown) {
  return c.json(
    {
      error: 'invalid_request',
      error_description: error instanceof Error ? error.message : 'Invalid retention rule',
    },
    400
  );
}
export async function updateRoutingRules(c: Context<{ Bindings: Env }>) {
  if (!c.env.AUTHRIM_CONFIG)
    return c.json(
      { error: 'server_error', error_description: 'AUTHRIM_CONFIG KV namespace is not configured' },
      500
    );
  const body: unknown = await c.req.json();
  let rules: AuditStorageRoutingRule[];
  try {
    if (!object(body) || !Array.isArray(body.rules) || Object.keys(body).some((k) => k !== 'rules'))
      throw new Error('rules must be an array');
    rules = body.rules.map(normalizeRoutingRule).sort((a, b) => a.priority - b.priority);
    if (new Set(rules.map((r) => r.name)).size !== rules.length)
      throw new Error('rule names must be unique');
  } catch (error) {
    return invalidRule(c, error);
  }
  await c.env.AUTHRIM_CONFIG.put(KV_KEY_ROUTING_RULES, JSON.stringify(rules));
  return c.json({ success: true, rules, count: rules.length, kv_key: KV_KEY_ROUTING_RULES });
}
export async function addRoutingRule(c: Context<{ Bindings: Env }>) {
  if (!c.env.AUTHRIM_CONFIG)
    return c.json(
      { error: 'server_error', error_description: 'AUTHRIM_CONFIG KV namespace is not configured' },
      500
    );
  let rule: AuditStorageRoutingRule;
  try {
    rule = normalizeRoutingRule(await c.req.json());
  } catch (error) {
    return invalidRule(c, error);
  }
  let rules: AuditStorageRoutingRule[];
  try {
    rules = await loadRoutingRules(c.env);
  } catch {
    return unavailable(c);
  }
  if (rules.some((r) => r.name === rule.name))
    return c.json(
      {
        error: 'invalid_request',
        error_description: `Rule with name "${rule.name}" already exists`,
      },
      400
    );
  rules.push(rule);
  rules.sort((a, b) => a.priority - b.priority);
  await c.env.AUTHRIM_CONFIG.put(KV_KEY_ROUTING_RULES, JSON.stringify(rules));
  return c.json({ success: true, rule, total_rules: rules.length });
}
export async function deleteRoutingRule(c: Context<{ Bindings: Env }>) {
  if (!c.env.AUTHRIM_CONFIG)
    return c.json(
      { error: 'server_error', error_description: 'AUTHRIM_CONFIG KV namespace is not configured' },
      500
    );
  let rules: AuditStorageRoutingRule[];
  try {
    rules = await loadRoutingRules(c.env);
  } catch {
    return unavailable(c);
  }
  const name = c.req.param('name'),
    remaining = rules.filter((r) => r.name !== name);
  if (rules.length === remaining.length)
    return c.json(
      { error: 'not_found', error_description: `Rule with name "${name}" not found` },
      404
    );
  await c.env.AUTHRIM_CONFIG.put(KV_KEY_ROUTING_RULES, JSON.stringify(remaining));
  return c.json({ success: true, deleted_rule: name, remaining_rules: remaining.length });
}
export function triggerRetentionCleanup(c: Context<{ Bindings: Env }>) {
  try {
    return c.json(
      {
        error: 'not_supported',
        executed: false,
        storage: storageState(c.env),
        managed: true,
        schedule: 'every_minute',
        note: 'Automatic maintenance manages retention and scheduled export. This request does not execute cleanup.',
      },
      501
    );
  } catch {
    return unavailable(c);
  }
}
export function getStorageStats(c: Context<{ Bindings: Env }>) {
  try {
    return c.json({
      storage: storageState(c.env),
      maintenance: { managed: true, schedule: 'every_minute' },
      note: 'Setup configuration only; no storage counts were queried.',
    });
  } catch {
    return unavailable(c);
  }
}
