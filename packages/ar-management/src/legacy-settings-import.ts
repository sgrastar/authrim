/**
 * Applies the one-time import of the older settings stores into the Settings API (see
 * `planPlatformImport` / `planTenantProfileImport` in ar-lib-core).
 *
 * - A value already set through the Settings API at that scope is kept; only unset keys are
 *   written.
 * - Values go through the same manager as a PATCH, saved compare-and-set on the canonical store
 *   (so a concurrent save conflicts rather than being lost), with the checks the PATCH routes
 *   make. Dependencies are not checked: in the older stores the values applied whatever the
 *   dependency was.
 * - It runs in bounded steps: the platform's values first, then the tenants with a
 *   certification profile, a page at a time, the position kept in its state
 *   (DB_ADMIN `settings_legacy_import_state`, changed compare-and-set on its revision). A step that fails (a store or document that cannot be read, a
 *   save that conflicts) keeps the position of the last page it finished; every step can be
 *   repeated.
 * - It completes only when every value was saved. A value refused (by a check, or as not
 *   settable at its scope) leaves it `needs_attention`, reported, until an admin runs it again
 *   (after correcting the value) or accepts the refusals.
 * - The older stores are left in place.
 *
 * The scheduler runs a step each minute until it completes or needs attention; platform admins
 * can preview it, run a step, or accept the refusals through
 * `/api/admin/platform/settings/legacy-import`.
 */

import {
  ALL_CATEGORY_META,
  createAuditLog,
  createLogger,
  createSettingsManager,
  DEFAULT_TENANT_ID,
  isCategoryAvailableAtScope,
  isStoredLegacyValue,
  listCertificationProfileTenants,
  LEGACY_IMPORT_CONTRACT,
  planPlatformImport,
  planTenantProfileImport,
  readGlobalSystemSettings,
  requireDedicatedAdminDatabaseAdapter,
  sanitizeObject,
  type CategoryMeta,
  type CategoryName,
  type Env,
  type LegacyImportEnv,
  type LegacyImportScope,
  type LegacyImportWrite,
  type SettingsManager,
} from '@authrim/ar-lib-core';
import { DatabaseSettingsCanonicalStore } from '@authrim/ar-lib-core/services/settings-canonical-store';
import { validateSettingValue } from './routes/settings-v2/patch-validation';

const log = createLogger().module('LEGACY_SETTINGS_IMPORT');

/** Tenant settings keys listed per page (of which only certification profiles are imported). */
const TENANT_PAGE_SIZE = 50;
/** Bounds of one step, kept well inside a Worker invocation's subrequest limit. */
const STEP_MAX_TENANTS = 25;
const STEP_MAX_PAGES = 20;
/** Tenants and pages a preview covers before reporting itself truncated. */
const PREVIEW_MAX_TENANTS = 25;
const PREVIEW_MAX_PAGES = 20;
/** Refusals kept in the state for review (all are counted). */
const MAX_RECORDED_REJECTIONS = 200;

/** What the import did (or, in a preview, would do) for one Settings API document. */
export interface LegacyImportDocumentResult {
  scope: LegacyImportScope['type'];
  scopeId: string | null;
  category: CategoryName;
  /** The older stores the values come from. */
  sources: string[];
  /** Keys written (in a preview, to be written). */
  applied: string[];
  /** Keys already set through the Settings API at this scope: kept as they are. */
  kept: string[];
  /** Keys not written, with the reason. */
  rejected: Record<string, string>;
}

export interface LegacyImportRejection {
  scope: LegacyImportScope['type'];
  scopeId: string | null;
  category: string;
  key: string;
  reason: string;
}

export interface LegacyImportState {
  status: 'in_progress' | 'needs_attention' | 'completed';
  /** Where the next step starts: the platform's values, or the tenants' profiles. */
  stage: 'platform' | 'tenants';
  /** The page of tenant settings keys the next step starts from (null: the first). */
  cursor: string | null;
  applied: number;
  kept: number;
  rejectedCount: number;
  /** The first refusals, for review. */
  rejected: LegacyImportRejection[];
  /** Set when an admin accepted the refusals as they are. */
  acceptedRejections?: boolean;
  actor: string;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  /** The LEGACY_IMPORT_CONTRACT the run was made under (absent: 1). */
  contract?: number;
}

export interface LegacyImportReport {
  status: 'dry_run' | 'already_completed' | LegacyImportState['status'];
  state: LegacyImportState | null;
  /** What this step (or preview) did per document. */
  documents: LegacyImportDocumentResult[];
  /** A preview that stopped before the last tenant. */
  truncated?: boolean;
}

/** The request does not fit the import's state (such as accepting refusals when there are none). */
export class LegacyImportStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LegacyImportStateError';
  }
}

type ImportDatabase = ReturnType<typeof requireDedicatedAdminDatabaseAdapter>;

