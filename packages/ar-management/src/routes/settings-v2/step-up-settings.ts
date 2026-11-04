/**
 * The admin step-up a Settings write needs when it weakens a protection:
 *
 * - `admin_step_up.policy.relax`: `security.admin_step_up_overrides` lowers or drops the level of
 *   an operation, or `security.admin_step_up_enforced` goes from on (or unset) to off.
 * - `audit.retention.shorten`: `audit.check_api_retention_days` or `admin-notices.retention_days`
 *   becomes shorter (or is switched off).
 *
 * - `tenant.jurisdiction.update`: the `tenant` category's `tenant.residency_profile_id` changes which
 *   residency profile applies and the jurisdiction differs (an unknown profile counts as differing).
 * - `audit.retention.shorten` also covers `tenant.audit_profile_id` switching to an audit profile
 *   that keeps logs for less time (see `auditRetentionWeakened`).
 *
 * Judged on the document the save would leave (a dry run of the same patch), against what is in
 * effect now, so a PATCH that only raises a level or lengthens a retention is not gated. The
 * receipt is spent here, once, after every validation and just before the write.
 */
import type { Context } from 'hono';
import {
  createRuntimeProfileRegistryFromEnv,
  loadEnvironmentProfileDefaultsFromEnv,
  ADMIN_STEP_UP_ENFORCED_KEY,
  ADMIN_STEP_UP_OVERRIDES_KEY,
  DISABLED_MARKER,
  settingsParentScopes,
  type AdminAuthContext,
  type AuditProfile,
  type ResidencyProfile,
  type CategoryName,
  type Env,
  type SettingScope,
  type SettingsPatchRequest,
} from '@authrim/ar-lib-core';
import type { AdminStepUpOperationDescriptor } from '@authrim/ar-lib-core';
import { requireAdminStepUp } from '../../admin-step-up-gate';
import { auditRetentionWeakened } from '../../audit-retention-compare';
import type { getSettingsManager } from './settings-support';

export const RETENTION_SETTING_KEYS = [
  'audit.check_api_retention_days',
  'admin-notices.retention_days',
] as const;
export const TENANT_PROFILE_KEYS = [
  'tenant.residency_profile_id',
  'tenant.audit_profile_id',
] as const;
const POLICY_KEYS = [ADMIN_STEP_UP_OVERRIDES_KEY, ADMIN_STEP_UP_ENFORCED_KEY] as const;
const LEVEL_RANK: Record<string, number> = { L1: 1, L2: 2 };

type Doc = Record<string, unknown>;

/** The value in effect: the scope's own, else what it inherits; the disabled marker reads as false. */
function effective(own: Doc, inherited: Doc, key: string): unknown {
  const value = own[key];
  if (value === undefined) return inherited[key];
  return value === DISABLED_MARKER ? false : value;
}

function levels(value: unknown): Record<string, number> {
  const result: Record<string, number> = {};
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [operation, level] of Object.entries(value)) {
      result[operation] = typeof level === 'string' ? (LEVEL_RANK[level] ?? 0) : 0;
    }
  }
  return result;
}

export type StepUpSettingsDecision =
  | { kind: 'none' }
  | {
      kind: 'gate';
      operation: 'admin_step_up.policy.relax' | 'audit.retention.shorten';
      params: Record<string, unknown>;
    };

/** Whether a PATCH names a setting this module guards (cheap check before any read). */
export function patchTouchesStepUpSettings(body: SettingsPatchRequest): boolean {
  const guarded: readonly string[] = [
    ...POLICY_KEYS,
    ...RETENTION_SETTING_KEYS,
    ...TENANT_PROFILE_KEYS,
  ];
  const named = [...Object.keys(body.set ?? {}), ...(body.clear ?? []), ...(body.disable ?? [])];
  return named.some((key) => guarded.includes(key));
}

/** What the change does to the guarded settings; pure, from the documents before and after. */
export function decideStepUpSettings(input: {
  scopeType: string;
  before: Doc;
  after: Doc;
  inherited: Doc;
}): StepUpSettingsDecision {
  const { before, after, inherited } = input;

  const params: Record<string, unknown> = { scope: input.scopeType };
  let relax = false;

  const overridesBefore = levels(effective(before, inherited, ADMIN_STEP_UP_OVERRIDES_KEY));
  const overridesAfterRaw = effective(after, inherited, ADMIN_STEP_UP_OVERRIDES_KEY);
  const overridesAfter = levels(overridesAfterRaw);
  if (Object.entries(overridesBefore).some(([op, rank]) => (overridesAfter[op] ?? 0) < rank)) {
    relax = true;
    params.admin_step_up_overrides = overridesAfterRaw ?? null;
  }

  const enforcedBefore = effective(before, inherited, ADMIN_STEP_UP_ENFORCED_KEY);
  const enforcedAfter = effective(after, inherited, ADMIN_STEP_UP_ENFORCED_KEY);
  if (enforcedBefore !== false && enforcedAfter === false) {
    relax = true;
    params.admin_step_up_enforced = false;
  }

  const retention: Record<string, unknown> = {};
  for (const key of RETENTION_SETTING_KEYS) {
    const was = effective(before, inherited, key);
    const now = effective(after, inherited, key);
    if (typeof was !== 'number') continue;
    if (typeof now !== 'number' || now < was) retention[key] = now === undefined ? null : now;
  }
  const shorten = Object.keys(retention).length > 0;
  if (shorten) params.retention_days = retention;

  if (relax) return { kind: 'gate', operation: 'admin_step_up.policy.relax', params };
  if (shorten) return { kind: 'gate', operation: 'audit.retention.shorten', params };
  return { kind: 'none' };
}

