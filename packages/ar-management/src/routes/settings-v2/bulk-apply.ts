/**
 * POST /api/admin/settings/bulk-apply
 *
 * Gives the same settings to several tenants in one request: `preview` says what would happen to
 * each tenant, writing nothing; `apply` does it, tenant by tenant and independently (one tenant
 * failing does not stop or undo another). It works for any setting a tenant can have that the
 * policy allows (see settings-bulk-apply-policy.ts), not for one in particular.
 *
 * Every write goes through `applyTenantSettingsChange`, the function the tenant PATCH route runs,
 * with the caller's own authority checked again for each tenant: the entrance asks for the
 * platform's authority, and the write asks for the right to edit that tenant's category. A tenant
 * the request does not name is never touched, and a result carries nothing of another tenant.
 */
import type { Context, MiddlewareHandler } from 'hono';
import {
  ADMIN_PERMISSIONS,
  bulkApplyCategoryVerdict,
  bulkApplyKeyVerdict,
  createAuditLogFromContext,
  createLogger,
  ensureDatabaseAdapter,
  hasGlobalMachinePermission,
  type AdminAuthContext,
  type CategoryName,
  type Env,
  type SettingScope,
  type SettingsGetResult,
  type TenantDatabaseRequestCache,
  settingsParentScopes,
} from '@authrim/ar-lib-core';
import { mapWithConcurrency } from '../../map-with-concurrency';
import { getSingleTenantId, isSingleTenantMode } from '../../single-tenant-guard';
import { bulkApplyImpactProviders } from './bulk-apply-impact';
import { BULK_APPLY_STARTED } from './bulk-apply-idempotency';
import { summarizeValue } from './bulk-apply-size';
import {
  parseBulkApplyRequest,
  resolveBulkApplyLimits,
  type BulkApplyChange,
  type BulkApplyRequest,
} from './bulk-apply-request';
import {
  canAccessTenant,
  hasGlobalPlatformSettingsEdit,
  hasTenantSettingsPermission,
} from './settings-authorization';
import { getSettingsManager } from './settings-support';
import { applyTenantSettingsChange, type ValidationRefusal } from './tenant-settings-apply';

const log = createLogger().module('SETTINGS_BULK_APPLY');

type BulkContext = Context<{ Bindings: Env; Variables: { adminAuth?: AdminAuthContext } }, string>;

/** How many tenants are worked on at once: each is several subrequests. */
const TENANT_CONCURRENCY = 4;

// ---------------------------------------------------------------------------------------------
// Authority
// ---------------------------------------------------------------------------------------------

/**
 * Whether the caller may use the bulk apply at all: the authority that changes what every tenant
 * inherits (a platform role through a global assignment with a global tenant scope, or a machine
 * token with the settings write permission for every tenant). An Agent never does: its settings
 * writes need an approval for each Tool call, which a bulk request cannot carry.
 */
export function hasGlobalBulkApplyAuthority(adminAuth: AdminAuthContext | undefined): boolean {
  if (!adminAuth || adminAuth.actorType === 'agent') return false;
  return hasGlobalPlatformSettingsEdit(adminAuth, 'bulk-apply');
}

/**
 * The tenant access check of a bulk write. The caller already holds the platform's authority, so
 * a machine token for every tenant reaches tenants other than the one the request arrived on
 * (`canAccessTenant` ties a machine to the request's tenant); a person is judged as on a PATCH.
 */
function canReachTenant(adminAuth: AdminAuthContext | undefined, tenantId: string): boolean {
  if (canAccessTenant(adminAuth, tenantId)) return true;
  return (
    adminAuth?.authMethod === 'machine_access_token' &&
    hasGlobalMachinePermission(adminAuth, ADMIN_PERMISSIONS.SETTINGS_WRITE)
  );
}

export const requireBulkApplyAuthority: MiddlewareHandler<{
  Bindings: Env;
  Variables: { adminAuth?: AdminAuthContext };
}> = async (c, next) => {
  if (!hasGlobalBulkApplyAuthority(c.get('adminAuth'))) {
    return c.json(
      {
        error: 'forbidden',
        message: 'Insufficient permissions: the bulk apply needs the platform settings authority',
      },
      403
    );
  }
  return next();
};