function importDatabase(env: Env): ImportDatabase {
  return requireDedicatedAdminDatabaseAdapter(env, 'settings-canonical');
}

/** The import's state with its revision, or null before its first step. */
async function loadState(
  db: ImportDatabase
): Promise<{ state: LegacyImportState; revision: number } | null> {
  const row = await db.queryOne<{ state_json: string; revision: number }>(
    'SELECT state_json,revision FROM settings_legacy_import_state WHERE id=1',
    []
  );
  return row
    ? { state: JSON.parse(row.state_json) as LegacyImportState, revision: row.revision }
    : null;
}

/**
 * Save the state over the revision it was read at (null: there was none), returning the new
 * revision. Throws `LegacyImportStateError` when it changed meanwhile (another step, an admin's
 * restart or acceptance), so a step working from an older state stops instead of undoing it.
 */
async function saveState(
  db: ImportDatabase,
  state: LegacyImportState,
  revision: number | null
): Promise<number> {
  state.updatedAt = new Date().toISOString();
  const json = JSON.stringify(state);
  const now = Date.now();
  const result =
    revision === null
      ? await db.execute(
          `INSERT INTO settings_legacy_import_state (id,state_json,revision,updated_at)
          VALUES (1,?,1,?) ON CONFLICT(id) DO NOTHING`,
          [json, now]
        )
      : await db.execute(
          `UPDATE settings_legacy_import_state SET state_json=?,revision=revision+1,updated_at=?
          WHERE id=1 AND revision=?`,
          [json, now, revision]
        );
  if (!result.success || result.rowsAffected !== 1) {
    throw new LegacyImportStateError('The import was changed meanwhile; reload its state');
  }
  return revision === null ? 1 : revision + 1;
}

/** The import's state, or null before its first step. Throws when unreadable. */
export async function readLegacyImportState(env: Env): Promise<LegacyImportState | null> {
  return (await loadState(importDatabase(env)))?.state ?? null;
}

function freshState(actor: string): LegacyImportState {
  const now = new Date().toISOString();
  return {
    status: 'in_progress',
    stage: 'platform',
    cursor: null,
    applied: 0,
    kept: 0,
    rejectedCount: 0,
    rejected: [],
    actor,
    startedAt: now,
    updatedAt: now,
    contract: LEGACY_IMPORT_CONTRACT,
  };
}

/** A completed run made under an earlier contract: what was added since is still to import. */
function isOutdated(state: LegacyImportState): boolean {
  return state.status === 'completed' && (state.contract ?? 1) < LEGACY_IMPORT_CONTRACT;
}

/**
 * The manager for the import: saves compare and set on the canonical store (D1) at every scope.
 * A preview reads only: nothing is created, not even a canonical document.
 */
function managerFor(env: Env, actor: string, dryRun: boolean): SettingsManager {
  const manager = createSettingsManager({
    env: env as unknown as Record<string, string | undefined>,
    kv: env.SETTINGS ?? null,
    // A document that cannot be read must stop the import, not read as empty.
    strictReads: true,
    legacyKv: env.AUTHRIM_CONFIG ?? null,
    canonicalStore: new DatabaseSettingsCanonicalStore(
      requireDedicatedAdminDatabaseAdapter(env, 'settings-canonical')
    ),
    readOnly: dryRun,
    cacheTTL: 0,
    auditCallback: async (event) => {
      try {
        await createAuditLog(env, {
          tenantId: event.scope === 'tenant' ? event.scopeId : DEFAULT_TENANT_ID,
          userId: actor,
          action: 'settings.legacy_import',
          resource: 'settings',
          resourceId: `${event.scope}:${event.scopeId}:${event.category}`,
          ipAddress: '',
          userAgent: '',
          metadata: JSON.stringify({
            scope: event.scope,
            scope_id: event.scopeId,
            category: event.category,
            diff: sanitizeObject(event.diff),
          }),
          severity: 'info',
        });
      } catch {
        log.warn('Failed to record the settings import audit', {
          category: event.category,
          scope: event.scope,
        });
      }
    },
  });
  for (const meta of Object.values(ALL_CATEGORY_META)) {
    manager.registerCategory(meta as CategoryMeta);
  }
  return manager;
}

/** Planned values grouped by Settings API document, keeping the first store's value. */
function groupByDocument(writes: LegacyImportWrite[]) {
  const documents = new Map<
    string,
    {
      scope: LegacyImportScope;
      category: CategoryName;
      sources: string[];
      values: Record<string, unknown>;
    }
  >();
  for (const write of writes) {
    const id = `${write.scope.type}:${write.scope.type === 'tenant' ? write.scope.id : ''}:${write.category}`;
    let document = documents.get(id);
    if (!document) {
      document = { scope: write.scope, category: write.category, sources: [], values: {} };
      documents.set(id, document);
    }
    document.sources.push(write.source);
    for (const [key, value] of Object.entries(write.values)) {
      if (!(key in document.values)) document.values[key] = value;
    }
  }
  return [...documents.values()];
}

