/**
 * Where a tenant's consent statements are used, for the console's statement list and detail:
 *
 * - flows whose consent nodes (and method selectors that ask with the choice) list a statement in
 *   `config.statements[].statement_id`, read from the draft and from the published version;
 * - services that use a statement as the purpose of their information release consent
 *   (`purpose_statement_id`): OIDC clients (`oauth_clients.information_release_consent`) and SAML
 *   service providers (`identity_providers.config_json.informationReleaseConsent`).
 *
 * This is for display only: deletion is decided by the evidence checks in
 * `adminConsentStatementDeleteHandler`, not by this list. A flow document that is not JSON, or one
 * too deep or too large to walk, makes the result incomplete (`usages_complete: false`) rather
 * than "unused".
 */
import type { Context } from 'hono';
import {
  createAuthContextFromHono,
  getLogger,
  getTenantIdFromContext,
  parseInformationReleaseConsentSetting,
  type DatabaseAdapter,
  type Env,
} from '@authrim/ar-lib-core';

export interface StatementFlowUsage {
  flow_id: string;
  name: string;
  kind: string;
  /** The flow's draft asks for the statement. */
  draft: boolean;
  /** The flow's published version asks for the statement. */
  published: boolean;
}

export interface StatementServiceUsage {
  protocol: 'oidc' | 'saml';
  id: string;
  name: string;
}

export interface StatementUsage {
  statement_id: string;
  flows: StatementFlowUsage[];
  services: StatementServiceUsage[];
}

export interface StatementUsageResult {
  usages: StatementUsage[];
  complete: boolean;
}

interface FlowRow {
  id: string;
  name: string | null;
  display_name: string | null;
  kind: string | null;
  graph_definition: string | null;
  compiled_plan: string | null;
  draft_editor_json: string | null;
  draft_runtime_base_json: string | null;
  runtime_snapshot_json: string | null;
  editor_snapshot_json: string | null;
}

const MAX_DEPTH = 64;
const MAX_IDS = 4096;

class Unreadable extends Error {}

function parseDocument(value: unknown): unknown {
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
 * Every statement id a flow document lists (`statements[].statement_id`, at any depth: editor
 * nodes and runtime steps both keep it in their config). Throws Unreadable when the document is
 * too deep or lists too many to be walked whole.
 */
export function statementIdsInFlowDocument(document: unknown): Set<string> {
  const found = new Set<string>();
  let visited = 0;
  const walk = (value: unknown, depth: number): void => {
    if (depth > MAX_DEPTH) throw new Unreadable();
    if (Array.isArray(value)) {
      for (const entry of value) walk(entry, depth + 1);
      return;
    }
    if (!value || typeof value !== 'object') return;
    if (++visited > MAX_IDS * 16) throw new Unreadable();
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.statements)) {
      for (const entry of record.statements) {
        const id =
          entry && typeof entry === 'object'
            ? readString((entry as Record<string, unknown>).statement_id, 128)
            : null;
        if (!id) continue;
        found.add(id);
        if (found.size > MAX_IDS) throw new Unreadable();
      }
    }
    for (const child of Object.values(record)) walk(child, depth + 1);
  };
  walk(document, 0);
  return found;
}

/** The flow uses of statements, one entry per flow and statement. */
export function flowStatementUsages(rows: readonly FlowRow[]): {
  byStatement: Map<string, StatementFlowUsage[]>;
  complete: boolean;
} {
  const byStatement = new Map<string, StatementFlowUsage[]>();
  let complete = true;
  for (const row of rows) {
    const stages: Record<'draft' | 'published', Set<string>> = {
      draft: new Set(),
      published: new Set(),
    };
    const sources: ['draft' | 'published', unknown][] = [
      ['draft', row.draft_editor_json],
      ['draft', row.draft_runtime_base_json],
      ['draft', row.graph_definition],
      ['draft', row.compiled_plan],
      ['published', row.runtime_snapshot_json],
      ['published', row.editor_snapshot_json],
    ];
    for (const [stage, source] of sources) {
      try {
        const document = parseDocument(source);
        if (!document) continue;
        for (const id of statementIdsInFlowDocument(document)) stages[stage].add(id);
      } catch (error) {
        if (!(error instanceof Unreadable)) throw error;
        complete = false;
      }
    }
    const name = readString(row.display_name) ?? readString(row.name) ?? row.id;
    for (const id of new Set([...stages.draft, ...stages.published])) {
      const list = byStatement.get(id) ?? [];
      list.push({
        flow_id: row.id,
        name,
        kind: readString(row.kind, 64) ?? 'login',
        draft: stages.draft.has(id),
        published: stages.published.has(id),
      });
      byStatement.set(id, list);
    }
  }
  return { byStatement, complete };
}