// ---------------------------------------------------------------------------------------------
// The plan for one tenant and one category
// ---------------------------------------------------------------------------------------------

type EntryOp = 'set' | 'clear';

interface CurrentView {
  /** Whether the tenant has a value of its own (an override of what it inherits). */
  overridden: boolean;
  own: unknown;
  effective: unknown;
  source: string;
}

interface PlannedEntry {
  key: string;
  op: EntryOp;
  proposed: unknown;
  current: CurrentView | null;
  /** `pending`: to be written (after validation); the others are decided already. */
  decision: 'pending' | 'skip' | 'reject' | 'conflict';
  reason?: string;
}

interface CategoryPlan {
  category: string;
  /** The version of the tenant's document for the category, as read; null when it was not read. */
  version: string | null;
  entries: PlannedEntry[];
}

interface Validation {
  ok: boolean | null;
  errors?: Array<{ code: string; detail_code?: string }>;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every(
    (key) =>
      Object.hasOwn(b, key) &&
      deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])
  );
}

function entriesOf(change: BulkApplyChange): PlannedEntry[] {
  return [
    ...Object.entries(change.set).map(([key, value]) => ({
      key,
      op: 'set' as const,
      proposed: value,
      current: null,
      decision: 'pending' as const,
    })),
    ...change.clear.map((key) => ({
      key,
      op: 'clear' as const,
      proposed: 'clear',
      current: null,
      decision: 'pending' as const,
    })),
  ];
}

function reject(entry: PlannedEntry, reason: string): void {
  entry.decision = 'reject';
  entry.reason = reason;
}

function currentOf(state: SettingsGetResult, key: string): CurrentView {
  const overridden = state.sources[key] === 'kv';
  return {
    overridden,
    own: overridden ? state.values[key] : null,
    effective: state.values[key],
    source: state.sources[key] ?? 'default',
  };
}

/**
 * Reads what the tenant has for the category and decides, for each key, whether it is refused
 * (the policy, the caller's authority), left alone (the tenant's own value stands, or there is
 * nothing to change) or to be written. Nothing is written.
 */
async function planCategory(
  c: BulkContext,
  tenantId: string,
  change: BulkApplyChange,
  policy: BulkApplyRequest['onExistingOverride'],
  /** The version a preview returned for this tenant and category (an apply holds to it). */
  expectedVersion?: string
): Promise<CategoryPlan> {
  const adminAuth = c.get('adminAuth');
  const plan: CategoryPlan = {
    category: change.category,
    version: null,
    entries: entriesOf(change),
  };

  const categoryVerdict = bulkApplyCategoryVerdict(change.category);
  if (!categoryVerdict.ok) {
    for (const entry of plan.entries) reject(entry, categoryVerdict.reason);
    return plan;
  }
  for (const entry of plan.entries) {
    const verdict = bulkApplyKeyVerdict(change.category, entry.key);
    if (!verdict.ok) reject(entry, verdict.reason);
  }
  const eligible = plan.entries.filter((entry) => entry.decision === 'pending');
  if (eligible.length === 0) return plan;

  // The caller's own authority over this tenant's category, as the PATCH route would judge it.
  if (
    !hasTenantSettingsPermission(adminAuth, change.category as CategoryName, 'edit', tenantId) ||
    !canReachTenant(adminAuth, tenantId)
  ) {
    for (const entry of eligible) reject(entry, 'forbidden');
    return plan;
  }

  let state: SettingsGetResult;
  try {
    // Read only: reading a document that has not been made yet must not make it.
    const manager = getSettingsManager(c.env, c, true, true, undefined, { readOnly: true });
    const scope: SettingScope = { type: 'tenant', id: tenantId };
    state = await manager.getAll(change.category, scope, {
      parents: settingsParentScopes(change.category as CategoryName, scope),
    });
  } catch {
    // Its values in effect are unknown: neither previewed nor written.
    for (const entry of eligible) reject(entry, 'settings_unavailable');
    return plan;
  }
  plan.version = state.version;

  // The preview was of another version of the document, so it is not what is about to be written:
  // decided before anything is left alone, so that a changed value is not reported as skipped.
  const changed = expectedVersion !== undefined && expectedVersion !== state.version;

  for (const entry of eligible) {
    const current = currentOf(state, entry.key);
    entry.current = current;
    if (changed) {
      entry.decision = 'conflict';
      entry.reason = 'version_changed';
      continue;
    }
    if (entry.op === 'set') {
      if (!current.overridden) continue;
      // The tenant holds a value of its own for the key. The same value: nothing to do. Another:
      // the tenant decided it, so it stays unless the request says to overwrite.
      if (deepEqual(current.own, entry.proposed)) {
        entry.decision = 'skip';
        entry.reason = 'already_set';
      } else if (policy === 'skip') {
        entry.decision = 'skip';
        entry.reason = 'existing_override';
      }
    } else if (!current.overridden) {
      entry.decision = 'skip';
      entry.reason = 'not_overridden';
    } else if (policy === 'skip') {
      entry.decision = 'skip';
      entry.reason = 'existing_override';
    }
  }
  return plan;
}

