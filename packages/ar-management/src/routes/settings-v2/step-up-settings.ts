/**
 * The admin step-up a Settings write needs when it weakens a protection:
 *
 * - `admin_step_up.policy.relax`: `security.admin_step_up_overrides` lowers or drops the level of
 *   an operation, or `security.admin_step_up_enforced` goes from on (or unset) to off.
 * - `admin_step_up.policy.relax` also covers `security.admin_second_factor_allowed_kinds` allowing
 *   a kind of second factor it did not (a weaker one, such as an authenticator app). Needs L2 like
 *   any relaxation, except where the administrator making the change has no second factor that
 *   counts under the policy in effect (so could not give L2 for it, as in a tenant that has none yet): then a fresh passkey is enough, the change is
 *   written to the audit log, and the tenant's other administrators are told by email. Not at the
 *   platform scope, where the list is the default for every tenant: that always needs L2.
 * - `audit.retention.shorten`: `audit.check_api_retention_days` or `admin-notices.retention_days`
 *   becomes shorter (or is switched off).
 *
 * - `admin_invitation.code_handoff.enable`: `admin_invitations.code_handoff_enabled` goes from off
 *   (or unset, with the environment variable and default off) to on. Turning it off is free. A
 *   machine can never do it (the operation is always enforced and needs a signed-in human).
 *
 * - `machine_access.excluded_tenants.relax`: `machine_access.all_scope_excluded_tenants` stops
 *   listing a tenant it listed (removed, cleared, or the whole value replaced). Adding a tenant
 *   is free. Always enforced: a machine can never lift the protection.
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
  ProfileProjectionDisagreementError,
  loadEnvironmentProfileDefaultsFromEnv,
  readEnvironmentProfileDefaults,
  ADMIN_NOTICES_DEFAULTS,
  ADMIN_STEP_UP_ENFORCED_KEY,
  ADMIN_STEP_UP_OVERRIDES_KEY,
  ADMIN_SECOND_FACTOR_ALLOWED_KINDS_KEY,
  AdminSecondFactorRepository,
  evaluateAdminStepUpEvidence,
  isAdminSecondFactorKindAllowed,
  isAdminStepUpHumanSession,
  requireDedicatedAdminDatabaseAdapter,
  resolveAdminSecondFactorAllowedKinds,
  widensAdminSecondFactorKinds,
  ADMIN_INVITATION_CODE_HANDOFF_KEY,
  MACHINE_ACCESS_ALL_SCOPE_EXCLUDED_TENANTS_KEY,
  readMachineExcludedTenants,
  CHECK_API_AUDIT_DEFAULTS,
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
import { refuseAdminFreshAuth, requireAdminStepUp } from '../../admin-step-up-gate';
import { writeAdminAuditLog } from '../../admin-shared';
import {
  noticeSecondFactorKindsWidened,
  showSecondFactorKindsWidenedInConsole,
} from './second-factor-policy-notice';
import { auditRetentionWeakened } from '../../audit-retention-compare';
import { createInfrastructureSettingsManager } from '../../runtime-profiles';
import { auditDeliveryChanged, auditDeliveryDigests } from '../../audit-profile-delivery';
import {
  readComparedProfile,
  verifySwitchAfterCommit,
  type ProfileSwitchGuard,
} from '../../profile-switch-verify';
import type { getSettingsManager } from './settings-support';

export const RETENTION_SETTING_KEYS = [
  'audit.check_api_retention_days',
  'admin-notices.retention_days',
] as const;
const RETENTION_DEFAULTS: Record<(typeof RETENTION_SETTING_KEYS)[number], number> = {
  'audit.check_api_retention_days': CHECK_API_AUDIT_DEFAULTS['audit.check_api_retention_days'],
  'admin-notices.retention_days': ADMIN_NOTICES_DEFAULTS['admin-notices.retention_days'],
};
export const TENANT_PROFILE_KEYS = [
  'tenant.residency_profile_id',
  'tenant.audit_profile_id',
] as const;
const POLICY_KEYS = [
  ADMIN_STEP_UP_OVERRIDES_KEY,
  ADMIN_STEP_UP_ENFORCED_KEY,
  ADMIN_SECOND_FACTOR_ALLOWED_KINDS_KEY,
] as const;
const HANDOFF_KEYS = [ADMIN_INVITATION_CODE_HANDOFF_KEY] as const;
const MACHINE_EXCLUSION_KEYS = [MACHINE_ACCESS_ALL_SCOPE_EXCLUDED_TENANTS_KEY] as const;
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
      operation:
        | 'admin_step_up.policy.relax'
        | 'audit.retention.shorten'
        | 'admin_invitation.code_handoff.enable'
        | 'machine_access.excluded_tenants.relax';
      params: Record<string, unknown>;
      /**
       * The change only widens the allowed second-factor kinds (nothing else relaxes): where no
       * administrator can give L2 it is let through on a fresh passkey, with a notice.
       */
      widensKindsOnly?: boolean;
    };

