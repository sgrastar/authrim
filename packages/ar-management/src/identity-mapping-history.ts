import type { Context } from 'hono';
import { createLogReadAdapter, logCoverageHeaders } from './log-read-adapter';
import { logQueryErrorResponse } from './log-archive-query';
import {
  ADMIN_PERMISSIONS,
  arrayBufferToBase64Url,
  createAuthContextFromHono,
  decodeBase64Url,
  ensureAdminDatabaseAdapter,
  getTenantIdFromContext,
  hasAdminPermission,
  IDENTITY_MAPPING_NONE,
  IdentityMappingResolutionError,
  loadMappingBindingBySetId,
  oidcDefaultSetValueProblem,
  readClientIdentityMappingChoice,
  validateOidcMappingSetReference,
  type AdminAuthContext,
  type DatabaseAdapter,
  type Env,
  type QueryOptions,
  type RuntimeIdentityMappingBinding,
} from '@authrim/ar-lib-core';
import {
  normalizeIdentityMappingLevelHistoryChoice,
  readIdentityMappingLevelHistory,
  type IdentityMappingLevelHistoryChoice,
  type IdentityMappingLevelHistoryRow,
} from '@authrim/ar-lib-core/services/identity-mapping-level-history';
import {
  adminClientUpdateWithHistoryContext,
  validateOptionalIdentityMappingSelectorField,
} from './admin-clients';
import { effectiveMappingView } from './identity-mapping-effective';
import { IdentityMappingControlPlaneRepository } from './identity-mapping-control-plane';
import { contentFromStoredVersion } from './identity-mapping-set-facade-content';
import {
  claimShapes,
  contentProfile,
  diffClaimShapes,
  diffValidationRules,
  readCatalogTypes,
} from './identity-mapping-content-diff';
import {
  APPS_LIMIT,
  changesFor,
  profileFieldChanges,
  readProfileFields,
} from './identity-mapping-set-change-preview';
import { getSettingsManager } from './routes/settings-v2/settings-support';
import {
  canAccessTenant,
  hasTenantSettingsPermission,
} from './routes/settings-v2/settings-authorization';
import {
  applyTenantSettingsChange,
  type TenantSettingsContext,
} from './routes/settings-v2/tenant-settings-apply';
import { mapWithConcurrency } from './map-with-concurrency';

type HistoryContext = Context<{ Bindings: Env }>;
const KEY = 'identity_mapping.oidc_default_set_id';
const LATER_LIMIT = 100;
const PREVIEW_SELECTION_LIMIT = 20;
const HISTORY_REFERENCE_LIMIT = 20;
const ID = /^[a-zA-Z0-9_-]{8,128}$/;
type Reason = 'set_deleted' | 'set_inactive' | 'is_current' | 'client_deleted' | 'invalid_history';
type BeforeUnavailable = 'set_missing' | 'set_inactive' | 'destination_profile_invalid';

function invalid(c: HistoryContext, description: string) {
  return c.json({ error: 'invalid_request', error_description: description }, 400);
}
function conflict(c: HistoryContext, reason: Reason | 'version_conflict') {
  return c.json({ error: 'conflict', reason }, 409);
}
function unavailable(c: HistoryContext) {
  return c.json(
    {
      error: 'temporarily_unavailable',
      error_description: 'The change history cannot be confirmed',
    },
    503
  );
}
function auth(c: HistoryContext): AdminAuthContext | undefined {
  return c.get('adminAuth' as never) as AdminAuthContext | undefined;
}
function raw(entry: IdentityMappingLevelHistoryRow, field: 'before' | 'after') {
  return normalizeIdentityMappingLevelHistoryChoice(
    entry.tier,
    JSON.parse(entry[`${field}_json`]) as unknown
  );
}
function choice(
  tier: IdentityMappingLevelHistoryRow['tier'],
  value: IdentityMappingLevelHistoryChoice
) {
  if (tier === 'client') {
    const parsed = readClientIdentityMappingChoice(value);
    if (parsed.kind === 'invalid') return { state: 'invalid' as const };
    if (parsed.kind === 'unset') return { state: 'unset' as const };
    if (parsed.kind === 'none') return { state: 'none' as const };
    return { state: 'set' as const, setId: parsed.setId, selector: parsed.selector };
  }
  if (value === null) return { state: 'unset' as const };
  if (oidcDefaultSetValueProblem(value, 'tenant')) return { state: 'invalid' as const };
  if (value === IDENTITY_MAPPING_NONE || (typeof value === 'object' && value.mode === 'none')) {
    return { state: 'none' as const };
  }
  return {
    state: 'set' as const,
    setId: typeof value === 'string' ? value : '',
  };
}

