/**
 * Admin Flow Management API.
 *
 * This file owns the new LoginUI runtime Flow management surface. Legacy Flow
 * Designer handlers were intentionally replaced by draft/publish/import/export
 * operations that match the Flow runtime contract model.
 */

import { Context } from 'hono';
import type {
  Env,
  AdminAuthContext,
  DatabaseAdapter,
  FlowAssignmentTargetType,
  FlowEditorState,
  FlowKind,
  FlowRuntimeContract,
  FlowRuntimeContractPackage,
  FlowValidationIssue,
} from '@authrim/ar-lib-core';
import {
  FLOW_NODE_DEFINITIONS,
  FLOW_RUNTIME_CONTRACT_SCHEMA_VERSION,
  createAuthContextFromHono,
  createAuditLogFromContext,
  generateId,
  getFlowNodeDefinition,
  getLogger,
  getTenantIdFromContext,
  isFlowNodeType,
  sanitizeImportedFlowContract,
  validateFlowEditorState,
  validateFlowRuntimeContractPackage,
} from '@authrim/ar-lib-core';

type AdminContext = Context<{ Bindings: Env; Variables: { adminAuth?: AdminAuthContext } }>;
type BaseContext = Context<{ Bindings: Env }>;

type FlowStatus = 'draft' | 'published' | 'disabled';

interface FlowRow {
  id: string;
  tenant_id: string;
  client_id: string | null;
  profile_id: string | null;
  name: string;
  description: string | null;
  graph_definition: string | null;
  compiled_plan: string | null;
  version: string;
  is_active: number;
  is_builtin: number;
  created_by: string | null;
  created_at: number;
  updated_by: string | null;
  updated_at: number;
  slug: string | null;
  display_name: string | null;
  kind: string;
  status: string;
  draft_editor_json: string | null;
  draft_runtime_base_json: string | null;
  published_version_id: string | null;
  deleted_at: number | null;
  template_id: string | null;
}

interface FlowVersionRow {
  id: string;
  tenant_id: string;
  flow_id: string;
  version_number: number;
  schema_version: string;
  runtime_snapshot_json: string;
  editor_snapshot_json: string | null;
  validation_result_json: string;
  published_by: string | null;
  published_at: number;
  created_at: number;
}

interface FlowAssignmentRow {
  id: string;
  tenant_id: string;
  target_type: FlowAssignmentTargetType;
  target_id: string | null;
  flow_kind: FlowKind;
  flow_id: string;
  enabled: number;
  created_at: number;
  updated_at: number;
}

interface CreateFlowBody {
  slug?: string;
  name?: string;
  display_name?: string;
  description?: string | null;
  template_id?: string | null;
  kind?: FlowKind;
  editor?: FlowEditorState;
  runtime?: FlowRuntimeContract;
  status?: FlowStatus;
}

interface UpdateFlowBody {
  slug?: string;
  name?: string;
  display_name?: string;
  description?: string | null;
  template_id?: string | null;
  kind?: FlowKind;
  editor?: FlowEditorState;
  runtime?: FlowRuntimeContract;
  status?: FlowStatus;
}

const STANDARD_FLOW_KINDS = new Set<FlowKind>([
  'login',
  'registration',
  'approve',
  'account',
  'credential_issuance',
  'attribute_elevation',
]);
const FLOW_STATUSES = new Set<FlowStatus>(['draft', 'published', 'disabled']);
const FLOW_ASSIGNMENT_TARGET_TYPES = new Set<FlowAssignmentTargetType>([
  'tenant',
  'oidc_client',
  'saml_sp',
  'credential_profile',
]);

function asBaseContext(c: AdminContext): BaseContext {
  return c as unknown as BaseContext;
}

function getCoreAdapter(c: BaseContext, tenantId: string): DatabaseAdapter {
  return createAuthContextFromHono(c, tenantId).coreAdapter;
}

function getAdminUserId(c: AdminContext): string | null {
  return c.get('adminAuth')?.userId ?? null;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) {
    return fallback;
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function normalizeSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96);
}

function normalizeDisplayName(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 200) {
    return null;
  }
  return trimmed;
}

function isAllowedFlowKind(value: unknown): value is FlowKind {
  if (typeof value !== 'string') {
    return false;
  }
  if (STANDARD_FLOW_KINDS.has(value as FlowKind)) {
    return true;
  }
  if (!value.startsWith('custom:')) {
    return false;
  }
  return /^custom:[a-z0-9][a-z0-9_-]{0,63}$/.test(value);
}

function isAllowedFlowStatus(value: unknown): value is FlowStatus {
  return typeof value === 'string' && FLOW_STATUSES.has(value as FlowStatus);
}

function isAllowedAssignmentTargetType(value: unknown): value is FlowAssignmentTargetType {
  return (
    typeof value === 'string' && FLOW_ASSIGNMENT_TARGET_TYPES.has(value as FlowAssignmentTargetType)
  );
}

function normalizeRuntime(
  flowId: string,
  kind: FlowKind,
  editor: FlowEditorState,
  runtime?: FlowRuntimeContract | null
): FlowRuntimeContract {
  const base = runtime ?? buildRuntimeFromEditor(flowId, kind, editor);
  return {
    ...base,
    flow_id: flowId,
    flow_kind: kind,
  };
}

async function slugExists(
  db: DatabaseAdapter,
  tenantId: string,
  slug: string,
  excludeFlowId?: string
): Promise<boolean> {
  const row = await db.queryOne<{ id: string }>(
    excludeFlowId
      ? 'SELECT id FROM flows WHERE tenant_id = ? AND slug = ? AND id <> ? AND deleted_at IS NULL'
      : 'SELECT id FROM flows WHERE tenant_id = ? AND slug = ? AND deleted_at IS NULL',
    excludeFlowId ? [tenantId, slug, excludeFlowId] : [tenantId, slug]
  );
  return row !== null;
}