type StepUpNeed = {
  operation:
    | 'admin_step_up.policy.relax'
    | 'tenant.jurisdiction.update'
    | 'audit.retention.shorten';
  params: Record<string, unknown>;
};

function profileId(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * The profile switch a `tenant` PATCH makes: the effective residency / audit profile id (the
 * tenant's own, else the environment default) before and after, judged against the registry.
 */
async function decideProfileSwitch(input: {
  env: Env;
  before: Doc;
  after: Doc;
  inherited: Doc;
}): Promise<StepUpNeed[]> {
  const { env, before, after, inherited } = input;
  const result: StepUpNeed[] = [];
  const touched = TENANT_PROFILE_KEYS.some(
    (key) =>
      profileId(effective(before, inherited, key)) !== profileId(effective(after, inherited, key))
  );
  if (!touched) return result;

  // Read strictly: a default that cannot be read is not replaced by the built-in one, which could
  // make a jurisdiction or retention change look like no change (the save then fails instead).
  const defaults = await loadEnvironmentProfileDefaultsFromEnv(env, { strict: true });
  const registry = createRuntimeProfileRegistryFromEnv(env);
  const idOf = (doc: Doc, key: (typeof TENANT_PROFILE_KEYS)[number], fallback: string) =>
    profileId(effective(doc, inherited, key)) || fallback;

  const residencyBefore = idOf(before, 'tenant.residency_profile_id', defaults.residencyProfileId);
  const residencyAfter = idOf(after, 'tenant.residency_profile_id', defaults.residencyProfileId);
  if (residencyBefore !== residencyAfter) {
    const [was, now] = await Promise.all([
      registry.get<ResidencyProfile>('residency', residencyBefore),
      registry.get<ResidencyProfile>('residency', residencyAfter),
    ]);
    const from = was?.kind === 'residency' ? was.jurisdiction : null;
    const to = now?.kind === 'residency' ? now.jurisdiction : null;
    // An unknown profile on either side cannot be compared: treat it as a change.
    if (from === null || to === null || from !== to) {
      result.push({
        operation: 'tenant.jurisdiction.update',
        params: {
          residency_profile_id: residencyAfter,
          from_jurisdiction: from,
          to_jurisdiction: to,
        },
      });
    }
  }

  const auditBefore = idOf(before, 'tenant.audit_profile_id', defaults.auditProfileId);
  const auditAfter = idOf(after, 'tenant.audit_profile_id', defaults.auditProfileId);
  if (auditBefore !== auditAfter) {
    const [was, now] = await Promise.all([
      registry.get<AuditProfile>('audit', auditBefore),
      registry.get<AuditProfile>('audit', auditAfter),
    ]);
    if (was?.kind !== 'audit' || now?.kind !== 'audit' || auditRetentionWeakened(was, now)) {
      result.push({
        operation: 'audit.retention.shorten',
        params: { audit_profile_id: auditAfter, retention: now?.retention ?? null },
      });
    }
  }
  return result;
}

/**
 * Null when the PATCH may be saved, else the response refusing it (step-up needed). The policy
 * keys (`security`) and the retention keys (`check-api-audit`, `admin-notices`) live in different
 * categories, so one PATCH never needs both operations. Call it after the PATCH is validated and
 * just before saving.
 */
export async function gateStepUpSettingsPatch(input: {
  c: Context<{ Bindings: Env; Variables: { adminAuth?: AdminAuthContext } }, string>;
  manager: ReturnType<typeof getSettingsManager>;
  category: CategoryName;
  scope: SettingScope;
  /** The tenant whose step-up policy applies (the tenant, or the caller's tenant for platform). */
  targetTenantId: string;
  body: SettingsPatchRequest;
  actor: string;
  /** Refuse (400) instead of asking for a step-up: the change must be made on its own. */
  refuse?: boolean;
}): Promise<Response | null> {
  const { c, manager, category, scope, body } = input;
  if (!patchTouchesStepUpSettings(body)) return null;
  const parents = settingsParentScopes(category, scope);
  const decision = await manager.patch(category, scope, body, input.actor, {
    parents,
    dryRun: true,
  });
  if (!decision.candidate) return null;
  const state = await manager.getAll(category, scope, { parents });
  const settingsOutcome = decideStepUpSettings({
    scopeType: scope.type,
    before: decision.candidate.before,
    after: decision.candidate.after,
    inherited: state.inherited.values,
  });
  const switches =
    category === 'tenant'
      ? await decideProfileSwitch({
          env: c.env,
          before: decision.candidate.before,
          after: decision.candidate.after,
          inherited: state.inherited.values,
        })
      : [];
  const needed: StepUpNeed[] = [
    ...(settingsOutcome.kind === 'gate'
      ? [{ operation: settingsOutcome.operation, params: settingsOutcome.params }]
      : []),
    ...switches,
  ];
  if (needed.length === 0) return null;
  const operations = [...new Set(needed.map((item) => item.operation))];
  if (operations.length > 1) {
    return c.json(
      {
        error: 'step_up_separate_operations',
        error_description:
          'This change needs more than one step-up (jurisdiction and audit retention): change them in separate requests',
        operations,
      },
      400
    );
  }
  const outcome = needed[0];
  if (!outcome) return null;
  const params = Object.assign({}, ...needed.map((item) => item.params)) as Record<string, unknown>;
  if (input.refuse) {
    return c.json(
      {
        error: 'step_up_not_in_bulk',
        error_description:
          'This change weakens the step-up policy, shortens a retention or changes the data jurisdiction: apply it on its own, with a step-up',
        operation: outcome.operation,
      },
      400
    );
  }
  const descriptor: AdminStepUpOperationDescriptor = {
    operation: outcome.operation,
    targetTenantId: input.targetTenantId,
    params: { category, ...params },
  };
  return requireAdminStepUp(c, descriptor);
}