// ---------------------------------------------------------------------------------------------
// Running a plan through the shared save
// ---------------------------------------------------------------------------------------------

interface SavedAnswer {
  status: number;
  json: Record<string, unknown>;
  /** What the validation that refused the save was about, when it said (see `ValidationKind`). */
  refusal?: ValidationRefusal;
}

async function runSharedSave(
  c: BulkContext,
  input: {
    tenantId: string;
    category: string;
    version: string;
    set: Record<string, unknown>;
    clear: string[];
    bulkId: string | null;
    dryRun: boolean;
  }
): Promise<SavedAnswer> {
  let refusal: ValidationRefusal | undefined;
  try {
    const response = await applyTenantSettingsChange({
      c,
      onRefusal: (given) => {
        refusal = given;
      },
      adminAuth: c.get('adminAuth'),
      tenantId: input.tenantId,
      category: input.category as CategoryName,
      readBody: async () => ({
        ifMatch: input.version,
        ...(Object.keys(input.set).length > 0 ? { set: input.set } : {}),
        ...(input.clear.length > 0 ? { clear: input.clear } : {}),
      }),
      canAccess: canReachTenant,
      // The request arrived on another tenant's database: route by this tenant instead.
      tenantCoreDb: null,
      ...(input.bulkId
        ? {
            // The records of the change name the keys and what was done, never the values.
            auditMetadata: {
              bulk_id: input.bulkId,
              bulk_operations: {
                ...Object.fromEntries(Object.keys(input.set).map((key) => [key, 'set'])),
                ...Object.fromEntries(input.clear.map((key) => [key, 'clear'])),
              },
            },
            auditOmitValues: true,
            identityMappingHistory: { via: 'bulk_apply', bulkId: input.bulkId },
          }
        : {}),
      dryRun: input.dryRun,
    });
    let json: Record<string, unknown> = {};
    try {
      const parsed: unknown = await response.json();
      if (typeof parsed === 'object' && parsed !== null) json = parsed as Record<string, unknown>;
    } catch {
      // A body that is not JSON carries nothing to read.
    }
    return { status: response.status, json, refusal };
  } catch {
    // Only the class is logged: the error may hold anything of the tenant.
    log.error('A bulk apply save failed unexpectedly', { category: input.category });
    return { status: 500, json: {} };
  }
}

/**
 * The fixed code of a rejection the settings manager gives for a key, from the kind of reason it
 * gives. The reasons are the manager's own sentences, which are not given on: only the code is, and
 * a reason this does not know gives none.
 */
export function managerRejectionCode(reason: string): string | undefined {
  if (/^Unknown setting key/.test(reason) || /^Not settable at/.test(reason)) return 'unknown_key';
  if (/^Depends on/.test(reason)) return 'dependency_not_met';
  if (/^Expected (number|boolean|string|valid JSON|JSON-serializable)/.test(reason)) {
    return 'value_wrong_type';
  }
  if (/^Value must be (>=|<=|a multiple of|a safe integer)/.test(reason))
    return 'value_out_of_range';
  if (/^Value must be one of|^Conflicting operations|^Only boolean settings/.test(reason)) {
    return 'value_invalid';
  }
  return undefined;
}

