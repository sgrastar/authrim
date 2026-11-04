/** Audit storage reports the Setup-owned mode. These routes only edit retention. */
import type { Context } from 'hono';
import type { AuditProfile, AuditStorageRoutingRule, Env } from '@authrim/ar-lib-core';
import {
  AR_ERROR_CODES,
  AUDIT_ROUTING_CATEGORY,
  AUDIT_ROUTING_PROJECTION_KEY,
  AUDIT_ROUTING_RULES_KEY,
  ConflictError,
  createErrorResponse,
  createRuntimeProfileRegistryFromEnv,
  createRuntimeProfileWriterFromEnv,
  loadAuditRoutingState,
  loadEnvironmentProfileDefaultsFromEnv,
  getTenantIdFromContext,
  ProfileProjectionDisagreementError,
  readEnvironmentProfileDefaults,
  type SettingsManager,
} from '@authrim/ar-lib-core';
import { createInfrastructureSettingsManager } from '../../runtime-profiles';
import { comparedProfilesChanged, revertCommittedKeys } from '../../profile-switch-verify';
import { requireAdminStepUp } from '../../admin-step-up-gate';
import { sha256Hex } from '../../admin-step-up-digest';
import {
  effectiveAuditProfile,
  stableJson,
  auditDeliveryChanged,
  auditDeliveryDigests,
  auditRetentionDigest,
} from '../../audit-profile-delivery';
import {
  DEFAULT_RETENTION_CONFIG,
  auditRetentionWeakened,
  retentionConfigFromProfile,
  type RetentionConfig,
} from '../../audit-retention-compare';
import {
  resolveLogIcebergConfig,
  assertLogIcebergActivated,
} from '@authrim/ar-lib-core/services/log-iceberg-config';