function restorationValue(
  entry: IdentityMappingLevelHistoryRow
): IdentityMappingLevelHistoryChoice {
  const value = raw(entry, 'before');
  if (entry.tier === 'tenant_default') return value;
  const parsed = choice('client', value);
  if (parsed.state === 'invalid') throw new Error('invalid_history');
  if (parsed.state === 'unset') return null;
  const checked = validateOptionalIdentityMappingSelectorField(value, 'identity_mapping');
  if (!checked.ok) throw new Error('invalid_history');
  return (checked.value ?? null) as Record<string, unknown> | null;
}

async function current(c: HistoryContext, entry: IdentityMappingLevelHistoryRow) {
  const tenantId = getTenantIdFromContext(c);
  if (entry.tier === 'client') {
    const row = await createAuthContextFromHono(c, tenantId).coreAdapter.queryOne<{
      identity_mapping: string | null;
      updated_at: number;
    }>(
      'SELECT identity_mapping,updated_at FROM oauth_clients WHERE tenant_id = ? AND client_id = ?',
      [tenantId, entry.client_id],
      { consistencyClass: 'primary_required' }
    );
    return row
      ? {
          value: normalizeIdentityMappingLevelHistoryChoice('client', row.identity_mapping),
          version: String(row.updated_at),
          rawVersion: String(row.updated_at),
          latestHistoryId: null,
        }
      : null;
  }
  const state = await getSettingsManager(c.env, undefined, true, true, undefined, {
    readOnly: true,
  }).getAll('identity-mapping', { type: 'tenant', id: tenantId });
  const admin = ensureAdminDatabaseAdapter(c.env, 'identity-mapping-history');
  if (!admin) throw new Error('history_database_unavailable');
  const latest = await admin.queryOne<{ id: string }>(
    "SELECT id FROM identity_mapping_level_history WHERE tenant_id=? AND tier='tenant_default' AND status='committed' ORDER BY created_at DESC,id DESC LIMIT 1",
    [tenantId],
    { consistencyClass: 'primary_required' }
  );
  if (!latest) throw new Error('history_latest_missing');
  return {
    value: normalizeIdentityMappingLevelHistoryChoice(
      'tenant_default',
      state.sources[KEY] === 'kv' ? state.values[KEY] : null
    ),
    version: `${state.version}~${latest.id}`,
    rawVersion: state.version,
    latestHistoryId: latest.id,
  };
}

async function refusal(
  c: HistoryContext,
  admin: DatabaseAdapter,
  entry: IdentityMappingLevelHistoryRow,
  state: Awaited<ReturnType<typeof current>>,
  references = new Map<string, Promise<Reason | null>>()
): Promise<Reason | null> {
  if (!state) return 'client_deleted';
  let target: IdentityMappingLevelHistoryChoice;
  try {
    target = restorationValue(entry);
    if (
      entry.tier === 'client' &&
      !validateOptionalIdentityMappingSelectorField(target, 'identity_mapping').ok
    )
      return 'invalid_history';
  } catch {
    return 'invalid_history';
  }
  if (
    JSON.stringify(choice(entry.tier, state.value)) === JSON.stringify(choice(entry.tier, target))
  )
    return 'is_current';
  const described = choice(entry.tier, target);
  if (described.state === 'invalid') return 'invalid_history';
  if (described.state !== 'set') return null;
  if (typeof described.setId !== 'string' || !described.setId) return 'invalid_history';
  const selector = typeof target === 'object' && target !== null ? target : {};
  const key = `${entry.tier}:${JSON.stringify(target)}`;
  const setId = described.setId;
  const cached = references.get(key);
  if (cached) return cached;
  const work = (async (): Promise<Reason | null> => {
    const checked = await validateOidcMappingSetReference({
      adminAdapter: admin,
      contextTenantId: getTenantIdFromContext(c),
      scope: entry.tier === 'client' ? 'client' : 'tenant',
      setId,
      ...(typeof selector.fieldMappingVersionId === 'string'
        ? { versionId: selector.fieldMappingVersionId }
        : {}),
    });
    if (checked.ok) return null;
    if (checked.code === 'admin_database_unavailable')
      throw new Error('history_reference_unavailable');
    return checked.code === 'set_missing' || checked.code.includes('not_found')
      ? 'set_deleted'
      : 'set_inactive';
  })();
  references.set(key, work);
  return work;
}

