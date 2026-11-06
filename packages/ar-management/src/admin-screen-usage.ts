/**
 * Where a tenant's screens are used: the flows whose nodes name them (`config.screen_ref`, by the
 * screen's id or its key) and the account pages that place them (`screen_key`).
 *
 * Flows are read as drafts, as their published version, and as the older published versions
 * that sign-ins still in progress run (an interaction keeps the version it started on), so
 * neither a screen a running flow shows nor one a draft is about to publish can be deleted.
 * `basic_profile` is resolved at run time to one of the default screen keys, so it counts as a
 * use of every screen with such a key. Account pages are read from the tenant's `login-ui`
 * settings, both the canonical document and its KV copy (a copy may lag behind a save): each
 * page's draft placements, and the legacy draft and published definitions (the legacy published
 * page loads its screens live). A published account page keeps copies of its screens, so it does
 * not depend on the rows.
 *
 * What cannot be read is not taken for "unused": a stored document that is not JSON, or one too
 * deep or too large to walk, makes the result incomplete, and deletion is refused.
 */
import {
  requireDedicatedAdminDatabaseAdapter,
  type DatabaseAdapter,
  type Env,
  type ScreenUsage,
} from '@authrim/ar-lib-core';
import { DatabaseSettingsCanonicalStore } from '@authrim/ar-lib-core/services/settings-canonical-store';

export interface FlowUsageRow {
  id: string;
  name: string | null;
  display_name: string | null;
  graph_definition: string | null;
  compiled_plan: string | null;
  draft_editor_json: string | null;
  draft_runtime_base_json: string | null;
  runtime_snapshot_json: string | null;
  editor_snapshot_json: string | null;
  /** The documents are an older published version that sign-ins in progress still run. */
  running?: boolean;
}

/** Usages by screen id, and whether everything that could name a screen was read. */
export interface ScreenUsageResult {
  usages: Map<string, ScreenUsage[]>;
  complete: boolean;
}

/** Screen keys `basic_profile` falls back to at run time (`defaultScreenKeyForRuntimeComponent`). */
const BASIC_PROFILE_KEYS = new Set([
  'login',
  'registration',
  'profile_completion',
  'code_input',
  'consent',
]);

/** A screen as it can be named: by its id or by its key. */
export interface ScreenIdentity {
  id: string;
  screen_key: string;
}

/** A reference found in a flow document, with the node it sits in when there is one. */
interface FlowScreenRef {
  ref: string;
  nodeId: string | null;
  nodeTitle: string | null;
}

const MAX_DEPTH = 64;
const MAX_REFS = 4096;

class Unreadable extends Error {}

/** A stored JSON document: null when there is none, Unreadable when it is not JSON. */
function parseObject(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new Unreadable();
  if (!value.trim()) return null;
  try {
    return JSON.parse(value);
  } catch {
    throw new Unreadable();
  }
}

const readString = (value: unknown, max = 200): string | null =>
  typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;

/**
 * The node an object belongs to: the nearest editor node (an id and a type) or runtime step (it
 * names the editor node it came from, `source_node_id`, so a draft's editor and runtime documents
 * agree on the node).
 */
function nodeOf(value: Record<string, unknown>): { id: string; title: string | null } | null {
  const source = readString(value.source_node_id);
  const id = source ?? (typeof value.type === 'string' ? readString(value.id) : null);
  if (!id) return null;
  return {
    id,
    title: readString(value.title) ?? readString(value.label) ?? readString(value.name),
  };
}