const DETAIL_CODE = /^[a-z0-9_]{1,48}$/;

/**
 * What a refused save says of why, in a form that is safe to give: a fixed code, never the text of
 * the refusal. The text of a validation can name an ID, a link or the value of another setting the
 * tenant has saved, or repeat a piece of what was sent. A refusal that gave no code gives none.
 */
function refusalDetail(answer: SavedAnswer): { detail_code?: string } {
  const refusal = answer.refusal;
  const code = refusal?.code;
  return code && DETAIL_CODE.test(code) ? { detail_code: code } : {};
}

/** The code for the reason the manager gave one key. */
export function rejectionDetail(reason: unknown): { detail_code?: string } {
  const code = typeof reason === 'string' ? managerRejectionCode(reason) : undefined;
  return code ? { detail_code: code } : {};
}

function pendingBody(plan: CategoryPlan): { set: Record<string, unknown>; clear: string[] } {
  const set: Record<string, unknown> = {};
  const clear: string[] = [];
  for (const entry of plan.entries) {
    if (entry.decision !== 'pending') continue;
    if (entry.op === 'set') set[entry.key] = entry.proposed;
    else clear.push(entry.key);
  }
  return { set, clear };
}

/** The code of a failed save, from a fixed set: nothing of the tenant or the database. */
function failureCode(answer: SavedAnswer): string {
  if (answer.json.error === 'backup_mutation_unavailable') return 'backup_mutation_unavailable';
  return answer.status === 503 ? 'temporarily_unavailable' : 'internal_error';
}

// ---------------------------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------------------------

type PreviewAction = 'would_apply' | 'would_clear' | 'would_skip' | 'would_reject';

interface PreviewChange {
  category: string;
  key: string;
  current: CurrentView | null;
  proposed: unknown;
  action: PreviewAction;
  reason?: string;
  validation: Validation;
  version: string | null;
  warnings?: string[];
}

/** What the save would answer for each pending key, from a dry run. */
async function validatePending(
  c: BulkContext,
  tenantId: string,
  plan: CategoryPlan
): Promise<Map<string, Validation>> {
  const results = new Map<string, Validation>();
  const pending = plan.entries.filter((entry) => entry.decision === 'pending');
  if (pending.length === 0 || plan.version === null) return results;
  const { set, clear } = pendingBody(plan);
  const answer = await runSharedSave(c, {
    tenantId,
    category: plan.category,
    version: plan.version,
    set,
    clear,
    bulkId: null,
    dryRun: true,
  });

  const rejected =
    typeof answer.json.rejected === 'object' && answer.json.rejected !== null
      ? (answer.json.rejected as Record<string, unknown>)
      : null;
  if (answer.status === 200 || (answer.status === 400 && rejected)) {
    for (const entry of pending) {
      const why = rejected && Object.hasOwn(rejected, entry.key) ? rejected[entry.key] : undefined;
      results.set(
        entry.key,
        why === undefined
          ? { ok: true }
          : {
              ok: false,
              errors: [{ code: 'validation_failed', ...rejectionDetail(why) }],
            }
      );
    }
    return results;
  }
  // 400, and 404 (the post-login checks find no client): a refusal of the value given.
  const refusal = answer.status === 400 || answer.status === 404;
  const detail = refusal ? refusalDetail(answer) : {};
  const code = refusal
    ? 'validation_failed'
    : answer.status === 403
      ? 'forbidden'
      : answer.status === 409
        ? 'version_changed'
        : failureCode(answer);
  for (const entry of pending) {
    results.set(entry.key, { ok: false, errors: [{ code, ...detail }] });
  }
  return results;
}