function historyReadCache() {
  return {
    states: new Map<string, ReturnType<typeof current>>(),
    references: new Map<string, Promise<Reason | null>>(),
  };
}

/** A page's row limit alone does not bound validation SQL when every row names another set. */
function boundedHistoryRows(rows: readonly IdentityMappingLevelHistoryRow[], limit: number) {
  const targets = new Set<string>();
  const page: IdentityMappingLevelHistoryRow[] = [];
  for (const row of rows.slice(0, limit)) {
    const key = `${row.tier}:${row.before_json}`;
    if (!targets.has(key) && targets.size === HISTORY_REFERENCE_LIMIT) break;
    targets.add(key);
    page.push(row);
  }
  return page;
}

async function publicEntry(
  c: HistoryContext,
  admin: DatabaseAdapter,
  entry: IdentityMappingLevelHistoryRow,
  cache = historyReadCache()
) {
  const key = `${entry.tier}:${entry.client_id ?? ''}`;
  const state = cache.states.get(key) ?? current(c, entry);
  cache.states.set(key, state);
  const reason = await refusal(c, admin, entry, await state, cache.references);
  return {
    id: entry.id,
    tier: entry.tier,
    client_id: entry.client_id,
    before: choice(entry.tier, raw(entry, 'before')),
    after: choice(entry.tier, raw(entry, 'after')),
    actor_id: entry.actor_id,
    actor_type: entry.actor_type,
    via: entry.via,
    bulk_id: entry.bulk_id,
    created_at: entry.created_at,
    source_version: entry.source_version,
    restorable: reason === null,
    ...(reason ? { not_restorable_reason: reason } : {}),
  };
}

interface Cursor {
  time: number;
  id: string;
  tier: string | null;
  clientId: string | null;
}
function decodeCursor(value: string): Cursor {
  if (value.length > 2048) throw new Error('invalid_cursor');
  const parsed: unknown = JSON.parse(decodeBase64Url(value));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('invalid_cursor');
  const candidate = parsed as Cursor;
  if (
    !Number.isSafeInteger(candidate.time) ||
    candidate.time < 0 ||
    !ID.test(candidate.id) ||
    ![null, 'client', 'tenant_default'].includes(candidate.tier) ||
    (candidate.clientId !== null && typeof candidate.clientId !== 'string')
  )
    throw new Error('invalid_cursor');
  return candidate;
}