/** Write (or, in a preview, check) the planned values of each document. */
async function applyWrites(
  env: Env,
  manager: SettingsManager,
  writes: LegacyImportWrite[],
  actor: string,
  dryRun: boolean
): Promise<LegacyImportDocumentResult[]> {
  const results: LegacyImportDocumentResult[] = [];
  for (const document of groupByDocument(writes)) {
    const { scope, category } = document;
    const meta = ALL_CATEGORY_META[category] as CategoryMeta;
    const current = await manager.getAll(category, scope);
    const result: LegacyImportDocumentResult = {
      scope: scope.type,
      scopeId: scope.type === 'tenant' ? scope.id : null,
      category,
      sources: document.sources,
      applied: [],
      kept: [],
      rejected: {},
    };
    const set: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(document.values)) {
      const settingMeta = meta.settings[key];
      if (!settingMeta) {
        result.rejected[key] = 'Unknown setting key';
      } else if (
        !isCategoryAvailableAtScope(category, scope.type) ||
        (settingMeta.scopes && !settingMeta.scopes.includes(scope.type))
      ) {
        result.rejected[key] = `Not settable at ${scope.type} scope`;
      } else if (current.sources[key] === 'kv') {
        result.kept.push(key);
      } else if (isStoredLegacyValue(value)) {
        // Saved as is, it would read differently from what runtime does with the older value.
        result.rejected[key] =
          'The older value cannot be saved as this setting without changing what it does';
      } else {
        const problem = validateSettingValue(category, scope.type, key, value, env);
        if (problem) result.rejected[key] = problem;
        else set[key] = value;
      }
    }

    if (dryRun) {
      for (const [key, value] of Object.entries(set)) {
        const validation = manager.validate(category, { [key]: value });
        if (validation.valid) result.applied.push(key);
        else result.rejected[key] = validation.errors[0]?.reason ?? 'Validation failed';
      }
    } else if (Object.keys(set).length > 0) {
      // A conflicting save throws: the step stops, and the next one repeats this page.
      const saved = await manager.patch(category, scope, { ifMatch: current.version, set }, actor, {
        skipDependencyCheck: true,
      });
      result.applied = saved.applied;
      Object.assign(result.rejected, saved.rejected);
    }
    results.push(result);
  }
  return results;
}

function record(state: LegacyImportState, results: LegacyImportDocumentResult[]): void {
  for (const result of results) {
    state.applied += result.applied.length;
    state.kept += result.kept.length;
    for (const [key, reason] of Object.entries(result.rejected)) {
      state.rejectedCount += 1;
      if (state.rejected.length < MAX_RECORDED_REJECTIONS) {
        state.rejected.push({
          scope: result.scope,
          scopeId: result.scopeId,
          category: result.category,
          key,
          reason,
        });
      }
    }
  }
}

/** What the import would write now, without writing anything (bounded to the first tenants). */
async function preview(env: Env, actor: string): Promise<LegacyImportReport> {
  const importEnv = env as unknown as LegacyImportEnv;
  const manager = managerFor(env, actor, true);
  const documents = await applyWrites(
    env,
    manager,
    await planPlatformImport(importEnv),
    actor,
    true
  );
  let truncated = false;
  if (env.SETTINGS) {
    const global = await readGlobalSystemSettings(importEnv);
    let cursor: string | null = null;
    let tenants = 0;
    for (let pages = 0; ; pages += 1) {
      if (pages >= PREVIEW_MAX_PAGES || tenants >= PREVIEW_MAX_TENANTS) {
        truncated = true;
        break;
      }
      // As a step: no more keys than the tenants the preview may still take.
      const page = await listCertificationProfileTenants(
        env.SETTINGS,
        cursor,
        Math.min(TENANT_PAGE_SIZE, PREVIEW_MAX_TENANTS - tenants)
      );
      for (const tenantId of page.tenants) {
        tenants += 1;
        const writes = await planTenantProfileImport(importEnv, tenantId, global);
        documents.push(...(await applyWrites(env, manager, writes, actor, true)));
      }
      cursor = page.cursor;
      if (!cursor) break;
    }
  }
  return {
    status: 'dry_run',
    state: await readLegacyImportState(env),
    documents,
    ...(truncated ? { truncated } : {}),
  };
}

/**
 * Run one step of the import. The scheduler leaves an import that needs attention alone; an
 * admin's run starts it over from the beginning (values saved since are kept).
 */