async function makeUniqueSlug(
  db: DatabaseAdapter,
  tenantId: string,
  preferredSlug: string
): Promise<string> {
  const base = normalizeSlug(preferredSlug) || `flow-${generateId()}`;
  if (!(await slugExists(db, tenantId, base))) {
    return base;
  }

  for (let i = 2; i <= 100; i++) {
    const suffix = `-${i}`;
    const candidate = `${base.slice(0, 96 - suffix.length)}${suffix}`;
    if (!(await slugExists(db, tenantId, candidate))) {
      return candidate;
    }
  }

  return normalizeSlug(`${base}-${generateId()}`);
}

function defaultEditorState(kind: FlowKind): FlowEditorState {
  const entryTitle = kind === 'registration' ? 'Registration Request' : 'Login Request';
  return {
    nodes: [
      {
        id: 'entry',
        type: 'entry',
        title: entryTitle,
        position: { x: 0, y: 0 },
      },
      {
        id: 'complete',
        type: 'complete',
        title: 'Complete',
        position: { x: 0, y: 160 },
      },
    ],
    edges: [
      {
        id: 'edge-entry-complete',
        source: 'entry',
        source_handle: 'next',
        target: 'complete',
      },
    ],
  };
}

function buildRuntimeFromEditor(
  flowId: string,
  kind: FlowKind,
  editor: FlowEditorState
): FlowRuntimeContract {
  const steps = editor.nodes
    .filter((node) => isFlowNodeType(node.type))
    .map((node) => {
      const definition = getFlowNodeDefinition(node.type);
      return {
        id: `${node.id}:step`,
        source_node_id: node.id,
        component: definition?.runtime_component ?? `custom:${node.type}`,
        render: definition?.default_render ?? true,
        config: node.config,
      };
    });

  return {
    flow_kind: kind,
    flow_id: flowId,
    ui: {
      steps,
    },
  };
}

function splitIssues(issues: FlowValidationIssue[]): {
  valid: boolean;
  errors: FlowValidationIssue[];
  warnings: FlowValidationIssue[];
  issues: FlowValidationIssue[];
} {
  const errors = issues.filter((issue) => issue.level === 'error');
  const warnings = issues.filter((issue) => issue.level === 'warning');
  return {
    valid: errors.length === 0,
    errors,
    warnings,
    issues,
  };
}

function validateRuntimePackage(
  runtime: FlowRuntimeContract,
  editor: FlowEditorState
): FlowValidationIssue[] {
  return validateFlowRuntimeContractPackage({
    schema_version: FLOW_RUNTIME_CONTRACT_SCHEMA_VERSION,
    mode: 'runtime',
    runtime,
    editor,
  });
}