export async function adminIdentityMappingHistoryHandler(c: HistoryContext): Promise<Response> {
  const tier = c.req.query('tier') ?? null;
  const clientId = c.req.query('client_id') ?? null;
  const limit = Number(c.req.query('limit') ?? '50');
  if (
    tier !== 'tenant_default' &&
    !hasAdminPermission(auth(c)?.permissions ?? [], ADMIN_PERMISSIONS.CLIENTS_READ)
  ) {
    return c.json(
      {
        error: 'forbidden',
        error_description:
          'Client history needs clients read permission; use tier=tenant_default for tenant history',
      },
      403
    );
  }
  let cursor: Cursor | null = null;
  try {
    if (
      ![null, 'client', 'tenant_default'].includes(tier) ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      (clientId !== null &&
        (!clientId ||
          clientId.length > 256 ||
          clientId !== clientId.trim() ||
          tier === 'tenant_default'))
    ) {
      return invalid(c, 'Invalid tier, client_id or limit');
    }
    if (c.req.query('cursor')) cursor = decodeCursor(c.req.query('cursor') as string);
    if (cursor && (cursor.tier !== tier || cursor.clientId !== clientId))
      return invalid(c, 'Cursor filters changed');
  } catch {
    return invalid(c, 'Invalid cursor');
  }
  try {
    const tenantId = getTenantIdFromContext(c);
    const admin = ensureAdminDatabaseAdapter(c.env, 'identity-mapping-history');
    if (!admin) return unavailable(c);
    const clauses = ["tenant_id = ? AND status = 'committed'"];
    const params: unknown[] = [tenantId];
    if (tier) {
      clauses.push('tier = ?');
      params.push(tier);
    }
    if (clientId) {
      clauses.push('client_id = ?');
      params.push(clientId);
    }
    if (cursor) {
      clauses.push('(created_at < ? OR (created_at = ? AND id < ?))');
      params.push(cursor.time, cursor.time, cursor.id);
    }
    const logs = createLogReadAdapter({
      env: c.env,
      tenantId,
      dataset: 'admin.identity_mapping_level_history',
      onCoverage: logCoverageHeaders(c),
      columns: [
        'id',
        'tenant_id',
        'tier',
        'client_id',
        'before_json',
        'after_json',
        'actor_id',
        'actor_type',
        'via',
        'bulk_id',
        'source_version',
        'status',
        'created_at',
        'updated_at',
        'committed_at',
        'last_reconciled_at',
        'receipt_acknowledged_at',
      ],
    });
    const rows = await logs.adapter.query<IdentityMappingLevelHistoryRow>(
      `SELECT * FROM identity_mapping_level_history WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC,id DESC LIMIT ?`,
      [...params, limit + 1],
      { consistencyClass: 'primary_required' }
    );
    const page = boundedHistoryRows(rows, limit);
    const last = page[page.length - 1];
    const cache = historyReadCache();
    return c.json({
      entries: await mapWithConcurrency(page, 4, (row) => publicEntry(c, admin, row, cache)),
      log_coverage: logs.coverage(),
      next_cursor:
        rows.length > page.length && last
          ? arrayBufferToBase64Url(
              new TextEncoder().encode(
                JSON.stringify({ time: last.created_at, id: last.id, tier, clientId })
              )
            )
          : null,
    });
  } catch (error) {
    return logQueryErrorResponse(c, error) ?? unavailable(c);
  }
}

/** Share only this preview's identical reads; activation scope is still judged per app. */
function cachePreviewReads(admin: DatabaseAdapter): DatabaseAdapter {
  const reads = new Map<string, Promise<unknown>>();
  const cached = <T>(
    kind: 'query' | 'queryOne',
    sql: string,
    params: unknown[] | undefined,
    options: QueryOptions | undefined,
    read: () => Promise<T>
  ): Promise<T> => {
    const key = JSON.stringify([kind, sql, params, options]);
    const existing = reads.get(key);
    if (existing) return existing as Promise<T>;
    const pending = read();
    reads.set(key, pending);
    return pending;
  };
  return {
    query: <T>(sql: string, params?: unknown[], options?: QueryOptions) =>
      cached('query', sql, params, options, () => admin.query<T>(sql, params, options)),
    queryOne: <T>(sql: string, params?: unknown[], options?: QueryOptions) =>
      cached('queryOne', sql, params, options, () => admin.queryOne<T>(sql, params, options)),
    execute: admin.execute.bind(admin),
    transaction: admin.transaction.bind(admin),
    batch: admin.batch.bind(admin),
    isHealthy: admin.isHealthy.bind(admin),
    getType: admin.getType.bind(admin),
    close: admin.close.bind(admin),
  };
}