/**
 * The purpose statement of a stored information release consent setting: null when there is no
 * setting or it names none, Unreadable when it cannot be read (not taken for "not used").
 */
function purposeOfSetting(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  let source: unknown = value;
  if (typeof value === 'string') {
    if (!value.trim()) return null;
    try {
      source = JSON.parse(value) as unknown;
    } catch {
      throw new Unreadable();
    }
  }
  const parsed = parseInformationReleaseConsentSetting(source);
  if (!parsed.ok) throw new Unreadable();
  return parsed.setting.purpose_statement_id;
}

function purposeOfSamlConfig(configJson: unknown): string | null {
  const config = parseDocument(configJson);
  if (!config) return null;
  if (typeof config !== 'object' || Array.isArray(config)) throw new Unreadable();
  return purposeOfSetting((config as Record<string, unknown>).informationReleaseConsent);
}

export async function collectStatementUsages(
  db: DatabaseAdapter,
  tenantId: string
): Promise<StatementUsageResult> {
  const [flows, clients, providers] = await Promise.all([
    db.query<FlowRow>(
      `SELECT f.id, f.name, f.display_name, f.kind, f.graph_definition, f.compiled_plan,
              f.draft_editor_json, f.draft_runtime_base_json,
              v.runtime_snapshot_json, v.editor_snapshot_json
         FROM flows f
         LEFT JOIN flow_versions v
           ON v.tenant_id = f.tenant_id AND v.id = f.published_version_id
        WHERE f.tenant_id = ? AND f.deleted_at IS NULL`,
      [tenantId]
    ),
    db.query<{
      client_id: string;
      client_name: string | null;
      information_release_consent: unknown;
    }>(
      `SELECT client_id, client_name, information_release_consent
         FROM oauth_clients
        WHERE tenant_id = ? AND information_release_consent IS NOT NULL`,
      [tenantId]
    ),
    db.query<{ id: string; name: string | null; config_json: unknown }>(
      `SELECT id, name, config_json
         FROM identity_providers
        WHERE tenant_id = ? AND provider_type = 'saml_sp'`,
      [tenantId]
    ),
  ]);

  const flowResult = flowStatementUsages(flows);
  const byStatement = flowResult.byStatement;
  let complete = flowResult.complete;
  const readPurpose = (read: () => string | null): string | null => {
    try {
      return read();
    } catch (error) {
      if (!(error instanceof Unreadable)) throw error;
      complete = false;
      return null;
    }
  };
  const services = new Map<string, StatementServiceUsage[]>();
  const addService = (statementId: string | null, usage: StatementServiceUsage) => {
    if (!statementId) return;
    const list = services.get(statementId) ?? [];
    list.push(usage);
    services.set(statementId, list);
  };
  for (const client of clients) {
    addService(
      readPurpose(() => purposeOfSetting(client.information_release_consent)),
      {
        protocol: 'oidc',
        id: client.client_id,
        name: readString(client.client_name) ?? client.client_id,
      }
    );
  }
  for (const provider of providers) {
    addService(
      readPurpose(() => purposeOfSamlConfig(provider.config_json)),
      {
        protocol: 'saml',
        id: provider.id,
        name: readString(provider.name) ?? provider.id,
      }
    );
  }

  const ids = [...new Set([...byStatement.keys(), ...services.keys()])].sort();
  return {
    usages: ids.map((statementId) => ({
      statement_id: statementId,
      flows: (byStatement.get(statementId) ?? []).sort((a, b) => a.name.localeCompare(b.name)),
      services: (services.get(statementId) ?? []).sort((a, b) => a.name.localeCompare(b.name)),
    })),
    complete,
  };
}

/** GET /api/admin/consent-statements/usage */
export async function adminConsentStatementUsageHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('ADMIN_CONSENT');
  try {
    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);
    const { usages, complete } = await collectStatementUsages(authCtx.coreAdapter, tenantId);
    return c.json({ usages, usages_complete: complete });
  } catch (error) {
    log.error('Failed to read consent statement usage', { action: 'usage' }, error as Error);
    return c.json(
      { error: 'server_error', error_description: 'Failed to read statement usage' },
      500
    );
  }
}