async function previewTenant(
  c: BulkContext,
  request: BulkApplyRequest,
  tenantId: string,
  requestCache: TenantDatabaseRequestCache
) {
  const changes: PreviewChange[] = [];
  const impact: Record<string, unknown> = {};
  for (const change of request.changes) {
    const plan = await planCategory(c, tenantId, change, request.onExistingOverride);
    const validations = await validatePending(c, tenantId, plan);
    let writes = false;
    for (const entry of plan.entries) {
      const validation = validations.get(entry.key);
      let action: PreviewAction;
      let reason = entry.reason;
      if (entry.decision === 'skip') action = 'would_skip';
      else if (entry.decision === 'reject') action = 'would_reject';
      else if (validation && validation.ok === false) {
        action = 'would_reject';
        reason = validation.errors?.[0]?.code;
      } else {
        action = entry.op === 'clear' ? 'would_clear' : 'would_apply';
        writes = true;
      }
      changes.push({
        category: plan.category,
        key: entry.key,
        current: entry.current && {
          ...entry.current,
          own: summarizeValue(entry.current.own),
          effective: summarizeValue(entry.current.effective),
        },
        proposed: summarizeValue(entry.proposed),
        action,
        ...(reason ? { reason } : {}),
        validation: validation ?? { ok: null },
        version: plan.version,
      });
    }
    const provider = Object.hasOwn(bulkApplyImpactProviders, plan.category)
      ? bulkApplyImpactProviders[plan.category]
      : undefined;
    if (writes && provider) {
      const keys = plan.entries.filter((entry) => entry.decision === 'pending').map((e) => e.key);
      try {
        impact[plan.category] = await provider({
          c,
          tenantId,
          category: plan.category,
          keys,
          requestCache,
        });
      } catch {
        impact[plan.category] = { available: false, reason: 'impact_failed' };
      }
    }
  }
  const status = changes.some(
    (entry) => entry.action === 'would_apply' || entry.action === 'would_clear'
  )
    ? 'ready'
    : 'nothing_to_do';
  return { tenant_id: tenantId, status, changes, impact };
}

// ---------------------------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------------------------

type ChangeStatus = 'applied' | 'cleared' | 'skipped' | 'rejected' | 'conflict' | 'failed';

interface AppliedChange {
  category: string;
  key: string;
  status: ChangeStatus;
  reason?: string;
  /** A fixed code of the refusal, when the validation gave one (for example for a Mapping Set). */
  detail_code?: string;
  /** The tenant's own value before (null: it had none, and inherited). */
  previous: unknown;
  /** The value now (or `"clear"`: back to inheriting); what was asked for when nothing changed. */
  new: unknown;
  version_before: string | null;
  /** Set only when the key was written. */
  version_after: string | null;
  warnings?: string[];
}