/** The content diff and scope judgement are B3's, after independently selecting both levels. */
async function previewApps(
  c: HistoryContext,
  admin: DatabaseAdapter,
  entry: IdentityMappingLevelHistoryRow
) {
  const tenantId = getTenantIdFromContext(c);
  const core = createAuthContextFromHono(c, tenantId).coreAdapter;
  const rows = await core.query<{
    client_id: string;
    client_name: string | null;
    identity_mapping: string | null;
    scope: string | null;
  }>(
    `SELECT client_id,client_name,identity_mapping,scope FROM oauth_clients WHERE tenant_id = ?${entry.tier === 'client' ? ' AND client_id = ?' : ''} ORDER BY client_id LIMIT ?`,
    [tenantId, ...(entry.tier === 'client' ? [entry.client_id] : []), APPS_LIMIT + 1]
  );
  const previewAdmin = admin;
  const repository = new IdentityMappingControlPlaneRepository(previewAdmin);
  const views = new Map<string, ReturnType<typeof effectiveMappingView>>();
  const view = (selector: unknown, proposed = false) => {
    const key = `${proposed}:${JSON.stringify(selector)}`;
    const cached = views.get(key);
    if (cached) return cached;
    const pending = effectiveMappingView(c.env, tenantId, {
      clientId: null,
      clientSelector: selector,
      ...(proposed && entry.tier === 'tenant_default'
        ? { tenantDefaultProposal: { value: raw(entry, 'before') } }
        : {}),
    });
    views.set(key, pending);
    return pending;
  };
  const read = async (binding: RuntimeIdentityMappingBinding | null) => {
    const owner = binding?.tenantId;
    const versions = binding
      ? await repository.listFieldMappingVersions(binding.tenantId, binding.fieldMappingSetId, {
          versionId: binding.fieldMappingVersionId,
          claimsPreviewOnly: true,
        })
      : [];
    const content =
      versions[0] && binding
        ? {
            ...contentFromStoredVersion(versions[0]),
            // A newer compile can be draft: only the runtime's active snapshot supplies types.
            catalogVersionId: binding.catalog.identity.id,
          }
        : null;
    const shapes: ReturnType<typeof claimShapes> =
      content && owner
        ? claimShapes(
            content,
            await readCatalogTypes(previewAdmin, owner, content.catalogVersionId)
          )
        : new Map<string, never>();
    const profile = contentProfile(shapes);
    return {
      content,
      shapes,
      profile,
      profiles: await readProfileFields(previewAdmin, owner ?? tenantId, [profile]),
    };
  };
  const contents = new Map<string, ReturnType<typeof read>>();
  const readCached = async (
    view: NonNullable<Awaited<ReturnType<typeof effectiveMappingView>>>,
    clientId: string,
    allowBeforeUnavailable = false
  ) => {
    const selected = view.selection;
    // This is the runtime's named-set resolver: it enforces owner, pinned version and app scope.
    // A selection of none reads no binding. A selector's namespace needs no second resolution.
    let binding: RuntimeIdentityMappingBinding | null = null;
    let beforeUnavailable: BeforeUnavailable | undefined;
    if (selected.kind === 'bound') {
      try {
        binding = await loadMappingBindingBySetId({
          adapter: previewAdmin,
          tenantId,
          setId: selected.setId,
          tier: selected.tier,
          protocol: 'oidc',
          role: 'op',
          versionId: selected.pinnedVersionId,
          clientId,
        });
      } catch (error) {
        if (
          allowBeforeUnavailable &&
          error instanceof IdentityMappingResolutionError &&
          (error.code === 'set_missing' ||
            error.code === 'set_inactive' ||
            error.code === 'destination_profile_invalid')
        ) {
          beforeUnavailable = error.code;
        } else {
          throw error;
        }
      }
    }
    const key = JSON.stringify([
      binding?.tenantId,
      binding?.fieldMappingVersionId,
      binding?.mappingSnapshotHash,
      binding?.catalog.identity.id,
      binding?.catalog.identity.contentHash,
    ]);
    // App-scoped activations can select distinct versions even for an identical selector.
    if (!contents.has(key) && contents.size >= PREVIEW_SELECTION_LIMIT) return null;
    const pending = contents.get(key) ?? read(binding);
    contents.set(key, pending);
    return {
      ...(await pending),
      destinationNamespace: binding?.destinationNamespace,
      beforeUnavailable,
    };
  };
  const apps = [];
  let budgetTruncated = false;
  for (const row of rows.slice(0, APPS_LIMIT)) {
    // Bound the number of distinct choices as well as rows; a page of unique pinned versions
    // otherwise multiplies the content/profile SQL even though its app count is bounded.
    const own = normalizeIdentityMappingLevelHistoryChoice('client', row.identity_mapping);
    const target = restorationValue(entry);
    const afterOwn = entry.tier === 'client' ? target : own;
    const needed = [`false:${JSON.stringify(own)}`, `true:${JSON.stringify(afterOwn)}`];
    if (views.size + needed.filter((key) => !views.has(key)).length > PREVIEW_SELECTION_LIMIT) {
      budgetTruncated = true;
      break;
    }
    const before = await view(own);
    const after = await view(afterOwn, true);
    if (!before || !after) throw new Error('history_preview_unavailable');
    if (
      entry.tier === 'tenant_default' &&
      JSON.stringify(before.selection) === JSON.stringify(after.selection)
    )
      continue;
    const [was, next] = [
      await readCached(before, row.client_id, true),
      await readCached(after, row.client_id),
    ];
    if (!was || !next) {
      budgetTruncated = true;
      break;
    }
    const namespaceOf = (selector: IdentityMappingLevelHistoryChoice, bindingNamespace?: string) =>
      typeof selector === 'object' &&
      selector !== null &&
      typeof selector.destinationNamespace === 'string'
        ? selector.destinationNamespace
        : (bindingNamespace ?? 'oidc.claim');
    const beforeNamespace = namespaceOf(own, was.destinationNamespace);
    const namespace = namespaceOf(afterOwn, next.destinationNamespace);
    const changes = [
      ...diffClaimShapes(
        new Map([...was.shapes].filter(([, shape]) => shape.namespace === beforeNamespace)),
        new Map([...next.shapes].filter(([, shape]) => shape.namespace === namespace))
      ),
      ...diffValidationRules(was.content, next.content ?? { rules: [] }, was.profile, next.profile),
      ...profileFieldChanges(was.profiles, was.profile, next.profile, next.profiles),
    ];
    const profiles = new Map([...was.profiles, ...next.profiles]);
    apps.push({
      tenant_id: tenantId,
      client_id: row.client_id,
      name: row.client_name ?? row.client_id,
      tier: after.selection.kind === 'bound' ? after.selection.tier : 'none',
      ...(was.beforeUnavailable ? { before_unavailable: was.beforeUnavailable } : {}),
      // App lines show selection and chain; implicit activation notices belong to the effective
      // endpoint and vary by app. Omitting them lets identical choices safely share their reads.
      before: {
        tenantId,
        clientId: row.client_id,
        selection: before.selection,
        chain: before.chain,
      },
      after: { tenantId, clientId: row.client_id, selection: after.selection, chain: after.chain },
      ...changesFor(
        changes,
        profiles,
        new Set(['openid', ...(row.scope ?? '').split(/\s+/)]),
        namespace,
        beforeNamespace
      ),
    });
  }
  return { apps, apps_truncated: rows.length > APPS_LIMIT || budgetTruncated };
}