/** Whether a PATCH names a setting this module guards (cheap check before any read). */
export function patchTouchesStepUpSettings(body: SettingsPatchRequest): boolean {
  const guarded: readonly string[] = [
    ...POLICY_KEYS,
    ...HANDOFF_KEYS,
    ...MACHINE_EXCLUSION_KEYS,
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

  // Allowing a kind of second factor the tenant did not allow weakens L2 as well.
  const kindsAfterRaw = effective(after, inherited, ADMIN_SECOND_FACTOR_ALLOWED_KINDS_KEY);
  const widensKinds = widensAdminSecondFactorKinds(
    effective(before, inherited, ADMIN_SECOND_FACTOR_ALLOWED_KINDS_KEY),
    kindsAfterRaw
  );
  // Only a widening when nothing else in this change needs a gate: decided below, once every
  // other relaxation has been evaluated.
  const relaxesOtherPolicy = relax;
  if (widensKinds) {
    relax = true;
    params.admin_second_factor_allowed_kinds = [
      ...resolveAdminSecondFactorAllowedKinds(kindsAfterRaw),
    ].sort();
  }

  // An unset value is the default the feature runs with, so a value set below it shortens too.
  // Anything that is not a number afterwards (off, cleared to an unknown) counts as shorter.
  const retention: Record<string, unknown> = {};
  for (const key of RETENTION_SETTING_KEYS) {
    const wasRaw = effective(before, inherited, key);
    const nowRaw = effective(after, inherited, key);
    const was = wasRaw === undefined ? RETENTION_DEFAULTS[key] : wasRaw;
    const now = nowRaw === undefined ? RETENTION_DEFAULTS[key] : nowRaw;
    if (typeof was !== 'number') {
      // Off before (kept forever): turning it on with any period shortens it.
      if (was === false && typeof now === 'number') retention[key] = now;
      continue;
    }
    if (typeof now !== 'number' || now < was) retention[key] = now ?? null;
  }
  const shorten = Object.keys(retention).length > 0;
  if (shorten) params.retention_days = retention;

  // The code handoff switch: only off (or unset) -> on needs a human step-up. Anything that is not
  // exactly true reads as off. An unset value is what the scope inherits: at platform scope that
  // is the environment variable, else the default (off).
  const handoffOn = (doc: Doc): boolean =>
    effective(doc, inherited, ADMIN_INVITATION_CODE_HANDOFF_KEY) === true;
  const handoffEnabled = !handoffOn(before) && handoffOn(after);

  // The tenants an all-tenants machine scope does not include: only lifting the protection needs
  // a human step-up (a tenant dropped from the list, the list emptied or replaced by something
  // that is not a valid list). An unset value is what the scope inherits (environment variable,
  // else the empty default). A value that is not valid reads as every tenant excluded.
  const excludedBefore = readMachineExcludedTenants(
    effective(before, inherited, MACHINE_ACCESS_ALL_SCOPE_EXCLUDED_TENANTS_KEY)
  );
  const excludedAfter = readMachineExcludedTenants(
    effective(after, inherited, MACHINE_ACCESS_ALL_SCOPE_EXCLUDED_TENANTS_KEY)
  );
  const excludedRelaxed =
    excludedBefore.kind === 'all'
      ? excludedAfter.kind !== 'all'
      : excludedBefore.kind === 'list' &&
        (excludedAfter.kind === 'none' ||
          (excludedAfter.kind === 'list' &&
            [...excludedBefore.tenants].some((tenantId) => !excludedAfter.tenants.has(tenantId))));

  if (relax) {
    // The passkey-only way through is for a change whose only weakening is the allowed kinds.
    // Not at the platform: that widens every tenant at once, which a passkey alone never
    // authorises (and the notice reaches one tenant's administrators only), so it needs L2.
    const widensKindsOnly =
      widensKinds &&
      input.scopeType === 'tenant' &&
      !relaxesOtherPolicy &&
      !excludedRelaxed &&
      !handoffEnabled &&
      !shorten;
    return {
      kind: 'gate',
      operation: 'admin_step_up.policy.relax',
      params,
      ...(widensKindsOnly ? { widensKindsOnly: true } : {}),
    };
  }
  if (excludedRelaxed) {
    return {
      kind: 'gate',
      operation: 'machine_access.excluded_tenants.relax',
      params: {
        ...params,
        [MACHINE_ACCESS_ALL_SCOPE_EXCLUDED_TENANTS_KEY]:
          effective(after, inherited, MACHINE_ACCESS_ALL_SCOPE_EXCLUDED_TENANTS_KEY) ?? '',
      },
    };
  }
  if (handoffEnabled) {
    return {
      kind: 'gate',
      operation: 'admin_invitation.code_handoff.enable',
      params: { ...params, [ADMIN_INVITATION_CODE_HANDOFF_KEY]: true },
    };
  }
  if (shorten) return { kind: 'gate', operation: 'audit.retention.shorten', params };
  return { kind: 'none' };
}

type StepUpNeed = {
  operation:
    | 'admin_step_up.policy.relax'
    | 'admin_invitation.code_handoff.enable'
    | 'machine_access.excluded_tenants.relax'
    | 'tenant.jurisdiction.update'
    | 'webhook.destination.update'
    | 'audit.retention.shorten';
  params: Record<string, unknown>;
  /** Further operations this one request needs (delivery changed and retention shortened). */
  alsoCovers?: Array<'audit.retention.shorten'>;
  /** Only the allowed second-factor kinds are widened (see `decideStepUpSettings`). */
  widensKindsOnly?: boolean;
};

/**
 * Work for after the save has committed. The gate fills it when it let a change through on less
 * than L2, so the change is recorded and announced only once it took effect.
 */
export interface StepUpSettingsPending {
  afterSave?: () => Promise<void>;
}

/** Run the work the gate left for after the save; never fails the change that took effect. */
export async function runStepUpSettingsAfterSave(pending: StepUpSettingsPending): Promise<void> {
  try {
    await pending.afterSave?.();
  } catch {
    // The change is saved; the audit entry and the notice are best effort.
  }
}

/**
 * The way through for widening the allowed second-factor kinds when the administrator making the
 * change could not give L2 for it (no second factor that counts under the policy in effect): a fresh passkey is enough. Returns undefined when the normal L2 gate applies (the
 * admin has a second factor that counts under the policy in effect now, or is not a signed-in
 * human), the refusal when the passkey is not fresh, or null once the change may go ahead.
 */
async function widenKindsWithoutSecondFactor(input: {
  c: Context<{ Bindings: Env; Variables: { adminAuth?: AdminAuthContext } }, string>;
  targetTenantId: string;
  allowedBefore: unknown;
  allowedAfter: unknown;
  pending?: StepUpSettingsPending;
}): Promise<Response | null | undefined> {
  const { c } = input;
  const auth = c.get('adminAuth');
  if (!auth || !isAdminStepUpHumanSession(auth) || !auth.sessionTenantId) return undefined;
  const factors = await new AdminSecondFactorRepository(
    requireDedicatedAdminDatabaseAdapter(c.env, 'admin-second-factor-policy')
  ).listActiveByUser(auth.userId);
  const allowed = resolveAdminSecondFactorAllowedKinds(input.allowedBefore);
  if (factors.some((factor) => isAdminSecondFactorKindAllowed(factor.kind, allowed))) {
    return undefined;
  }
  if (evaluateAdminStepUpEvidence(auth, 'L1', Date.now()).missing.length > 0) {
    return refuseAdminFreshAuth(c);
  }
  const kinds = [...resolveAdminSecondFactorAllowedKinds(input.allowedAfter)].sort();
  // The record that this was let through on a passkey alone is written first, and the change
  // does not go ahead without it: an unrecorded weakening is the one thing this way through
  // must never allow. (The notices below follow the save and are best effort.)
  const recorded = await writeAdminAuditLog(c, {
    action: 'admin.second_factor_policy.widened_without_second_factor',
    resourceType: 'tenant',
    resourceId: input.targetTenantId,
    result: 'success',
    severity: 'warn',
    metadata: { allowed_kinds: kinds, authorized_with: 'passkey_only' },
  });
  if (recorded === null) {
    return c.json(
      {
        error: 'audit_unavailable',
        error_description: 'The change could not be recorded, so it was not made',
      },
      503
    );
  }
  if (input.pending) {
    input.pending.afterSave = async () => {
      const notice = {
        tenantId: input.targetTenantId,
        actor: { id: auth.userId, ...(auth.email ? { email: auth.email } : {}) },
        kinds,
        now: Date.now(),
      };
      // Two channels, each on its own: the console notice needs no mail setup, the email reaches
      // administrators who are not looking at the console.
      await Promise.allSettled([
        showSecondFactorKindsWidenedInConsole(c.env, notice),
        noticeSecondFactorKindsWidened(c.env, notice),
      ]);
    };
  }
  return null;
}

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
  /** Receives the profiles compared, to verify the save after it commits. */
  guard?: ProfileSwitchGuard;
}): Promise<StepUpNeed[]> {
  const { env, before, after, inherited, guard } = input;
  const result: StepUpNeed[] = [];
  // A key counts when the profile in effect changes or the tenant's own value does: setting the
  // id the tenant already inherits from the default leaves the effective id as it was, but the
  // tenant then stops following the default, so the default document is part of the decision.
  const keyTouched = (key: (typeof TENANT_PROFILE_KEYS)[number]) =>
    profileId(effective(before, inherited, key)) !== profileId(effective(after, inherited, key)) ||
    profileId(before[key]) !== profileId(after[key]);
  const touched = TENANT_PROFILE_KEYS.some(keyTouched);
  if (!touched) return result;

  // The environment default is read from the canonical document (with its version), strictly: a
  // default that cannot be read is not replaced by the built-in one, which could make a
  // jurisdiction or retention change look like no change (the save then fails instead). What
  // runtime reads (the KV projection) must agree with it, or the comparison could be made
  // against values other than the ones in effect.
  const infrastructure = await createInfrastructureSettingsManager(env, {
    strict: true,
  }).getAll('infrastructure', { type: 'platform' });
  const defaults = readEnvironmentProfileDefaults(infrastructure.values);
  const projected = await loadEnvironmentProfileDefaultsFromEnv(env, { strict: true });
  if (
    projected.auditProfileId !== defaults.auditProfileId ||
    projected.residencyProfileId !== defaults.residencyProfileId
  ) {
    throw new ProfileProjectionDisagreementError();
  }
  // When a side of the switch is the environment default (the tenant sets no id of its own), the
  // default document is part of what the decision rests on. The tenant document's save cannot
  // also be conditional on it (the settings manager takes no second precondition), so it is
  // verified after the commit and the switch is put back if the default moved
  // (profile-switch-verify).
  const idOf = (doc: Doc, key: (typeof TENANT_PROFILE_KEYS)[number], fallback: string) =>
    profileId(effective(doc, inherited, key)) || fallback;
  const noteDefaultUsed = (key: (typeof TENANT_PROFILE_KEYS)[number]) => {
    const fromDefault =
      !profileId(effective(before, inherited, key)) || !profileId(effective(after, inherited, key));
    if (guard && fromDefault) guard.infrastructureVersion = infrastructure.version;
  };

  for (const key of TENANT_PROFILE_KEYS) {
    if (keyTouched(key)) noteDefaultUsed(key);
  }
  const residencyBefore = idOf(before, 'tenant.residency_profile_id', defaults.residencyProfileId);
  const residencyAfter = idOf(after, 'tenant.residency_profile_id', defaults.residencyProfileId);
  if (residencyBefore !== residencyAfter) {
    const [was, now] = (await Promise.all([
      readComparedProfile(env, 'residency', residencyBefore, guard),
      readComparedProfile(env, 'residency', residencyAfter, guard),
    ])) as [ResidencyProfile | null, ResidencyProfile | null];
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
    const [was, now] = (await Promise.all([
      readComparedProfile(env, 'audit', auditBefore, guard),
      readComparedProfile(env, 'audit', auditAfter, guard),
    ])) as [AuditProfile | null, AuditProfile | null];
    // Switching to a profile that sends logs elsewhere is a destination change even when it keeps
    // logs as long; one receipt covers one operation, so that is gated as a destination update
    // with the resulting retention bound in the params.
    // An id that is not registered is what runtime uses for it, the built-in profile, on either
    // side (dangling references are allowed, so they are compared, not refused).
    const deliveryDiffers = auditDeliveryChanged(
      was?.kind === 'audit' ? was : null,
      now?.kind === 'audit' ? now : null
    );
    const retentionGated =
      was?.kind !== 'audit' || now?.kind !== 'audit' || auditRetentionWeakened(was, now);
    if (retentionGated || deliveryDiffers) {
      result.push({
        operation: deliveryDiffers ? 'webhook.destination.update' : 'audit.retention.shorten',
        // Both at once: one receipt, carrying the retention operation too.
        ...(deliveryDiffers && retentionGated
          ? { alsoCovers: ['audit.retention.shorten' as const] }
          : {}),
        params: {
          audit_profile_id: auditAfter,
          retention: now?.retention ?? null,
          ...(await auditDeliveryDigests(now?.kind === 'audit' ? now : null)),
        },
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
  /**
   * Filled when the PATCH switches a profile: pass it to `verifyProfileSwitch` after the save, so
   * a profile that changed after this decision puts the switch back (see profile-switch-verify).
   */
  guard?: ProfileSwitchGuard;
  /** Filled when the change went through on less than L2: run `afterSave` once it is saved. */
  pending?: StepUpSettingsPending;
}): Promise<Response | null> {
  const { c, manager, category, scope, body } = input;
  if (!patchTouchesStepUpSettings(body)) return null;
  const parents = settingsParentScopes(category, scope);
  const decision = await manager.patch(category, scope, body, input.actor, {
    parents,
    dryRun: true,
  });
  if (!decision.candidate) return null;
  if (input.guard) input.guard.before = decision.candidate.before;
  const state = await manager.getAll(category, scope, { parents });
  const settingsOutcome = decideStepUpSettings({
    scopeType: scope.type,
    before: decision.candidate.before,
    after: decision.candidate.after,
    inherited: state.inherited.values,
  });
  let switches: StepUpNeed[] = [];
  if (category === 'tenant') {
    try {
      switches = await decideProfileSwitch({
        env: c.env,
        before: decision.candidate.before,
        after: decision.candidate.after,
        inherited: state.inherited.values,
        guard: input.guard,
      });
    } catch (error) {
      // KV and D1 disagree about a profile (a projection pending): it was repaired; retry.
      if (error instanceof ProfileProjectionDisagreementError) {
        return c.json(
          {
            error: 'conflict',
            message: 'A runtime profile was still being updated; retry the request',
          },
          409
        );
      }
      throw error;
    }
  }
  const needed: StepUpNeed[] = [
    ...(settingsOutcome.kind === 'gate'
      ? [
          {
            operation: settingsOutcome.operation,
            params: settingsOutcome.params,
            ...(settingsOutcome.widensKindsOnly ? { widensKindsOnly: true } : {}),
          },
        ]
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
  // Widening the allowed second-factor kinds where nobody could give L2 for it: a fresh passkey,
  // recorded and announced after the save (a request that also relaxes something else keeps L2).
  if (needed.length === 1 && outcome.widensKindsOnly) {
    const fallback = await widenKindsWithoutSecondFactor({
      c,
      targetTenantId: input.targetTenantId,
      allowedBefore: effective(
        decision.candidate.before,
        state.inherited.values,
        ADMIN_SECOND_FACTOR_ALLOWED_KINDS_KEY
      ),
      allowedAfter: effective(
        decision.candidate.after,
        state.inherited.values,
        ADMIN_SECOND_FACTOR_ALLOWED_KINDS_KEY
      ),
      pending: input.pending,
    });
    if (fallback !== undefined) return fallback;
  }
  const descriptor: AdminStepUpOperationDescriptor = {
    operation: outcome.operation,
    targetTenantId: input.targetTenantId,
    params: { category, ...params },
    // A switch that changes delivery and shortens retention at once (see decideProfileSwitch). A
    // request needing two different operations (jurisdiction and audit) is still refused above
    // with step_up_separate_operations: one receipt per operation keeps those requests simple.
    ...(outcome.alsoCovers && outcome.alsoCovers.length > 0
      ? { alsoCovers: outcome.alsoCovers }
      : {}),
  };
  return requireAdminStepUp(c, descriptor);
}

/**
 * Call after a PATCH was saved. True when nothing needs to happen; false when a profile compared
 * for a profile switch changed after the decision and the save was therefore put back: answer 409.
 */
export async function verifyProfileSwitch(input: {
  env: Env;
  manager: ReturnType<typeof getSettingsManager>;
  category: CategoryName;
  scope: SettingScope;
  guard: ProfileSwitchGuard;
  result: { version: string; applied: string[]; cleared: string[]; disabled: string[] };
  actor: string;
}): Promise<boolean> {
  return verifySwitchAfterCommit({
    env: input.env,
    manager: input.manager,
    category: input.category,
    scope: input.scope,
    guard: input.guard,
    committedVersion: input.result.version,
    changedKeys: [
      ...input.result.applied,
      ...input.result.cleared,
      ...input.result.disabled,
    ].filter((key) => (TENANT_PROFILE_KEYS as readonly string[]).includes(key)),
    actor: input.actor,
  });
}