async function step(
  env: Env,
  actor: string,
  trigger: 'scheduler' | 'admin'
): Promise<LegacyImportReport> {
  const db = importDatabase(env);
  const stored = await loadState(db);
  let revision = stored?.revision ?? null;
  if (stored?.state.status === 'completed' && !isOutdated(stored.state)) {
    return { status: 'already_completed', state: stored.state, documents: [] };
  }
  if (stored?.state.status === 'needs_attention' && trigger === 'scheduler') {
    return { status: 'needs_attention', state: stored.state, documents: [] };
  }
  let state = stored?.state ?? null;
  if (!state || state.status === 'needs_attention' || isOutdated(state)) {
    state = freshState(actor);
    revision = await saveState(db, state, revision);
  }
  const current = state;
  const save = async () => {
    revision = await saveState(db, current, revision);
  };

  const importEnv = env as unknown as LegacyImportEnv;
  const manager = managerFor(env, actor, false);
  const documents: LegacyImportDocumentResult[] = [];

  if (state.stage === 'platform') {
    const results = await applyWrites(
      env,
      manager,
      await planPlatformImport(importEnv),
      actor,
      false
    );
    documents.push(...results);
    record(state, results);
    state.stage = 'tenants';
    state.cursor = null;
    await save();
  }

  if (env.SETTINGS) {
    const global = await readGlobalSystemSettings(importEnv);
    let tenants = 0;
    for (let pages = 0; pages < STEP_MAX_PAGES && tenants < STEP_MAX_TENANTS; pages += 1) {
      // No more keys than the tenants this step may still take, so a page never exceeds it.
      const page = await listCertificationProfileTenants(
        env.SETTINGS,
        state.cursor,
        Math.min(TENANT_PAGE_SIZE, STEP_MAX_TENANTS - tenants)
      );
      for (const tenantId of page.tenants) {
        const writes = await planTenantProfileImport(importEnv, tenantId, global);
        const results = await applyWrites(env, manager, writes, actor, false);
        documents.push(...results);
        record(state, results);
        tenants += 1;
      }
      state.cursor = page.cursor;
      if (!page.cursor) break;
      await save();
    }
    if (state.cursor) {
      await save();
      return { status: 'in_progress', state, documents };
    }
  }

  state.status = state.rejectedCount > 0 ? 'needs_attention' : 'completed';
  if (state.status === 'completed') state.completedAt = new Date().toISOString();
  await save();
  return { status: state.status, state, documents };
}

/** Mark an import that needs attention complete, accepting its refusals as they are. */
async function acceptRejections(env: Env, actor: string): Promise<LegacyImportReport> {
  const db = importDatabase(env);
  const stored = await loadState(db);
  if (stored?.state.status !== 'needs_attention') {
    throw new LegacyImportStateError('The import has no refused values to accept');
  }
  const { state, revision } = stored;
  // Recorded before the state changes: when the record cannot be written, nothing is accepted.
  // (A conflicting change after it leaves a record of the request, and nothing accepted.)
  await createAuditLog(env, {
    tenantId: DEFAULT_TENANT_ID,
    userId: actor,
    action: 'settings.legacy_import.rejections_accepted',
    resource: 'settings',
    resourceId: `legacy-import:${revision}`,
    ipAddress: '',
    userAgent: '',
    metadata: JSON.stringify({
      revision,
      started_at: state.startedAt,
      rejected_count: state.rejectedCount,
      rejected: sanitizeObject({ items: state.rejected }).items,
    }),
    severity: 'warning',
  });
  state.status = 'completed';
  state.acceptedRejections = true;
  state.actor = actor;
  state.completedAt = new Date().toISOString();
  await saveState(db, state, revision);
  return { status: 'completed', state, documents: [] };
}

export async function runLegacySettingsImport(
  env: Env,
  options: {
    mode: 'dry_run' | 'run' | 'accept_rejections';
    actor: string;
    trigger?: 'scheduler' | 'admin';
  }
): Promise<LegacyImportReport> {
  if (options.mode === 'dry_run') return preview(env, options.actor);
  if (options.mode === 'accept_rejections') return acceptRejections(env, options.actor);
  return step(env, options.actor, options.trigger ?? 'admin');
}

/** The scheduler's step: one step a minute until the import completes or needs attention. */
export async function processLegacySettingsImport(env: Env): Promise<void> {
  if (!env.SETTINGS || !env.DB_ADMIN) return;
  const state = await readLegacyImportState(env);
  if (state && state.status !== 'in_progress' && !isOutdated(state)) return;
  const report = await runLegacySettingsImport(env, {
    mode: 'run',
    actor: 'system:legacy-settings-import',
    trigger: 'scheduler',
  });
  if (report.status === 'needs_attention') {
    log.warn('Some older settings were not imported; the import needs attention', {
      rejected: report.state?.rejectedCount,
    });
  } else if (report.status === 'completed') {
    log.info('Older settings imported into the Settings API', {
      applied: report.state?.applied,
      kept: report.state?.kept,
    });
  }
}