export async function adminIdentityMappingHistoryRestoreHandler(
  c: HistoryContext
): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    const input: unknown = await c.req.json();
    if (!input || typeof input !== 'object' || Array.isArray(input))
      return invalid(c, 'The body must be an object');
    body = input as Record<string, unknown>;
    const allowed = body.preview === true ? ['preview'] : ['expected_version', 'reason'];
    if (
      Object.keys(body).some((key) => !allowed.includes(key)) ||
      (body.preview !== true &&
        (typeof body.expected_version !== 'string' ||
          !body.expected_version ||
          body.expected_version.length > 128)) ||
      (body.reason !== undefined &&
        (typeof body.reason !== 'string' || !body.reason.trim() || body.reason.length > 500))
    ) {
      return invalid(c, 'Use {preview:true} or {expected_version,reason?}');
    }
  } catch {
    return invalid(c, 'Invalid JSON body');
  }
  const id = c.req.param('id');
  if (!id || !ID.test(id)) return invalid(c, 'Invalid history ID');
  const adminAuth = auth(c);
  if (!adminAuth || adminAuth.actorType === 'agent') return c.json({ error: 'forbidden' }, 403);
  try {
    const tenantId = getTenantIdFromContext(c);
    const database = ensureAdminDatabaseAdapter(c.env, 'identity-mapping-history');
    if (!database) return unavailable(c);
    const admin = body.preview === true ? cachePreviewReads(database) : database;
    const entry = await readIdentityMappingLevelHistory(admin, tenantId, id);
    if (!entry || entry.status !== 'committed') return c.json({ error: 'not_found' }, 404);
    const permitted =
      entry.tier === 'client'
        ? hasAdminPermission(adminAuth.permissions ?? [], ADMIN_PERMISSIONS.CLIENTS_UPDATE)
        : hasTenantSettingsPermission(adminAuth, 'identity-mapping', 'edit', tenantId);
    if (!permitted || !canAccessTenant(adminAuth, tenantId))
      return c.json({ error: 'forbidden' }, 403);
    if (
      body.preview === true &&
      entry.tier === 'tenant_default' &&
      !hasAdminPermission(adminAuth.permissions ?? [], ADMIN_PERMISSIONS.CLIENTS_READ)
    )
      return c.json(
        { error: 'forbidden', error_description: 'The apps preview needs clients read permission' },
        403
      );
    const cache = historyReadCache();
    const state = await current(c, entry);
    cache.states.set(`${entry.tier}:${entry.client_id ?? ''}`, Promise.resolve(state));
    const problem = await refusal(c, admin, entry, state, cache.references);
    if (problem) return conflict(c, problem);
    if (!state) return conflict(c, 'client_deleted');
    const target = restorationValue(entry);
    if (body.preview === true) {
      const later = await admin.query<IdentityMappingLevelHistoryRow>(
        `SELECT * FROM identity_mapping_level_history WHERE tenant_id = ? AND status = 'committed'
          AND tier = ? AND client_id IS ? AND (created_at > ? OR (created_at = ? AND id > ?))
          ORDER BY created_at DESC,id DESC LIMIT ?`,
        [
          tenantId,
          entry.tier,
          entry.client_id,
          entry.created_at,
          entry.created_at,
          entry.id,
          LATER_LIMIT + 1,
        ]
      );
      const laterPage = boundedHistoryRows(later, LATER_LIMIT);
      return c.json({
        entry: await publicEntry(c, admin, entry, cache),
        current: choice(entry.tier, state.value),
        restores: choice(entry.tier, target),
        later_changes: await mapWithConcurrency(laterPage, 4, (row) =>
          publicEntry(c, admin, row, cache)
        ),
        later_changes_truncated: later.length > laterPage.length,
        ...(later.length ? { warning: 'later_changes_will_be_overwritten' } : {}),
        ...(await previewApps(c, admin, entry)),
        expected_version: state.version,
      });
    }
    if (body.expected_version !== state.version) return conflict(c, 'version_conflict');
    const response =
      entry.tier === 'client'
        ? await adminClientUpdateWithHistoryContext(c, {
            clientId: entry.client_id ?? undefined,
            via: 'restore',
            expectedUpdatedAt: Number(state.version),
            readBody: async () => ({ identity_mapping: target }),
            restoreAudit: {
              restoredFrom: id,
              ...(typeof body.reason === 'string' ? { reason: body.reason } : {}),
            },
          })
        : await applyTenantSettingsChange({
            c: c as unknown as TenantSettingsContext,
            adminAuth,
            tenantId,
            category: 'identity-mapping',
            identityMappingHistory: {
              via: 'restore',
              ...(state.latestHistoryId ? { expectedLatestHistoryId: state.latestHistoryId } : {}),
            },
            readBody: async () => ({
              ifMatch: state.rawVersion,
              ...(target === null ? { clear: [KEY] } : { set: { [KEY]: target } }),
            }),
            auditMetadata: {
              restored_from: id,
              ...(body.reason ? { restore_reason: body.reason } : {}),
            },
          });
    if (response.status === 409) return conflict(c, 'version_conflict');
    if (response.status === 400 || response.status === 404) {
      // The set or client can disappear between the preview check and the existing save.
      // Report the restore contract's conflict, while leaving the original validation in charge.
      const changedReference = await refusal(c, admin, entry, await current(c, entry));
      if (changedReference) return conflict(c, changedReference);
    }
    if (!response.ok) return response;
    return c.json({ success: true, restored_from: id });
  } catch {
    return unavailable(c);
  }
}