async function applyCategory(
  c: BulkContext,
  request: BulkApplyRequest,
  tenantId: string,
  change: BulkApplyChange,
  bulkId: string
): Promise<AppliedChange[]> {
  const plan = await planCategory(
    c,
    tenantId,
    change,
    request.onExistingOverride,
    request.expected[tenantId]?.[change.category]
  );
  const base = (entry: PlannedEntry) => ({
    category: plan.category,
    key: entry.key,
    previous: summarizeValue(entry.current?.overridden ? entry.current.own : null),
    new: summarizeValue(entry.proposed),
    version_before: plan.version,
    version_after: null,
  });
  const settle = (entry: PlannedEntry, status: ChangeStatus, extra: Partial<AppliedChange> = {}) =>
    ({ ...base(entry), status, ...extra }) satisfies AppliedChange;

  const results = new Map<string, AppliedChange>();
  for (const entry of plan.entries) {
    if (entry.decision === 'skip') {
      results.set(entry.key, settle(entry, 'skipped', { reason: entry.reason }));
    } else if (entry.decision === 'conflict') {
      results.set(entry.key, settle(entry, 'conflict', { reason: 'version_changed' }));
    } else if (entry.decision === 'reject') {
      const failed = entry.reason === 'settings_unavailable';
      results.set(
        entry.key,
        settle(entry, failed ? 'failed' : 'rejected', {
          reason: entry.reason,
        })
      );
    }
  }

  const pending = plan.entries.filter((entry) => entry.decision === 'pending');
  if (pending.length > 0 && plan.version !== null) {
    const { set, clear } = pendingBody(plan);
    const answer = await runSharedSave(c, {
      tenantId,
      category: plan.category,
      version: plan.version,
      set,
      clear,
      bulkId,
      dryRun: false,
    });
    const rejected =
      typeof answer.json.rejected === 'object' && answer.json.rejected !== null
        ? (answer.json.rejected as Record<string, unknown>)
        : {};
    const applied = new Set(Array.isArray(answer.json.applied) ? answer.json.applied : []);
    const cleared = new Set(Array.isArray(answer.json.cleared) ? answer.json.cleared : []);
    const answered = answer.status === 200 || (answer.status === 400 && 'rejected' in answer.json);
    const versionAfter = typeof answer.json.version === 'string' ? answer.json.version : null;
    const warnings =
      answer.json.externalPluginGate === 'pending' ? ['external_plugin_gate_pending'] : [];
    for (const entry of pending) {
      if (answered) {
        if (applied.has(entry.key)) {
          results.set(
            entry.key,
            settle(entry, 'applied', {
              version_after: versionAfter,
              ...(warnings.length > 0 ? { warnings } : {}),
            })
          );
        } else if (cleared.has(entry.key)) {
          results.set(
            entry.key,
            settle(entry, 'cleared', {
              version_after: versionAfter,
              ...(warnings.length > 0 ? { warnings } : {}),
            })
          );
        } else {
          const why = Object.hasOwn(rejected, entry.key) ? rejected[entry.key] : undefined;
          results.set(
            entry.key,
            settle(entry, 'rejected', {
              reason: 'validation_failed',
              ...rejectionDetail(why),
            })
          );
        }
      } else if (answer.status === 400 || answer.status === 404) {
        results.set(
          entry.key,
          settle(entry, 'rejected', {
            reason: 'validation_failed',
            ...refusalDetail(answer),
          })
        );
      } else if (answer.status === 403) {
        results.set(entry.key, settle(entry, 'rejected', { reason: 'forbidden' }));
      } else if (answer.status === 409) {
        results.set(entry.key, settle(entry, 'conflict', { reason: 'version_changed' }));
      } else {
        results.set(entry.key, settle(entry, 'failed', { reason: failureCode(answer) }));
      }
    }
  }
  return plan.entries.map((entry) => results.get(entry.key)!);
}

/** One tenant's status from its changes: the worst outcome leads. */
function tenantStatus(changes: AppliedChange[]): ChangeStatus {
  for (const status of ['failed', 'conflict', 'rejected', 'applied', 'cleared'] as const) {
    if (changes.some((change) => change.status === status)) return status;
  }
  return 'skipped';
}

async function applyTenant(
  c: BulkContext,
  request: BulkApplyRequest,
  tenantId: string,
  bulkId: string
) {
  const changes: AppliedChange[] = [];
  for (const change of request.changes) {
    try {
      changes.push(...(await applyCategory(c, request, tenantId, change, bulkId)));
    } catch {
      // The class of the failure only; the entries of the category are reported as failed.
      log.error('A bulk apply category failed unexpectedly', { category: change.category });
      for (const key of [...Object.keys(change.set), ...change.clear]) {
        changes.push({
          category: change.category,
          key,
          status: 'failed',
          reason: 'internal_error',
          previous: null,
          new: summarizeValue(Object.hasOwn(change.set, key) ? change.set[key] : 'clear'),
          version_before: null,
          version_after: null,
        });
      }
    }
  }
  return { tenant_id: tenantId, status: tenantStatus(changes), changes };
}

// ---------------------------------------------------------------------------------------------
// The handler
// ---------------------------------------------------------------------------------------------

type TenantDirectory = Map<string, { lifecycleState: string }>;

async function readTenantDirectory(c: BulkContext, ids: string[]): Promise<TenantDirectory> {
  const adapter = ensureDatabaseAdapter(c.env.DB, 'settings-bulk-apply');
  if (!adapter) throw new Error('tenant_directory_unavailable');
  const rows = await adapter.query<{ id: string; lifecycle_state: string }>(
    `SELECT id, lifecycle_state FROM tenants WHERE id IN (${ids.map(() => '?').join(', ')})`,
    ids
  );
  return new Map(rows.map((row) => [row.id, { lifecycleState: row.lifecycle_state }]));
}