function validateDraft(editor: unknown, forPublish: boolean): FlowValidationIssue[] {
  return validateFlowEditorState(editor, { for_publish: forPublish }).filter(
    (issue) => !isAllowedSessionCheckOutputHandleIssue(issue)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAllowedSessionCheckOutputHandleIssue(issue: FlowValidationIssue): boolean {
  if (issue.code !== 'invalid_output_handle') return false;
  if (issue.ref?.type !== 'handle') return false;
  if (issue.ref.id !== 'continue' && issue.ref.id !== 'authenticate') return false;
  return issue.message.includes('node type session_check');
}

function readConfigString(config: unknown, key: string): string | null {
  if (!isRecord(config)) return null;
  const value = config[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readConfigRecord(config: unknown, key: string): Record<string, unknown> | null {
  if (!isRecord(config)) return null;
  const value = config[key];
  return isRecord(value) ? value : null;
}

function readCompletionBlockProtocol(config: unknown): string | null {
  const block = readConfigRecord(config, 'completion_block');
  const value = block?.protocol;
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

async function validateDraftReferences(
  db: DatabaseAdapter,
  tenantId: string,
  editor: FlowEditorState
): Promise<FlowValidationIssue[]> {
  const issues: FlowValidationIssue[] = [];
  for (const [index, node] of editor.nodes.entries()) {
    const path = `$.editor.nodes[${index}].config`;
    if (node.type === 'registration' || node.type === 'authentication') {
      const profileRef = readConfigString(node.config, 'authentication_profile_ref');
      if (profileRef && profileRef !== 'default') {
        issues.push({
          level: 'error',
          code: 'unsupported_authentication_profile',
          message: `Authentication method profile is not available: ${profileRef}.`,
          path: `${path}.authentication_profile_ref`,
          node_id: node.id,
          ref: { type: 'reference', id: profileRef, key: 'authentication_profile_ref' },
        });
      }
    }

    const policyRef = readConfigString(node.config, 'consent_policy_ref');
    if (policyRef) {
      issues.push(
        ...(await validateConsentPolicyReference(db, tenantId, node.id, path, policyRef, 'error'))
      );
    }
  }

  return issues;
}

async function validateConsentPolicyReference(
  db: DatabaseAdapter,
  tenantId: string,
  nodeId: string,
  path: string,
  policyId: string,
  blockingLevel: FlowValidationIssue['level']
): Promise<FlowValidationIssue[]> {
  const policy = await db.queryOne<{ id: string; is_active: number }>(
    'SELECT id, is_active FROM consent_policies WHERE tenant_id = ? AND id = ?',
    [tenantId, policyId]
  );
  if (!policy) {
    return [
      {
        level: blockingLevel,
        code: 'missing_consent_policy',
        message: `Consent policy does not exist: ${policyId}.`,
        path: `${path}.consent_policy_ref`,
        node_id: nodeId,
        ref: { type: 'reference', id: policyId, key: 'consent_policy_ref' },
      },
    ];
  }

  const issues: FlowValidationIssue[] = [];
  if (policy.is_active !== 1) {
    issues.push({
      level: 'warning',
      code: 'inactive_consent_policy',
      message: `Consent policy is inactive: ${policyId}.`,
      path: `${path}.consent_policy_ref`,
      node_id: nodeId,
      ref: { type: 'reference', id: policyId, key: 'consent_policy_ref' },
    });
  }

  const items = await db.query<{
    id: string;
    statement_id: string;
    requirement: string;
    version_mode: string;
    version_id: string | null;
    statement_active: number | null;
    current_version_id: string | null;
    fixed_version_id: string | null;
  }>(
    `SELECT i.id, i.statement_id, i.requirement, i.version_mode, i.version_id,
            s.is_active AS statement_active,
            current_v.id AS current_version_id,
            fixed_v.id AS fixed_version_id
       FROM consent_policy_items i
       LEFT JOIN consent_statements s
         ON s.tenant_id = i.tenant_id AND s.id = i.statement_id
       LEFT JOIN consent_statement_versions current_v
         ON current_v.tenant_id = i.tenant_id
        AND current_v.statement_id = i.statement_id
        AND current_v.is_current = 1
       LEFT JOIN consent_statement_versions fixed_v
         ON fixed_v.tenant_id = i.tenant_id
        AND fixed_v.id = i.version_id
      WHERE i.tenant_id = ? AND i.policy_id = ?
      ORDER BY i.display_order, i.id`,
    [tenantId, policyId]
  );
  const visibleItems = items.filter((item) => item.requirement !== 'hidden');
  if (visibleItems.length === 0) {
    issues.push({
      level: blockingLevel,
      code: 'empty_consent_policy',
      message: `Consent policy has no visible consent statements: ${policyId}.`,
      path: `${path}.consent_policy_ref`,
      node_id: nodeId,
      ref: { type: 'reference', id: policyId, key: 'consent_policy_ref' },
    });
  }

  for (const item of visibleItems) {
    if (item.statement_active !== 1) {
      issues.push({
        level: blockingLevel,
        code: 'inactive_consent_statement',
        message: `Consent policy references an inactive or missing statement: ${item.statement_id}.`,
        path: `${path}.consent_policy_ref`,
        node_id: nodeId,
        ref: { type: 'reference', id: item.statement_id, key: 'statement_id' },
      });
    }
    if (item.version_mode === 'fixed') {
      if (!item.version_id || !item.fixed_version_id) {
        issues.push({
          level: blockingLevel,
          code: 'missing_fixed_consent_statement_version',
          message: `Consent policy item references a missing fixed version: ${item.id}.`,
          path: `${path}.consent_policy_ref`,
          node_id: nodeId,
          ref: { type: 'reference', id: item.id, key: 'version_id' },
        });
      }
    } else if (!item.current_version_id) {
      issues.push({
        level: blockingLevel,
        code: 'missing_current_consent_statement_version',
        message: `Consent statement has no current version: ${item.statement_id}.`,
        path: `${path}.consent_policy_ref`,
        node_id: nodeId,
        ref: { type: 'reference', id: item.statement_id, key: 'current_version' },
      });
    }
  }

  return issues;
}

function rowToFlow(row: FlowRow) {
  const displayName = row.display_name || row.name;
  const slug = row.slug || row.id;
  const kind = (row.kind || 'login') as FlowKind;
  const editor = parseJson<FlowEditorState | null>(
    row.draft_editor_json ?? row.graph_definition,
    null
  );
  const runtime = parseJson<FlowRuntimeContract | null>(
    row.draft_runtime_base_json ?? row.compiled_plan,
    null
  );

  return {
    id: row.id,
    tenant_id: row.tenant_id,
    slug,
    name: row.name,
    display_name: displayName,
    description: row.description,
    kind,
    status: (row.status || (row.is_active === 1 ? 'published' : 'disabled')) as FlowStatus,
    editor,
    runtime,
    template_id: row.template_id ?? null,
    published_version_id: row.published_version_id,
    is_active: row.is_active === 1,
    is_builtin: row.is_builtin === 1,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_by: row.updated_by,
    updated_at: row.updated_at,
  };
}

function rowToVersion(row: FlowVersionRow) {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    flow_id: row.flow_id,
    version_number: row.version_number,
    schema_version: row.schema_version,
    runtime_snapshot: parseJson<FlowRuntimeContract | null>(row.runtime_snapshot_json, null),
    editor_snapshot: parseJson<FlowEditorState | null>(row.editor_snapshot_json, null),
    validation_result: parseJson(row.validation_result_json, { valid: false, issues: [] }),
    published_by: row.published_by,
    published_at: row.published_at,
    created_at: row.created_at,
  };
}

function rowToAssignment(row: FlowAssignmentRow) {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    target_type: row.target_type,
    target_id: row.target_id,
    flow_kind: row.flow_kind,
    flow_id: row.flow_id,
    enabled: row.enabled === 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function getFlowRow(db: DatabaseAdapter, tenantId: string, flowId: string) {
  return db.queryOne<FlowRow>(
    'SELECT * FROM flows WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL',
    [tenantId, flowId]
  );
}

function invalidRequest(c: AdminContext | BaseContext, description: string, details?: unknown) {
  return c.json(
    {
      error: 'invalid_request',
      error_description: description,
      details,
    },
    400
  );
}

function getPathId(c: AdminContext | BaseContext): string | null {
  const value = c.req.param('id');
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export async function adminFlowsListHandler(c: BaseContext) {
  try {
    const tenantId = getTenantIdFromContext(c);
    const db = getCoreAdapter(c, tenantId);
    const { kind, status, search, page = '1', limit = '20' } = c.req.query();
    const pageNum = Math.max(1, Number.parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, Number.parseInt(limit, 10) || 20));
    const offset = (pageNum - 1) * limitNum;

    const where: string[] = ['tenant_id = ?', 'deleted_at IS NULL'];
    const params: unknown[] = [tenantId];
    if (kind) {
      if (!isAllowedFlowKind(kind)) {
        return invalidRequest(c, 'kind is invalid');
      }
      where.push('kind = ?');
      params.push(kind);
    }
    if (status) {
      if (!isAllowedFlowStatus(status)) {
        return invalidRequest(c, 'status is invalid');
      }
      where.push('status = ?');
      params.push(status);
    }
    if (search) {
      where.push('(name LIKE ? OR display_name LIKE ? OR description LIKE ? OR slug LIKE ?)');
      params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
    }

    const whereSql = `WHERE ${where.join(' AND ')}`;
    const countResult = await db.queryOne<{ count: number }>(
      `SELECT COUNT(*) AS count FROM flows ${whereSql}`,
      params
    );
    const rows = await db.query<FlowRow>(
      `SELECT * FROM flows ${whereSql} ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
      [...params, limitNum, offset]
    );

    return c.json({
      flows: rows.map(rowToFlow),
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: countResult?.count ?? 0,
        total_pages: Math.ceil((countResult?.count ?? 0) / limitNum),
      },
    });
  } catch (error) {
    getLogger(c)
      .module('ADMIN-FLOWS')
      .error('Failed to list flows', {}, error as Error);
    return c.json({ error: 'server_error', error_description: 'Failed to list flows' }, 500);
  }
}

export async function adminFlowGetHandler(c: BaseContext) {
  try {
    const tenantId = getTenantIdFromContext(c);
    const db = getCoreAdapter(c, tenantId);
    const flowId = getPathId(c);
    if (!flowId) {
      return invalidRequest(c, 'id is required');
    }
    const row = await getFlowRow(db, tenantId, flowId);
    if (!row) {
      return c.json({ error: 'not_found', error_description: 'Flow not found' }, 404);
    }

    const assignments = await db.query<FlowAssignmentRow>(
      'SELECT * FROM flow_assignments WHERE tenant_id = ? AND flow_id = ? ORDER BY target_type, target_id',
      [tenantId, flowId]
    );

    return c.json({
      flow: rowToFlow(row),
      assignments: assignments.map(rowToAssignment),
    });
  } catch (error) {
    getLogger(c)
      .module('ADMIN-FLOWS')
      .error('Failed to get flow', {}, error as Error);
    return c.json({ error: 'server_error', error_description: 'Failed to get flow' }, 500);
  }
}

export async function adminFlowCreateHandler(c: AdminContext) {
  try {
    const tenantId = getTenantIdFromContext(asBaseContext(c));
    const db = getCoreAdapter(asBaseContext(c), tenantId);
    const body = await c.req.json<CreateFlowBody>();
    const displayName = normalizeDisplayName(body.display_name ?? body.name);
    if (!displayName) {
      return invalidRequest(c, 'display_name is required');
    }

    const kind = body.kind ?? 'login';
    if (!isAllowedFlowKind(kind)) {
      return invalidRequest(c, 'kind is invalid');
    }
    if (body.status !== undefined && !isAllowedFlowStatus(body.status)) {
      return invalidRequest(c, 'status is invalid');
    }
    if (body.status === 'published') {
      return invalidRequest(c, 'Use the publish endpoint to publish a Flow');
    }
    const slug = normalizeSlug(body.slug || displayName);
    if (!slug) {
      return invalidRequest(c, 'slug is required');
    }

    if (await slugExists(db, tenantId, slug)) {
      return c.json(
        { error: 'conflict', error_description: 'A Flow with this slug already exists' },
        409
      );
    }

    const flowId = generateId();
    const now = nowSeconds();
    const editor = body.editor ?? defaultEditorState(kind);
    const issues = validateDraft(editor, false);
    const runtime = normalizeRuntime(flowId, kind, editor, body.runtime);
    const adminUserId = getAdminUserId(c);

    await db.execute(
      `INSERT INTO flows (
        id, tenant_id, client_id, profile_id, name, description, graph_definition,
        compiled_plan, version, is_active, is_builtin, created_by, created_at, updated_by,
        updated_at, slug, display_name, kind, status, draft_editor_json, draft_runtime_base_json,
        template_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        flowId,
        tenantId,
        null,
        'human-basic',
        displayName,
        body.description ?? null,
        JSON.stringify(editor),
        JSON.stringify(runtime),
        '1.0.0',
        body.status === 'disabled' ? 0 : 1,
        0,
        adminUserId,
        now,
        adminUserId,
        now,
        slug,
        displayName,
        kind,
        body.status ?? 'draft',
        JSON.stringify(editor),
        JSON.stringify(runtime),
        body.template_id ?? null,
      ]
    );

    await createAuditLogFromContext(asBaseContext(c), 'flow_create', 'flow', flowId, {
      slug,
      kind,
    });

    return c.json(
      {
        flow: rowToFlow({
          id: flowId,
          tenant_id: tenantId,
          client_id: null,
          profile_id: 'human-basic',
          name: displayName,
          description: body.description ?? null,
          graph_definition: JSON.stringify(editor),
          compiled_plan: JSON.stringify(runtime),
          version: '1.0.0',
          is_active: body.status === 'disabled' ? 0 : 1,
          is_builtin: 0,
          created_by: adminUserId,
          created_at: now,
          updated_by: adminUserId,
          updated_at: now,
          slug,
          display_name: displayName,
          kind,
          status: body.status ?? 'draft',
          draft_editor_json: JSON.stringify(editor),
          draft_runtime_base_json: JSON.stringify(runtime),
          published_version_id: null,
          deleted_at: null,
          template_id: body.template_id ?? null,
        }),
        validation: splitIssues(issues),
      },
      201
    );
  } catch (error) {
    getLogger(asBaseContext(c))
      .module('ADMIN-FLOWS')
      .error('Failed to create flow', {}, error as Error);
    return c.json({ error: 'server_error', error_description: 'Failed to create flow' }, 500);
  }
}

export async function adminFlowUpdateHandler(c: AdminContext) {
  try {
    const tenantId = getTenantIdFromContext(asBaseContext(c));
    const db = getCoreAdapter(asBaseContext(c), tenantId);
    const flowId = getPathId(c);
    if (!flowId) {
      return invalidRequest(c, 'id is required');
    }
    const existing = await getFlowRow(db, tenantId, flowId);
    if (!existing) {
      return c.json({ error: 'not_found', error_description: 'Flow not found' }, 404);
    }
    if (existing.is_builtin === 1) {
      return c.json(
        { error: 'forbidden', error_description: 'Builtin flows cannot be modified' },
        403
      );
    }

    const body = await c.req.json<UpdateFlowBody>();
    const updates: string[] = [];
    const params: unknown[] = [];
    let nextKind = (existing.kind || 'login') as FlowKind;
    let nextEditor =
      parseJson<FlowEditorState | null>(existing.draft_editor_json, null) ??
      defaultEditorState(nextKind);
    let shouldRewriteRuntime = false;

    if (body.slug !== undefined) {
      const slug = normalizeSlug(body.slug);
      if (!slug) {
        return invalidRequest(c, 'slug is invalid');
      }
      if (await slugExists(db, tenantId, slug, flowId)) {
        return c.json(
          { error: 'conflict', error_description: 'A Flow with this slug already exists' },
          409
        );
      }
      updates.push('slug = ?');
      params.push(slug);
    }
    if (body.display_name !== undefined || body.name !== undefined) {
      const displayName = normalizeDisplayName(body.display_name ?? body.name);
      if (!displayName) {
        return invalidRequest(c, 'display_name is invalid');
      }
      updates.push('display_name = ?', 'name = ?');
      params.push(displayName, displayName);
    }
    if (body.description !== undefined) {
      updates.push('description = ?');
      params.push(body.description ?? null);
    }
    if (body.template_id !== undefined) {
      updates.push('template_id = ?');
      params.push(body.template_id ?? null);
    }
    if (body.kind !== undefined) {
      if (!isAllowedFlowKind(body.kind)) {
        return invalidRequest(c, 'kind is invalid');
      }
      nextKind = body.kind;
      shouldRewriteRuntime = true;
      updates.push('kind = ?');
      params.push(body.kind);
    }
    if (body.status !== undefined) {
      if (!isAllowedFlowStatus(body.status)) {
        return invalidRequest(c, 'status is invalid');
      }
      if (body.status === 'published') {
        return invalidRequest(c, 'Use the publish endpoint to publish a Flow');
      }
      updates.push('status = ?', 'is_active = ?');
      params.push(body.status, body.status === 'disabled' ? 0 : 1);
    }
    if (body.editor !== undefined) {
      nextEditor = body.editor;
      shouldRewriteRuntime = true;
      updates.push('draft_editor_json = ?', 'graph_definition = ?');
      params.push(JSON.stringify(body.editor), JSON.stringify(body.editor));
    }
    if (body.runtime !== undefined || shouldRewriteRuntime) {
      const nextRuntime = normalizeRuntime(
        flowId,
        nextKind,
        nextEditor,
        body.runtime ?? (shouldRewriteRuntime ? null : undefined)
      );
      updates.push('draft_runtime_base_json = ?', 'compiled_plan = ?');
      params.push(JSON.stringify(nextRuntime), JSON.stringify(nextRuntime));
    }

    if (updates.length === 0) {
      return c.json({ success: true });
    }

    const now = nowSeconds();
    const adminUserId = getAdminUserId(c);
    updates.push('updated_by = ?', 'updated_at = ?');
    params.push(adminUserId, now, tenantId, flowId);
    await db.execute(
      `UPDATE flows SET ${updates.join(', ')} WHERE tenant_id = ? AND id = ?`,
      params
    );

    await createAuditLogFromContext(asBaseContext(c), 'flow_update', 'flow', flowId, {
      fields: Object.keys(body),
    });

    const updated = await getFlowRow(db, tenantId, flowId);
    return c.json({ flow: updated ? rowToFlow(updated) : null });
  } catch (error) {
    getLogger(asBaseContext(c))
      .module('ADMIN-FLOWS')
      .error('Failed to update flow', {}, error as Error);
    return c.json({ error: 'server_error', error_description: 'Failed to update flow' }, 500);
  }
}

export async function adminFlowDeleteHandler(c: AdminContext) {
  try {
    const tenantId = getTenantIdFromContext(asBaseContext(c));
    const db = getCoreAdapter(asBaseContext(c), tenantId);
    const flowId = getPathId(c);
    if (!flowId) {
      return invalidRequest(c, 'id is required');
    }
    const existing = await getFlowRow(db, tenantId, flowId);
    if (!existing) {
      return c.json({ error: 'not_found', error_description: 'Flow not found' }, 404);
    }
    if (existing.is_builtin === 1) {
      return c.json(
        { error: 'forbidden', error_description: 'Builtin flows cannot be deleted' },
        403
      );
    }
    const assignment = await db.queryOne<{ id: string }>(
      'SELECT id FROM flow_assignments WHERE tenant_id = ? AND flow_id = ? LIMIT 1',
      [tenantId, flowId]
    );
    if (assignment) {
      return c.json(
        { error: 'conflict', error_description: 'Flow is assigned and cannot be deleted' },
        409
      );
    }

    const now = nowSeconds();
    await db.execute(
      'UPDATE flows SET deleted_at = ?, status = ?, is_active = 0, updated_at = ? WHERE tenant_id = ? AND id = ?',
      [now, 'disabled', now, tenantId, flowId]
    );
    await createAuditLogFromContext(asBaseContext(c), 'flow_delete', 'flow', flowId, {
      slug: existing.slug,
    });
    return c.json({ success: true });
  } catch (error) {
    getLogger(asBaseContext(c))
      .module('ADMIN-FLOWS')
      .error('Failed to delete flow', {}, error as Error);
    return c.json({ error: 'server_error', error_description: 'Failed to delete flow' }, 500);
  }
}

export async function adminFlowValidateHandler(c: AdminContext) {
  try {
    const tenantId = getTenantIdFromContext(asBaseContext(c));
    const db = getCoreAdapter(asBaseContext(c), tenantId);
    const flowId = c.req.param('id');
    const body = await c.req
      .json<{ editor?: FlowEditorState; contract?: unknown }>()
      .catch((): { editor?: FlowEditorState; contract?: unknown } => ({}));

    if (body.contract) {
      return c.json(splitIssues(validateFlowRuntimeContractPackage(body.contract)));
    }

    let editor: FlowEditorState | undefined = body.editor;
    if (!editor && flowId) {
      const existing = await getFlowRow(db, tenantId, flowId);
      editor = existing
        ? parseJson<FlowEditorState | undefined>(existing.draft_editor_json, undefined)
        : undefined;
    }
    if (!editor) {
      return invalidRequest(c, 'editor is required');
    }

    return c.json(
      splitIssues([
        ...validateDraft(editor, true),
        ...(await validateDraftReferences(db, tenantId, editor)),
      ])
    );
  } catch (error) {
    getLogger(asBaseContext(c))
      .module('ADMIN-FLOWS')
      .error('Failed to validate flow', {}, error as Error);
    return c.json({ error: 'server_error', error_description: 'Failed to validate flow' }, 500);
  }
}

export async function adminFlowPublishHandler(c: AdminContext) {
  try {
    const tenantId = getTenantIdFromContext(asBaseContext(c));
    const db = getCoreAdapter(asBaseContext(c), tenantId);
    const flowId = getPathId(c);
    if (!flowId) {
      return invalidRequest(c, 'id is required');
    }
    const existing = await getFlowRow(db, tenantId, flowId);
    if (!existing) {
      return c.json({ error: 'not_found', error_description: 'Flow not found' }, 404);
    }

    const editor = parseJson<FlowEditorState | null>(existing.draft_editor_json, null);
    if (!editor) {
      return invalidRequest(c, 'Flow draft editor state is missing');
    }

    const kind = (existing.kind || 'login') as FlowKind;
    const runtime = normalizeRuntime(
      flowId,
      kind,
      editor,
      parseJson<FlowRuntimeContract | null>(existing.draft_runtime_base_json, null)
    );
    const validation = splitIssues([
      ...validateDraft(editor, true),
      ...validateRuntimePackage(runtime, editor),
      ...(await validateDraftReferences(db, tenantId, editor)),
    ]);
    if (!validation.valid) {
      return c.json(
        {
          error: 'invalid_flow',
          error_description: 'Flow has publish-blocking validation errors',
          validation,
        },
        400
      );
    }

    const latest = await db.queryOne<{ version_number: number }>(
      'SELECT MAX(version_number) AS version_number FROM flow_versions WHERE tenant_id = ? AND flow_id = ?',
      [tenantId, flowId]
    );
    const nextVersion = Number(latest?.version_number ?? 0) + 1;
    const versionId = generateId();
    const now = nowSeconds();
    const adminUserId = getAdminUserId(c);

    await db.transaction(async (tx) => {
      await tx.execute(
        `INSERT INTO flow_versions (
          id, tenant_id, flow_id, version_number, schema_version, runtime_snapshot_json,
          editor_snapshot_json, validation_result_json, published_by, published_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          versionId,
          tenantId,
          flowId,
          nextVersion,
          FLOW_RUNTIME_CONTRACT_SCHEMA_VERSION,
          JSON.stringify(runtime),
          JSON.stringify(editor),
          JSON.stringify(validation),
          adminUserId,
          now,
          now,
        ]
      );

      await tx.execute(
        `UPDATE flows
         SET status = ?, is_active = 1, published_version_id = ?, updated_by = ?, updated_at = ?
         WHERE tenant_id = ? AND id = ?`,
        ['published', versionId, adminUserId, now, tenantId, flowId]
      );
    });

    await createAuditLogFromContext(asBaseContext(c), 'flow_publish', 'flow', flowId, {
      flow_version_id: versionId,
      version_number: nextVersion,
    });

    return c.json({
      version: {
        id: versionId,
        version_number: nextVersion,
        flow_id: flowId,
        schema_version: FLOW_RUNTIME_CONTRACT_SCHEMA_VERSION,
        published_at: now,
      },
      validation,
    });
  } catch (error) {
    getLogger(asBaseContext(c))
      .module('ADMIN-FLOWS')
      .error('Failed to publish flow', {}, error as Error);
    return c.json({ error: 'server_error', error_description: 'Failed to publish flow' }, 500);
  }
}

export async function adminFlowVersionsHandler(c: BaseContext) {
  try {
    const tenantId = getTenantIdFromContext(c);
    const db = getCoreAdapter(c, tenantId);
    const flowId = getPathId(c);
    if (!flowId) {
      return invalidRequest(c, 'id is required');
    }
    const rows = await db.query<FlowVersionRow>(
      'SELECT * FROM flow_versions WHERE tenant_id = ? AND flow_id = ? ORDER BY version_number DESC',
      [tenantId, flowId]
    );
    return c.json({ versions: rows.map(rowToVersion) });
  } catch (error) {
    getLogger(c)
      .module('ADMIN-FLOWS')
      .error('Failed to list flow versions', {}, error as Error);
    return c.json(
      { error: 'server_error', error_description: 'Failed to list flow versions' },
      500
    );
  }
}

export async function adminFlowExportHandler(c: BaseContext) {
  try {
    const tenantId = getTenantIdFromContext(c);
    const db = getCoreAdapter(c, tenantId);
    const flowId = getPathId(c);
    if (!flowId) {
      return invalidRequest(c, 'id is required');
    }
    const row = await getFlowRow(db, tenantId, flowId);
    if (!row) {
      return c.json({ error: 'not_found', error_description: 'Flow not found' }, 404);
    }
    const editor = parseJson<FlowEditorState | null>(row.draft_editor_json, null);
    const kind = (row.kind || 'login') as FlowKind;
    const runtime = normalizeRuntime(
      flowId,
      kind,
      editor ?? defaultEditorState(kind),
      parseJson<FlowRuntimeContract | null>(row.draft_runtime_base_json, null)
    );
    const payload: FlowRuntimeContractPackage = {
      schema_version: FLOW_RUNTIME_CONTRACT_SCHEMA_VERSION,
      mode: 'export',
      runtime,
      preview: {
        flow_id: row.id,
        slug: row.slug ?? row.id,
        display_name: row.display_name ?? row.name,
        template_id: row.template_id ?? null,
      },
      editor: editor ?? defaultEditorState(kind),
    };
    return c.json(payload);
  } catch (error) {
    getLogger(c)
      .module('ADMIN-FLOWS')
      .error('Failed to export flow', {}, error as Error);
    return c.json({ error: 'server_error', error_description: 'Failed to export flow' }, 500);
  }
}

export async function adminFlowImportHandler(c: AdminContext) {
  try {
    const tenantId = getTenantIdFromContext(asBaseContext(c));
    const db = getCoreAdapter(asBaseContext(c), tenantId);
    const raw = await c.req.json<unknown>();
    const sanitized = sanitizeImportedFlowContract(raw);
    const validation = splitIssues(validateFlowRuntimeContractPackage(sanitized));
    if (!validation.valid) {
      return c.json(
        {
          error: 'invalid_flow_import',
          error_description: 'Imported Flow JSON is invalid',
          validation,
        },
        400
      );
    }
    const payload = sanitized as FlowRuntimeContractPackage;
    const flowId = generateId();
    const now = nowSeconds();
    const kind = payload.runtime.flow_kind;
    if (!isAllowedFlowKind(kind)) {
      return invalidRequest(c, 'Imported Flow kind is invalid');
    }
    const displayName = normalizeDisplayName(payload.preview?.display_name) ?? 'Imported Flow';
    const slug = await makeUniqueSlug(
      db,
      tenantId,
      typeof payload.preview?.slug === 'string' ? payload.preview.slug : `${displayName}-${flowId}`
    );
    const editor = payload.editor ?? defaultEditorState(kind);
    const runtime = normalizeRuntime(flowId, kind, editor, payload.runtime);
    const adminUserId = getAdminUserId(c);

    await db.execute(
      `INSERT INTO flows (
        id, tenant_id, client_id, profile_id, name, description, graph_definition,
        compiled_plan, version, is_active, is_builtin, created_by, created_at, updated_by,
        updated_at, slug, display_name, kind, status, draft_editor_json, draft_runtime_base_json,
        template_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        flowId,
        tenantId,
        null,
        'human-basic',
        displayName,
        null,
        JSON.stringify(editor),
        JSON.stringify(runtime),
        '1.0.0',
        1,
        0,
        adminUserId,
        now,
        adminUserId,
        now,
        slug,
        displayName,
        kind,
        'draft',
        JSON.stringify(editor),
        JSON.stringify(runtime),
        typeof payload.preview?.template_id === 'string' ? payload.preview.template_id : null,
      ]
    );

    await createAuditLogFromContext(asBaseContext(c), 'flow_import', 'flow', flowId, {
      slug,
      kind,
    });

    return c.json(
      {
        flow_id: flowId,
        validation,
      },
      201
    );
  } catch (error) {
    getLogger(asBaseContext(c))
      .module('ADMIN-FLOWS')
      .error('Failed to import flow', {}, error as Error);
    return c.json({ error: 'server_error', error_description: 'Failed to import flow' }, 500);
  }
}

export async function adminFlowAssignmentsListHandler(c: BaseContext) {
  try {
    const tenantId = getTenantIdFromContext(c);
    const db = getCoreAdapter(c, tenantId);
    const { flow_id, target_type, target_id } = c.req.query();
    const where: string[] = ['tenant_id = ?'];
    const params: unknown[] = [tenantId];
    if (flow_id) {
      where.push('flow_id = ?');
      params.push(flow_id);
    }
    if (target_type) {
      if (!isAllowedAssignmentTargetType(target_type)) {
        return invalidRequest(c, 'target_type is invalid');
      }
      where.push('target_type = ?');
      params.push(target_type);
    }
    if (target_id) {
      where.push('target_id = ?');
      params.push(target_id);
    }
    const rows = await db.query<FlowAssignmentRow>(
      `SELECT * FROM flow_assignments WHERE ${where.join(' AND ')} ORDER BY target_type, target_id`,
      params
    );
    return c.json({ assignments: rows.map(rowToAssignment) });
  } catch (error) {
    getLogger(c)
      .module('ADMIN-FLOWS')
      .error('Failed to list flow assignments', {}, error as Error);
    return c.json(
      { error: 'server_error', error_description: 'Failed to list flow assignments' },
      500
    );
  }
}

export async function adminFlowAssignmentUpsertHandler(c: AdminContext) {
  try {
    const tenantId = getTenantIdFromContext(asBaseContext(c));
    const db = getCoreAdapter(asBaseContext(c), tenantId);
    const body = await c.req.json<{
      target_type: FlowAssignmentTargetType;
      target_id?: string | null;
      flow_kind: FlowKind;
      flow_id: string;
      enabled?: boolean;
    }>();

    if (!body.target_type || !body.flow_kind || !body.flow_id) {
      return invalidRequest(c, 'target_type, flow_kind, and flow_id are required');
    }
    if (!isAllowedAssignmentTargetType(body.target_type)) {
      return invalidRequest(c, 'target_type is invalid');
    }
    if (!isAllowedFlowKind(body.flow_kind)) {
      return invalidRequest(c, 'flow_kind is invalid');
    }
    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
      return invalidRequest(c, 'enabled must be a boolean');
    }
    const rawTargetId =
      typeof body.target_id === 'string' ? body.target_id.trim() : (body.target_id ?? null);
    const targetId = body.target_type === 'tenant' ? null : rawTargetId;
    if (body.target_type !== 'tenant' && (typeof targetId !== 'string' || targetId.length === 0)) {
      return invalidRequest(c, 'target_id is required for Client/SP Flow assignments');
    }

    const flow = await getFlowRow(db, tenantId, body.flow_id);
    if (!flow) {
      return c.json({ error: 'not_found', error_description: 'Flow not found' }, 404);
    }
    if ((flow.kind || 'login') !== body.flow_kind) {
      return invalidRequest(c, 'Assigned Flow kind does not match flow_kind');
    }
    if (body.enabled !== false && (flow.status !== 'published' || !flow.published_version_id)) {
      return invalidRequest(c, 'Only published Flows can be enabled for runtime assignment');
    }

    const now = nowSeconds();
    const enabled = body.enabled !== false ? 1 : 0;

    await db.execute(
      body.target_type === 'tenant'
        ? `DELETE FROM flow_assignments
           WHERE tenant_id = ? AND target_type = ? AND target_id IS NULL AND flow_kind = ?`
        : `DELETE FROM flow_assignments
           WHERE tenant_id = ? AND target_type = ? AND target_id = ? AND flow_kind = ?`,
      body.target_type === 'tenant'
        ? [tenantId, body.target_type, body.flow_kind]
        : [tenantId, body.target_type, targetId, body.flow_kind]
    );
    await db.execute(
      `INSERT INTO flow_assignments (
        id, tenant_id, target_type, target_id, flow_kind, flow_id, enabled, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        generateId(),
        tenantId,
        body.target_type,
        targetId,
        body.flow_kind,
        body.flow_id,
        enabled,
        now,
        now,
      ]
    );

    await createAuditLogFromContext(
      asBaseContext(c),
      'flow_assignment_upsert',
      'flow',
      body.flow_id,
      {
        target_type: body.target_type,
        target_id: targetId,
        flow_kind: body.flow_kind,
        enabled: enabled === 1,
      }
    );

    return c.json({ success: true });
  } catch (error) {
    getLogger(asBaseContext(c))
      .module('ADMIN-FLOWS')
      .error('Failed to upsert flow assignment', {}, error as Error);
    return c.json(
      { error: 'server_error', error_description: 'Failed to upsert flow assignment' },
      500
    );
  }
}

export async function adminFlowAssignmentDeleteHandler(c: AdminContext) {
  try {
    const tenantId = getTenantIdFromContext(asBaseContext(c));
    const db = getCoreAdapter(asBaseContext(c), tenantId);
    const body = await c.req.json<{
      target_type: FlowAssignmentTargetType;
      target_id?: string | null;
      flow_kind: FlowKind;
    }>();

    if (!body.target_type || !body.flow_kind) {
      return invalidRequest(c, 'target_type and flow_kind are required');
    }
    if (!isAllowedAssignmentTargetType(body.target_type)) {
      return invalidRequest(c, 'target_type is invalid');
    }
    if (!isAllowedFlowKind(body.flow_kind)) {
      return invalidRequest(c, 'flow_kind is invalid');
    }

    const rawTargetId =
      typeof body.target_id === 'string' ? body.target_id.trim() : (body.target_id ?? null);
    const targetId = body.target_type === 'tenant' ? null : rawTargetId;
    if (body.target_type !== 'tenant' && (typeof targetId !== 'string' || targetId.length === 0)) {
      return invalidRequest(c, 'target_id is required for Client/SP Flow assignments');
    }

    await db.execute(
      body.target_type === 'tenant'
        ? `DELETE FROM flow_assignments
           WHERE tenant_id = ? AND target_type = ? AND target_id IS NULL AND flow_kind = ?`
        : `DELETE FROM flow_assignments
           WHERE tenant_id = ? AND target_type = ? AND target_id = ? AND flow_kind = ?`,
      body.target_type === 'tenant'
        ? [tenantId, body.target_type, body.flow_kind]
        : [tenantId, body.target_type, targetId, body.flow_kind]
    );

    await createAuditLogFromContext(
      asBaseContext(c),
      'flow_assignment_delete',
      'flow_assignment',
      `${body.target_type}:${targetId ?? 'tenant'}:${body.flow_kind}`,
      {
        target_type: body.target_type,
        target_id: targetId,
        flow_kind: body.flow_kind,
      }
    );

    return c.json({ success: true });
  } catch (error) {
    getLogger(asBaseContext(c))
      .module('ADMIN-FLOWS')
      .error('Failed to delete flow assignment', {}, error as Error);
    return c.json(
      { error: 'server_error', error_description: 'Failed to delete flow assignment' },
      500
    );
  }
}

export async function adminFlowNodeTypesHandler(c: BaseContext) {
  return c.json({
    node_types: FLOW_NODE_DEFINITIONS,
  });
}

export async function adminFlowCopyHandler(c: AdminContext) {
  try {
    const tenantId = getTenantIdFromContext(asBaseContext(c));
    const db = getCoreAdapter(asBaseContext(c), tenantId);
    const flowId = getPathId(c);
    if (!flowId) {
      return invalidRequest(c, 'id is required');
    }
    const row = await getFlowRow(db, tenantId, flowId);
    if (!row) {
      return c.json({ error: 'not_found', error_description: 'Flow not found' }, 404);
    }
    const body = await c.req
      .json<{ display_name?: string; slug?: string }>()
      .catch((): { display_name?: string; slug?: string } => ({}));
    const source = rowToFlow(row);
    const kind = source.kind;
    const displayName = normalizeDisplayName(body.display_name) ?? `${source.display_name} Copy`;
    const explicitSlug = typeof body.slug === 'string' && body.slug.trim().length > 0;
    const slug =
      explicitSlug && typeof body.slug === 'string'
        ? normalizeSlug(body.slug)
        : await makeUniqueSlug(db, tenantId, `${source.slug}-copy`);
    if (!slug) {
      return invalidRequest(c, 'slug is invalid');
    }
    if (explicitSlug && (await slugExists(db, tenantId, slug))) {
      return c.json(
        { error: 'conflict', error_description: 'A Flow with this slug already exists' },
        409
      );
    }

    const newFlowId = generateId();
    const now = nowSeconds();
    const adminUserId = getAdminUserId(c);
    const editor = source.editor ?? defaultEditorState(kind);
    const runtime = normalizeRuntime(newFlowId, kind, editor, source.runtime);
    const validation = splitIssues(validateDraft(editor, false));

    await db.execute(
      `INSERT INTO flows (
        id, tenant_id, client_id, profile_id, name, description, graph_definition,
        compiled_plan, version, is_active, is_builtin, created_by, created_at, updated_by,
        updated_at, slug, display_name, kind, status, draft_editor_json, draft_runtime_base_json,
        template_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        newFlowId,
        tenantId,
        null,
        'human-basic',
        displayName,
        source.description,
        JSON.stringify(editor),
        JSON.stringify(runtime),
        '1.0.0',
        1,
        0,
        adminUserId,
        now,
        adminUserId,
        now,
        slug,
        displayName,
        kind,
        'draft',
        JSON.stringify(editor),
        JSON.stringify(runtime),
        source.template_id,
      ]
    );

    await createAuditLogFromContext(asBaseContext(c), 'flow_copy', 'flow', newFlowId, {
      source_flow_id: flowId,
      slug,
      kind,
    });

    const copied = await getFlowRow(db, tenantId, newFlowId);
    return c.json({ flow: copied ? rowToFlow(copied) : null, validation }, 201);
  } catch (error) {
    getLogger(asBaseContext(c))
      .module('ADMIN-FLOWS')
      .error('Failed to copy flow', {}, error as Error);
    return c.json({ error: 'server_error', error_description: 'Failed to copy flow' }, 500);
  }
}

export async function adminFlowCompileHandler(c: AdminContext) {
  return adminFlowPublishHandler(c);
}