/** A config or content written as a JSON string: its object, or nothing (as the run time). */
function parseEmbedded(value: string): unknown {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Every `screen_ref` in a flow document, with the node it belongs to. Throws Unreadable when the
 * document is too deep or names too many screens to be walked whole.
 */
export function screenRefsInFlowDocument(document: unknown): FlowScreenRef[] {
  const found: FlowScreenRef[] = [];
  const walk = (
    value: unknown,
    node: { id: string; title: string | null } | null,
    depth: number
  ): void => {
    if (depth > MAX_DEPTH || found.length >= MAX_REFS) throw new Unreadable();
    if (Array.isArray(value)) {
      for (const item of value) walk(item, node, depth + 1);
      return;
    }
    if (!value || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    const here = nodeOf(record) ?? node;
    for (const [key, item] of Object.entries(record)) {
      if (key === 'screen_ref') {
        const ref = readString(item, 256);
        if (ref) found.push({ ref, nodeId: here?.id ?? null, nodeTitle: here?.title ?? null });
        continue;
      }
      // The run time also takes a step's config and content written as a JSON string
      // (parseJsonRecord in login-runtime-flow.ts); one that is not JSON is read as empty there.
      if ((key === 'config' || key === 'content') && typeof item === 'string') {
        walk(parseEmbedded(item), here, depth + 1);
        continue;
      }
      walk(item, here, depth + 1);
    }
  };
  walk(document, null, 0);
  return found;
}

const matches = (ref: string, screen: ScreenIdentity) =>
  ref === screen.id ||
  ref === screen.screen_key ||
  (ref === 'basic_profile' && BASIC_PROFILE_KEYS.has(screen.screen_key));

type Stage = 'draft' | 'published' | 'running';

/** The flow uses of the given screens, one per flow, node and stage. */
export function flowUsages(
  rows: readonly FlowUsageRow[],
  screens: readonly ScreenIdentity[]
): ScreenUsageResult {
  const usages = new Map<string, ScreenUsage[]>(screens.map((screen) => [screen.id, []]));
  const seen = new Set<string>();
  let complete = true;
  for (const row of rows) {
    const flowName = readString(row.display_name) ?? readString(row.name) ?? row.id;
    const published: Stage = row.running ? 'running' : 'published';
    const sources: [Stage, unknown][] = [
      ['draft', row.draft_editor_json],
      ['draft', row.draft_runtime_base_json],
      ['draft', row.graph_definition],
      ['draft', row.compiled_plan],
      [published, row.runtime_snapshot_json],
      [published, row.editor_snapshot_json],
    ];
    for (const [stage, source] of sources) {
      let refs: FlowScreenRef[];
      try {
        const document = parseObject(source);
        if (!document) continue;
        refs = screenRefsInFlowDocument(document);
      } catch (error) {
        if (!(error instanceof Unreadable)) throw error;
        complete = false;
        continue;
      }
      for (const found of refs) {
        for (const screen of screens) {
          if (!matches(found.ref, screen)) continue;
          const key = `${screen.id}\u0000${row.id}\u0000${found.nodeId ?? ''}\u0000${stage}`;
          if (seen.has(key)) continue;
          seen.add(key);
          usages.get(screen.id)?.push({
            kind: 'flow',
            flow_id: row.id,
            flow_name: flowName,
            node_id: found.nodeId,
            node_title: found.nodeTitle,
            stage,
          });
        }
      }
    }
  }
  return { usages, complete };
}

/** Screen keys an account page definition places (`screens[].screen_key`). */
function placedKeys(definition: unknown): string[] {
  if (!definition || typeof definition !== 'object') return [];
  const screens = (definition as { screens?: unknown }).screens;
  if (!Array.isArray(screens)) return [];
  return screens
    .map((placement) =>
      placement && typeof placement === 'object'
        ? readString((placement as { screen_key?: unknown }).screen_key, 96)
        : null
    )
    .filter((key): key is string => key !== null);
}

/**
 * The account page uses of the given screens, read from the tenant's `login-ui` settings (one or
 * more copies of them: a page found in any copy counts once).
 */
export function accountPageUsages(
  documents: readonly Record<string, unknown>[],
  screens: readonly ScreenIdentity[]
): ScreenUsageResult {
  const usages = new Map<string, ScreenUsage[]>(screens.map((screen) => [screen.id, []]));
  let complete = true;
  const seen = new Set<string>();
  for (const settings of documents) {
    try {
      for (const page of placedPages(settings)) {
        const keys = new Set(page.keys);
        for (const screen of screens) {
          if (!keys.has(screen.screen_key)) continue;
          const key = `${screen.id}\u0000${page.id ?? ''}`;
          if (seen.has(key)) continue;
          seen.add(key);
          usages
            .get(screen.id)
            ?.push({ kind: 'account_page', page_id: page.id, page_name: page.name });
        }
      }
    } catch (error) {
      if (!(error instanceof Unreadable)) throw error;
      complete = false;
    }
  }
  return { usages, complete };
}

/** The account pages a `login-ui` settings document has, with the screen keys each places. */
function placedPages(
  settings: Record<string, unknown>
): { id: string | null; name: string; keys: string[] }[] {
  const pages: { id: string | null; name: string; keys: string[] }[] = [];
  const document = parseObject(settings['login-ui.account_pages']);
  if (document && typeof document === 'object') {
    const list = (document as { pages?: unknown }).pages;
    for (const page of Array.isArray(list) ? list : []) {
      if (!page || typeof page !== 'object') continue;
      const record = page as Record<string, unknown>;
      const id = readString(record.id, 96);
      pages.push({
        id,
        name: readString(record.name, 80) ?? id ?? 'Account page',
        keys: placedKeys(record.draft),
      });
    }
  }
  const legacy = [
    ...placedKeys(parseObject(settings['login-ui.account_page_draft'])),
    ...placedKeys(parseObject(settings['login-ui.account_page_published'])),
  ];
  if (legacy.length > 0) pages.push({ id: null, name: 'Legacy account page', keys: legacy });
  return pages;
}

/**
 * The flows a tenant has not deleted, each with its published version's documents, and the older
 * published versions (of any flow, deleted or not) that sign-ins in progress still run.
 */
async function readFlows(db: DatabaseAdapter, tenantId: string): Promise<FlowUsageRow[]> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const [current, running] = await Promise.all([
    db.query<FlowUsageRow>(
      `SELECT f.id, f.name, f.display_name, f.graph_definition, f.compiled_plan,
              f.draft_editor_json, f.draft_runtime_base_json,
              v.runtime_snapshot_json, v.editor_snapshot_json
         FROM flows f
         LEFT JOIN flow_versions v
           ON v.tenant_id = f.tenant_id AND v.id = f.published_version_id
        WHERE f.tenant_id = ? AND f.deleted_at IS NULL`,
      [tenantId]
    ),
    db.query<FlowUsageRow>(
      `SELECT f.id, f.name, f.display_name, NULL AS graph_definition, NULL AS compiled_plan,
              NULL AS draft_editor_json, NULL AS draft_runtime_base_json,
              v.runtime_snapshot_json, v.editor_snapshot_json
         FROM flow_versions v
         JOIN flows f ON f.tenant_id = v.tenant_id AND f.id = v.flow_id
        WHERE v.tenant_id = ?
          AND (f.published_version_id IS NULL OR v.id <> f.published_version_id
               OR f.deleted_at IS NOT NULL)
          AND v.id IN (
            SELECT DISTINCT i.flow_version_id
              FROM flow_interactions i
             WHERE i.tenant_id = ? AND i.state IN ('created', 'active') AND i.expires_at > ?
          )`,
      [tenantId, tenantId, nowSeconds]
    ),
  ]);
  return [...current, ...running.map((row) => ({ ...row, running: true }))];
}

/** A settings document read from KV or the canonical store, when it is a JSON object. */
function settingsObject(value: unknown): Record<string, unknown> | null {
  const parsed = typeof value === 'string' ? parseObject(value) : value;
  if (parsed === null || parsed === undefined) return null;
  if (typeof parsed !== 'object' || Array.isArray(parsed)) throw new Unreadable();
  return parsed as Record<string, unknown>;
}

/**
 * The tenant's `login-ui` settings: the KV copy the account page reads, the canonical document it
 * is copied from (a save whose copy is still pending is there only), and, when there is neither,
 * the creation-time copy in AUTHRIM_CONFIG. A read failure
 * throws; an unreadable document makes the result incomplete.
 */
async function readLoginUiSettings(
  env: Env,
  tenantId: string
): Promise<{ documents: Record<string, unknown>[]; complete: boolean }> {
  const documents: Record<string, unknown>[] = [];
  let complete = true;
  const take = (value: unknown) => {
    try {
      const document = settingsObject(value);
      if (document) documents.push(document);
    } catch (error) {
      if (!(error instanceof Unreadable)) throw error;
      complete = false;
    }
  };
  const key = `settings:tenant:${tenantId}:login-ui`;
  const kv = (await env.SETTINGS?.get(key)) ?? null;
  take(kv);
  let canonical = null;
  if (env.DB_ADMIN) {
    canonical = await new DatabaseSettingsCanonicalStore(
      requireDedicatedAdminDatabaseAdapter(env, 'settings-canonical')
    ).load('login-ui', { type: 'tenant', id: tenantId });
    if (canonical) take(canonical.data);
  }
  // A tenant with neither has its creation-time copy read instead (SettingsManager does the same).
  if (kv === null && !canonical) take((await env.AUTHRIM_CONFIG?.get(key)) ?? null);
  return { documents, complete };
}

/**
 * Where each of the given screens is used, and whether everything that could name one was read.
 * A failure to read the flows or the settings throws: callers that decide on deletion must not
 * take "unknown" for "unused".
 */
export async function collectScreenUsages(
  env: Env,
  db: DatabaseAdapter,
  tenantId: string,
  screens: readonly ScreenIdentity[]
): Promise<ScreenUsageResult> {
  const [flows, settings] = await Promise.all([
    readFlows(db, tenantId),
    readLoginUiSettings(env, tenantId),
  ]);
  const byFlow = flowUsages(flows, screens);
  const byPage = accountPageUsages(settings.documents, screens);
  return {
    usages: new Map(
      screens.map((screen) => [
        screen.id,
        [...(byFlow.usages.get(screen.id) ?? []), ...(byPage.usages.get(screen.id) ?? [])],
      ])
    ),
    complete: byFlow.complete && byPage.complete && settings.complete,
  };
}

/** How many flows and account pages use a screen (the list shows counts, not the uses). */
export function usageCounts(usages: readonly ScreenUsage[]): {
  flows: number;
  account_pages: number;
} {
  const flows = new Set<string>();
  let accountPages = 0;
  for (const usage of usages) {
    if (usage.kind === 'flow') flows.add(usage.flow_id);
    else accountPages += 1;
  }
  return { flows: flows.size, account_pages: accountPages };
}