/** Why a tenant cannot be worked on at all, or null. */
function tenantProblem(
  env: Env,
  directory: TenantDirectory,
  tenantId: string
): 'tenant_not_found' | 'tenant_deleted' | null {
  if (isSingleTenantMode(env) && tenantId !== getSingleTenantId(env)) return 'tenant_not_found';
  const row = directory.get(tenantId);
  if (!row) return 'tenant_not_found';
  if (row.lifecycleState === 'deleted') return 'tenant_deleted';
  return null;
}

function countBy<T>(items: readonly T[], pick: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const key = pick(item);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

export async function bulkApplyHandler(c: BulkContext): Promise<Response> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json(
      { error: 'invalid_request', code: 'invalid_json', error_description: 'Invalid JSON body' },
      400
    );
  }
  const limits = await resolveBulkApplyLimits(c.env);
  const parsed = parseBulkApplyRequest(raw, limits);
  if ('problem' in parsed) {
    const { status, error, code, description, limit } = parsed.problem;
    return c.json(
      { error, code, error_description: description, ...(limit === undefined ? {} : { limit }) },
      status
    );
  }
  const { request } = parsed;

  let directory: TenantDirectory;
  try {
    directory = await readTenantDirectory(c, request.tenantIds);
  } catch {
    return c.json(
      {
        error: 'temporarily_unavailable',
        message: 'The tenants cannot be looked up right now; nothing was changed. Try again',
      },
      503
    );
  }

  const apply = request.mode === 'apply';
  const bulkId = crypto.randomUUID();
  if (apply) {
    // From here tenants may be changed: the replay record is held whatever happens next.
    (c as unknown as { set(name: string, value: unknown): void }).set(BULK_APPLY_STARTED, true);
  }
  const requestCache: TenantDatabaseRequestCache = new Map();

  const results = await mapWithConcurrency(request.tenantIds, TENANT_CONCURRENCY, async (id) => {
    const problem = tenantProblem(c.env, directory, id);
    if (problem) {
      return apply
        ? { tenant_id: id, status: 'rejected', reason: problem, changes: [] }
        : { tenant_id: id, status: 'rejected', reason: problem, changes: [], impact: {} };
    }
    try {
      return apply
        ? await applyTenant(c, request, id, bulkId)
        : await previewTenant(c, request, id, requestCache);
    } catch {
      log.error('A bulk apply tenant failed unexpectedly');
      return { tenant_id: id, status: 'failed', error: { code: 'internal_error' }, changes: [] };
    }
  });

  const changeStatuses = results.flatMap((result) =>
    (result.changes as Array<{ status?: string; action?: string }>).map(
      (change) => change.status ?? change.action ?? 'unknown'
    )
  );
  const tenantStatuses = countBy(results, (result) => result.status);

  if (apply) {
    // One record for the whole request: how many, with what result, which categories and keys.
    // Never a value: a setting can be sensitive. The per-tenant records carry the bulk ID.
    try {
      await createAuditLogFromContext(
        c as unknown as Parameters<typeof createAuditLogFromContext>[0],
        'settings.bulk_apply',
        'settings',
        bulkId,
        {
          bulk_id: bulkId,
          mode: request.mode,
          on_existing_override: request.onExistingOverride,
          tenant_count: request.tenantIds.length,
          tenant_results: tenantStatuses,
          change_results: countBy(changeStatuses, (status) => status),
          categories: request.changes.map((change) => change.category),
          keys: request.changes.flatMap((change) => [...Object.keys(change.set), ...change.clear]),
        }
      );
    } catch {
      log.warn('Failed to record the bulk apply audit', { bulkId });
    }
  }

  return c.json({
    ...(apply ? { bulk_id: bulkId } : {}),
    mode: request.mode,
    on_existing_override: request.onExistingOverride,
    limits: { max_tenants_per_request: limits.maxTenants, max_keys_per_request: limits.maxKeys },
    summary: { tenants: request.tenantIds.length, by_status: tenantStatuses },
    results,
  });
}