const MANAGED_AUDIT_PROFILE_ID = 'managed:audit:settings-default';
/** The canonical settings store's limit for one document (JSON, UTF-8). */
const MAX_SETTINGS_DOCUMENT_BYTES = 1048576;
const RETENTION_LIMITS = { eventLogRetentionDays: 730, piiLogRetentionDays: 2555 } as const;

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
interface RoutingState {
  manager: SettingsManager;
  /** Version of the document the rules were read from: saved against, never re-read. */
  version: string;
  rules: AuditStorageRoutingRule[];
  adopt?: () => Promise<void>;
}
/** One strict canonical read (legacy rules adopted into the document first). */
async function loadRoutingState(env: Env): Promise<RoutingState> {
  const state = await loadAuditRoutingState(env);
  return { ...state, rules: state.rules.map(normalizeRoutingRule) };
}
async function loadRoutingRules(env: Env): Promise<AuditStorageRoutingRule[]> {
  return (await loadRoutingState(env)).rules;
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

/**
 * Point the default at a profile, saved against the version the decision was made on. Returns the
 * version saved and what the document held for the key before (to put back).
 */
async function setEnvironmentDefaultAuditProfileId(
  manager: SettingsManager,
  profileId: string,
  judgedVersion: string
): Promise<{ version: string; before: Record<string, unknown> }> {
  const request = { ifMatch: judgedVersion, set: { 'infra.default_audit_profile_id': profileId } };
  const dry = await manager.patch(
    'infrastructure',
    { type: 'platform' },
    request,
    'audit-storage',
    {
      dryRun: true,
    }
  );
  const saved = await manager.patch(
    'infrastructure',
    { type: 'platform' },
    request,
    'audit-storage'
  );
  return { version: saved.version, before: dry.candidate?.before ?? {} };
}

async function getResolvedAuditProfile(
  env: Env,
  options: { strict?: boolean } = {}
): Promise<{
  registry: ReturnType<typeof createRuntimeProfileRegistryFromEnv>;
  defaults: Awaited<ReturnType<typeof loadEnvironmentProfileDefaultsFromEnv>>;
  profile: AuditProfile;
}> {
  const registry = createRuntimeProfileRegistryFromEnv(env);
  const defaults = await loadEnvironmentProfileDefaultsFromEnv(env, options);
  const profile = await registry.get<AuditProfile>('audit', defaults.auditProfileId);
  if (!profile) {
    throw new Error(`audit_profile_not_found:${defaults.auditProfileId}`);
  }

  return { registry, defaults, profile };
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
function sourceCompared(read: {
  guard: { kind: 'audit' | 'residency'; id: string; expectedPayload: string | null };
}) {
  return { kind: read.guard.kind, id: read.guard.id, token: read.guard.expectedPayload };
}
function profileChanged(c: Context<{ Bindings: Env }>) {
  return createErrorResponse(c, AR_ERROR_CODES.ADMIN_CONFLICT, {
    variables: {
      resource: 'audit_retention',
      reason:
        'The settings changed while this request was being decided; repeat the step-up and retry',
    },
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
  try {
    // Shorter retention deletes logs sooner, so it needs a step-up; a longer one does not.
    // Judged the way a write resolves retention (see auditRetentionWeakened), against the profile
    // in effect now and against the managed profile the write lands in, which tenants may name
    // directly even when it is not the default. Read only: nothing is written before the step-up.
    //
    // Two things are saved after the step-up and each only against what was judged: the managed
    // profile (D1, written only if it is still the stored one) and the default (the platform
    // document, saved against the version read here). Strict: a default that cannot be read must
    // not be mistaken for the built-in one.
    const manager = createInfrastructureSettingsManager(c.env, { strict: true });
    const judged = await manager.getAll('infrastructure', { type: 'platform' });
    const defaults = readEnvironmentProfileDefaults(judged.values);
    // What runtime reads (the KV projection) must agree with the document compared: while they
    // differ (a projection still pending) the step-up could be judged against the wrong values.
    const runtimeDefaults = await loadEnvironmentProfileDefaultsFromEnv(c.env, { strict: true });
    if (
      runtimeDefaults.auditProfileId !== defaults.auditProfileId ||
      runtimeDefaults.residencyProfileId !== defaults.residencyProfileId
    ) {
      return profileChanged(c);
    }
    const writer = createRuntimeProfileWriterFromEnv(c.env);
    const registry = createRuntimeProfileRegistryFromEnv(c.env);
    const stored = await writer.readForWrite('audit', MANAGED_AUDIT_PROFILE_ID);
    // The profile compared against (the default in effect). When it is a stored profile other
    // than the managed one it is read for write as well, and the commit below is made only if
    // it is still as it was read: a change to it after this point (a retention lengthened, say)
    // would make the comparison, and so the step-up decision, wrong.
    let source: Awaited<ReturnType<typeof writer.readForWrite>> | null = null;
    let current: AuditProfile | null;
    if (defaults.auditProfileId === MANAGED_AUDIT_PROFILE_ID) {
      current = stored.profile?.kind === 'audit' ? stored.profile : null;
    } else if (defaults.auditProfileId.startsWith('builtin:')) {
      current = await registry.get<AuditProfile>('audit', defaults.auditProfileId);
    } else {
      source = await writer.readForWrite('audit', defaults.auditProfileId);
      current = source.profile?.kind === 'audit' ? source.profile : null;
    }
    if (!current) throw new Error(`audit_profile_not_found:${defaults.auditProfileId}`);
    const requested = body as Partial<RetentionConfig>;
    const base =
      defaults.auditProfileId === MANAGED_AUDIT_PROFILE_ID && !current.builtin
        ? current
        : createManagedAuditProfile(current);
    const candidate = { ...base, retention: { ...base.retention, ...requested } };
    const overwritten = stored.profile?.kind === 'audit' ? stored.profile : null;
    // While the managed profile does not exist, a tenant naming its id gets the built-in profile
    // (runtime's fallback): that is what the write is compared with, for retention and delivery.
    const baseline = effectiveAuditProfile(overwritten);
    const shortened =
      auditRetentionWeakened(current, candidate) || auditRetentionWeakened(baseline, candidate);
    // The managed profile takes the delivery of the profile it is copied from; tenants may name
    // it directly, so overwriting one that sends logs elsewhere is a destination change.
    const deliveryChanged = auditDeliveryChanged(overwritten, candidate);
    if (shortened || deliveryChanged) {
      // One receipt covers one operation: a delivery change is gated as a destination update (the
      // whole resulting retention is bound too); retention alone as a shortening.
      const refused = await requireAdminStepUp(
        c as unknown as Parameters<typeof requireAdminStepUp>[0],
        {
          operation: deliveryChanged ? 'webhook.destination.update' : 'audit.retention.shorten',
          // Both at once: the receipt carries the retention operation too (a machine needs the
          // exemption for each).
          ...(deliveryChanged && shortened
            ? { alsoCovers: ['audit.retention.shorten' as const] }
            : {}),
          targetTenantId: getTenantIdFromContext(c),
          params: {
            kind: 'audit_storage.retention',
            retention_days: Object.fromEntries(
              (Object.keys(RETENTION_LIMITS) as Array<keyof RetentionConfig>)
                .filter((name) => requested[name] !== undefined)
                .map((name) => [name, requested[name]])
            ),
            // The whole retention and delivery of the profile that gets written, not only the
            // days that were asked for.
            candidate_retention: candidate.retention ?? null,
            candidate_retention_sha256: await auditRetentionDigest(candidate),
            ...(await auditDeliveryDigests(candidate)),
          },
        }
      );
      if (refused) return refused;
    }
    // Two stores cannot commit together, so the managed profile (core D1) is written first,
    // conditional on the profiles that were compared, and taken back if the default (admin
    // D1) then cannot be saved. Writing the default first instead would point it at a profile
    // that does not exist yet (the audit service falls back to the built-in profile). KV is
    // projected only once everything is final, so runtime never reads a state that is undone.
    const next = candidate;
    const written = await writer.putIfUnchanged(next, stored.expected, {
      guards: source ? [source.guard] : [],
      deferProjection: true,
    });
    if (!written.committed) return profileChanged(c);
    try {
      if (defaults.auditProfileId !== MANAGED_AUDIT_PROFILE_ID) {
        const switched = await setEnvironmentDefaultAuditProfileId(
          manager,
          MANAGED_AUDIT_PROFILE_ID,
          judged.version
        );
        // The step-up was decided against the profile the default pointed at (the source). The
        // commit above protects only the settings document; if that profile changed since it was
        // compared, the default is put back (and the managed profile taken back below). See
        // profile-switch-verify for the window that remains and why no lock spans the two stores.
        if (source && (await comparedProfilesChanged(c.env, [sourceCompared(source)]))) {
          await revertCommittedKeys({
            manager,
            category: 'infrastructure',
            scope: { type: 'platform' },
            committedVersion: switched.version,
            before: switched.before,
            keys: ['infra.default_audit_profile_id'],
            actor: 'audit-storage',
          });
          throw new ConflictError('The profile compared against changed', {
            currentVersion: switched.version,
          });
        }
      }
    } catch (error) {
      try {
        const written = JSON.stringify(next);
        if (overwritten)
          await writer.putIfUnchanged(overwritten, written, { deferProjection: true });
        else
          await writer.deleteIfUnchanged('audit', MANAGED_AUDIT_PROFILE_ID, written, {
            deferProjection: true,
          });
      } catch {
        // Taken back only if still the profile written here; otherwise someone else changed it.
      }
      await writer.flushProjection('audit', MANAGED_AUDIT_PROFILE_ID);
      throw error;
    }
    await writer.flushProjection('audit', MANAGED_AUDIT_PROFILE_ID);
    return c.json({
      success: true,
      config: retentionConfigFromProfile(next),
      source: 'runtime_profile',
      profile_id: next.id,
      note: 'Retention applies to newly occurring logs.',
    });
  } catch (error) {
    // The defaults or the managed profile changed after the step-up decision: retry.
    if (error instanceof ConflictError || error instanceof ProfileProjectionDisagreementError)
      return profileChanged(c);
    throw error;
  }
}
export async function getRoutingRules(c: Context<{ Bindings: Env }>) {
  try {
    const rules = await loadRoutingRules(c.env);
    return c.json({
      rules,
      count: rules.length,
      kv_key: AUDIT_ROUTING_PROJECTION_KEY,
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
/**
 * Routing rules override how long matching logs are kept. Comparing the effective retention of two
 * rule sets is not cheap (conditions overlap), so any change to the rules is gated as a shortening.
 */
async function gateRoutingRulesChange(
  c: Context<{ Bindings: Env }>,
  params: Record<string, unknown>
): Promise<Response | null> {
  return requireAdminStepUp(c as unknown as Parameters<typeof requireAdminStepUp>[0], {
    operation: 'audit.retention.shorten',
    targetTenantId: getTenantIdFromContext(c),
    params: { kind: 'audit_storage.routing_rules', ...params },
  });
}
/**
 * Save a rule set against the version it was derived from: dry run (the rules are validated and
 * the version judged), the step-up (spent here, after everything that can refuse the request),
 * then the save, which fails with a conflict if the document changed since. Null on success.
 */
async function saveRoutingRules(
  c: Context<{ Bindings: Env }>,
  state: RoutingState,
  rules: AuditStorageRoutingRule[],
  gateParams: Record<string, unknown> | null
): Promise<Response | null> {
  const request = { ifMatch: state.version, set: { [AUDIT_ROUTING_RULES_KEY]: rules } };
  try {
    // Validate without saving anything; the version judged is the one read in `state`.
    const validation = state.manager.validate(AUDIT_ROUTING_CATEGORY, request.set);
    if (!validation.valid)
      return invalidRule(c, new Error(validation.errors.map((e) => e.reason).join('; ')));
    // The canonical store refuses a document over its size limit: found before the gate, so a
    // receipt is not spent on a save that cannot happen.
    if (
      new TextEncoder().encode(JSON.stringify(request.set)).byteLength > MAX_SETTINGS_DOCUMENT_BYTES
    )
      return invalidRule(c, new Error('The resulting rule set is too large to be stored'));
    if (gateParams) {
      // The receipt binds the whole resulting rule set and the version it was derived from, not
      // only the rule that was added or the name that was deleted: after a concurrent change the
      // same receipt cannot save a different resulting set.
      const refused = await gateRoutingRulesChange(c, {
        ...gateParams,
        resulting_rules_sha256: await sha256Hex(stableJson(rules)),
        judged_version: state.version,
      });
      if (refused) return refused;
    }
    // First use after an upgrade: the document is created from what was in effect only now,
    // after the gate, and the save below then fails its version check if it was created otherwise.
    await state.adopt?.();
    await state.manager.patch(
      AUDIT_ROUTING_CATEGORY,
      { type: 'platform' },
      request,
      'audit-storage'
    );
    return null;
  } catch (error) {
    if (error instanceof ConflictError)
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_CONFLICT, {
        variables: {
          resource: 'audit_routing_rules',
          reason:
            'The routing rules changed while this request was being decided; repeat the step-up and retry',
        },
      });
    throw error;
  }
}
async function loadStateOrUnavailable(
  c: Context<{ Bindings: Env }>
): Promise<RoutingState | Response> {
  try {
    return await loadRoutingState(c.env);
  } catch {
    return unavailable(c);
  }
}
export async function updateRoutingRules(c: Context<{ Bindings: Env }>) {
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
  const state = await loadStateOrUnavailable(c);
  if (state instanceof Response) return state;
  if (JSON.stringify(state.rules) !== JSON.stringify(rules)) {
    const refused = await saveRoutingRules(c, state, rules, { action: 'replace', rules });
    if (refused) return refused;
  }
  return c.json({
    success: true,
    rules,
    count: rules.length,
    kv_key: AUDIT_ROUTING_PROJECTION_KEY,
  });
}
export async function addRoutingRule(c: Context<{ Bindings: Env }>) {
  let rule: AuditStorageRoutingRule;
  try {
    rule = normalizeRoutingRule(await c.req.json());
  } catch (error) {
    return invalidRule(c, error);
  }
  const state = await loadStateOrUnavailable(c);
  if (state instanceof Response) return state;
  if (state.rules.some((r) => r.name === rule.name))
    return c.json(
      {
        error: 'invalid_request',
        error_description: `Rule with name "${rule.name}" already exists`,
      },
      400
    );
  const rules = [...state.rules, rule].sort((a, b) => a.priority - b.priority);
  const refused = await saveRoutingRules(c, state, rules, { action: 'add', rule });
  if (refused) return refused;
  return c.json({ success: true, rule, total_rules: rules.length });
}
export async function deleteRoutingRule(c: Context<{ Bindings: Env }>) {
  const state = await loadStateOrUnavailable(c);
  if (state instanceof Response) return state;
  const name = c.req.param('name'),
    remaining = state.rules.filter((r) => r.name !== name);
  if (state.rules.length === remaining.length)
    return c.json(
      { error: 'not_found', error_description: `Rule with name "${name}" not found` },
      404
    );
  const refused = await saveRoutingRules(c, state, remaining, { action: 'delete', name });
  if (refused) return refused;
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
