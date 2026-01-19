/**
 * Admin Flows API
 *
 * Handlers for managing authentication/authorization flows.
 * Flows define the steps and capabilities required for different auth scenarios.
 */

import { Context } from 'hono';
import type { Env, AdminAuthContext } from '@authrim/ar-lib-core';
import {
  D1Adapter,
  generateId,
  getTenantIdFromContext,
  createAuditLogFromContext,
  getLogger,
} from '@authrim/ar-lib-core';
import type {
  GraphDefinition,
  GraphNode,
  GraphEdge,
  GraphNodeType,
  GraphEdgeType,
  CompiledPlan,
  CompiledNode,
  CompiledTransition,
} from '@authrim/ar-auth/flow-engine';
import { createFlowCompiler } from '@authrim/ar-auth/flow-engine';

// =============================================================================
// Types
// =============================================================================

/**
 * Hono context type with admin auth variable
 */
type AdminContext = Context<{ Bindings: Env; Variables: { adminAuth?: AdminAuthContext } }>;

/**
 * Base context type for functions that need simple Env bindings
 */
type BaseContext = Context<{ Bindings: Env }>;

/**
 * Cast AdminContext to BaseContext for functions that expect simpler context
 */
function asBaseContext(c: AdminContext): BaseContext {
  return c as unknown as BaseContext;
}

/**
 * Flow database row
 */
interface FlowRow {
  id: string;
  tenant_id: string;
  client_id: string | null;
  profile_id: string;
  name: string;
  description: string | null;
  graph_definition: string;
  compiled_plan: string | null;
  version: string;
  is_active: number;
  is_builtin: number;
  created_by: string | null;
  created_at: number;
  updated_by: string | null;
  updated_at: number;
}

/**
 * Profile ID type
 */
type ProfileId = 'human-basic' | 'human-org' | 'ai-agent' | 'iot-device';

/**
 * Node type metadata for UI
 */
interface NodeTypeMetadata {
  type: GraphNodeType;
  label: string;
  description: string;
  category: 'control' | 'input' | 'auth' | 'consent';
  color: string;
  icon: string;
  maxConnections: { inputs: number; outputs: number };
  hasErrorOutput: boolean;
}

// =============================================================================
// Constants
// =============================================================================

/**
 * Node type definitions for Flow Designer UI
 */
const NODE_TYPE_METADATA: NodeTypeMetadata[] = [
  {
    type: 'start',
    label: 'Start',
    description: 'Entry point of the flow',
    category: 'control',
    color: '#22c55e',
    icon: 'play',
    maxConnections: { inputs: 0, outputs: 1 },
    hasErrorOutput: false,
  },
  {
    type: 'identifier',
    label: 'Identifier Input',
    description: 'Collect user identifier (email, phone, username)',
    category: 'input',
    color: '#3b82f6',
    icon: 'user',
    maxConnections: { inputs: 1, outputs: 1 },
    hasErrorOutput: true,
  },
  {
    type: 'auth_method',
    label: 'Authentication',
    description: 'Verify user credentials (password, passkey, etc.)',
    category: 'auth',
    color: '#8b5cf6',
    icon: 'key',
    maxConnections: { inputs: 1, outputs: 1 },
    hasErrorOutput: true,
  },
  {
    type: 'mfa',
    label: 'MFA',
    description: 'Multi-factor authentication step',
    category: 'auth',
    color: '#f59e0b',
    icon: 'shield',
    maxConnections: { inputs: 1, outputs: 1 },
    hasErrorOutput: true,
  },
  {
    type: 'consent',
    label: 'Consent',
    description: 'User consent and scope approval',
    category: 'consent',
    color: '#06b6d4',
    icon: 'check-circle',
    maxConnections: { inputs: 1, outputs: 1 },
    hasErrorOutput: true,
  },
  {
    type: 'condition',
    label: 'Condition',
    description: 'Conditional branching based on context',
    category: 'control',
    color: '#ec4899',
    icon: 'git-branch',
    maxConnections: { inputs: 1, outputs: 3 },
    hasErrorOutput: false,
  },
  {
    type: 'end',
    label: 'End',
    description: 'Successful completion of the flow',
    category: 'control',
    color: '#10b981',
    icon: 'check',
    maxConnections: { inputs: 1, outputs: 0 },
    hasErrorOutput: false,
  },
  {
    type: 'error',
    label: 'Error',
    description: 'Error termination of the flow',
    category: 'control',
    color: '#ef4444',
    icon: 'x-circle',
    maxConnections: { inputs: 1, outputs: 0 },
    hasErrorOutput: false,
  },
];

// =============================================================================
// Helper Functions
// =============================================================================

function getAdminUserId(c: AdminContext): string | null {
  const adminAuth = c.get('adminAuth');
  return adminAuth?.userId ?? null;
}

function parseGraphDefinition(json: string): GraphDefinition | null {
  try {
    return JSON.parse(json) as GraphDefinition;
  } catch {
    return null;
  }
}

function parseCompiledPlan(json: string | null): Record<string, unknown> | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function rowToFlow(row: FlowRow): {
  id: string;
  tenant_id: string;
  client_id: string | null;
  profile_id: ProfileId;
  name: string;
  description: string | null;
  graph_definition: GraphDefinition | null;
  compiled_plan: Record<string, unknown> | null;
  version: string;
  is_active: boolean;
  is_builtin: boolean;
  created_by: string | null;
  created_at: number;
  updated_by: string | null;
  updated_at: number;
} {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    client_id: row.client_id,
    profile_id: row.profile_id as ProfileId,
    name: row.name,
    description: row.description,
    graph_definition: parseGraphDefinition(row.graph_definition),
    compiled_plan: parseCompiledPlan(row.compiled_plan),
    version: row.version,
    is_active: row.is_active === 1,
    is_builtin: row.is_builtin === 1,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_by: row.updated_by,
    updated_at: row.updated_at,
  };
}

/**
 * Validate GraphDefinition structure
 */
function validateGraphDefinition(
  graph: unknown
): { valid: true } | { valid: false; errors: string[] } {
  const errors: string[] = [];

  if (!graph || typeof graph !== 'object') {
    return { valid: false, errors: ['Graph definition must be an object'] };
  }

  const g = graph as Partial<GraphDefinition>;

  // Required fields
  if (!g.id || typeof g.id !== 'string') {
    errors.push('Graph definition must have a valid id');
  }
  if (!g.name || typeof g.name !== 'string') {
    errors.push('Graph definition must have a valid name');
  }
  if (!g.flowVersion || typeof g.flowVersion !== 'string') {
    errors.push('Graph definition must have a valid flowVersion');
  }
  if (!g.profileId || typeof g.profileId !== 'string') {
    errors.push('Graph definition must have a valid profileId');
  }
  if (!Array.isArray(g.nodes)) {
    errors.push('Graph definition must have a nodes array');
  }
  if (!Array.isArray(g.edges)) {
    errors.push('Graph definition must have an edges array');
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  // Validate nodes
  const nodeIds = new Set<string>();
  let hasStartNode = false;
  let hasEndNode = false;

  for (const node of g.nodes!) {
    if (!node.id || typeof node.id !== 'string') {
      errors.push('Each node must have a valid id');
      continue;
    }
    if (nodeIds.has(node.id)) {
      errors.push(`Duplicate node id: ${node.id}`);
    }
    nodeIds.add(node.id);

    const validTypes: GraphNodeType[] = [
      // 1. Control Nodes
      'start',
      'end',
      'goto',
      // 2. State/Check Nodes
      'check_session',
      'check_auth_level',
      'check_first_login',
      'check_user_attribute',
      'check_context',
      'check_risk',
      // 3. Selection/UI Nodes
      'auth_method_select',
      'login_method_select',
      'identifier',
      'profile_input',
      'custom_form',
      'information',
      'challenge',
      // 4. Authentication Nodes
      'login',
      'mfa',
      'register',
      // 5. Consent/Profile Nodes
      'consent',
      'check_consent_status',
      'record_consent',
      // 6. Resolve Nodes
      'resolve_tenant',
      'resolve_org',
      'resolve_policy',
      // 7. Session/Token Nodes
      'issue_tokens',
      'refresh_session',
      'revoke_session',
      'bind_device',
      'link_account',
      // 8. Side Effect Nodes
      'redirect',
      'webhook',
      'event_emit',
      'email_send',
      'sms_send',
      'push_notify',
      // 9. Logic/Decision Nodes
      'decision',
      'switch',
      // 10. Policy Nodes
      'policy_check',
      // 11. Error/Debug Nodes
      'error',
      'log',
      // Legacy (deprecated)
      'auth_method',
      'user_input',
      'condition',
      'check_user',
      'set_variable',
      'call_api',
      'send_notification',
      'risk_check',
      'wait_input',
    ];
    if (!validTypes.includes(node.type as GraphNodeType)) {
      errors.push(`Invalid node type: ${node.type}`);
    }

    if (node.type === 'start') hasStartNode = true;
    if (node.type === 'end') hasEndNode = true;
  }

  if (!hasStartNode) {
    errors.push('Graph must have a start node');
  }
  if (!hasEndNode) {
    errors.push('Graph must have an end node');
  }

  // Validate edges
  for (const edge of g.edges!) {
    if (!edge.id || typeof edge.id !== 'string') {
      errors.push('Each edge must have a valid id');
      continue;
    }
    if (!edge.source || !nodeIds.has(edge.source)) {
      errors.push(`Edge ${edge.id} has invalid source: ${edge.source}`);
    }
    if (!edge.target || !nodeIds.has(edge.target)) {
      errors.push(`Edge ${edge.id} has invalid target: ${edge.target}`);
    }

    const validEdgeTypes: GraphEdgeType[] = ['success', 'error', 'conditional'];
    if (edge.type && !validEdgeTypes.includes(edge.type as GraphEdgeType)) {
      errors.push(`Invalid edge type: ${edge.type}`);
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return { valid: true };
}

// =============================================================================
// Handlers
// =============================================================================

/**
 * List flows with pagination and filters
 */
export async function adminFlowsListHandler(c: Context<{ Bindings: Env }>) {
  try {
    const tenantId = getTenantIdFromContext(c);
    const db = new D1Adapter({ db: c.env.DB });

    const { profile_id, client_id, is_active, search, page = '1', limit = '20' } = c.req.query();

    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
    const offset = (pageNum - 1) * limitNum;

    const whereClauses: string[] = ['tenant_id = ?'];
    const params: unknown[] = [tenantId];

    if (profile_id) {
      whereClauses.push('profile_id = ?');
      params.push(profile_id);
    }

    if (client_id) {
      whereClauses.push('client_id = ?');
      params.push(client_id);
    } else if (client_id === '') {
      // Explicitly filter for tenant default flows (client_id IS NULL)
      whereClauses.push('client_id IS NULL');
    }

    if (is_active !== undefined) {
      whereClauses.push('is_active = ?');
      params.push(is_active === 'true' ? 1 : 0);
    }

    if (search) {
      whereClauses.push('(name LIKE ? OR description LIKE ?)');
      params.push(`%${search}%`, `%${search}%`);
    }

    const whereClause = ' WHERE ' + whereClauses.join(' AND ');

    // Get total count
    const countResult = await db.queryOne<{ count: number }>(
      `SELECT COUNT(*) as count FROM flows ${whereClause}`,
      params
    );
    const total = countResult?.count || 0;

    // Get flows
    const rows = await db.query<FlowRow>(
      `SELECT * FROM flows ${whereClause} ORDER BY is_builtin DESC, name ASC LIMIT ? OFFSET ?`,
      [...params, limitNum, offset]
    );

    const flows = rows.map(rowToFlow);

    return c.json({
      flows,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        total_pages: Math.ceil(total / limitNum),
      },
    });
  } catch (error) {
    const log = getLogger(c).module('ADMIN-FLOWS');
    log.error('Failed to list flows', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to list flows',
      },
      500
    );
  }
}

/**
 * Get flow by ID
 */
export async function adminFlowGetHandler(c: Context<{ Bindings: Env }>) {
  try {
    const tenantId = getTenantIdFromContext(c);
    const db = new D1Adapter({ db: c.env.DB });
    const flowId = c.req.param('id');

    const row = await db.queryOne<FlowRow>('SELECT * FROM flows WHERE tenant_id = ? AND id = ?', [
      tenantId,
      flowId,
    ]);

    if (!row) {
      return c.json(
        {
          error: 'not_found',
          error_description: 'Flow not found',
        },
        404
      );
    }

    return c.json({
      flow: rowToFlow(row),
    });
  } catch (error) {
    const log = getLogger(c).module('ADMIN-FLOWS');
    log.error('Failed to get flow', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to get flow',
      },
      500
    );
  }
}

/**
 * Create a new flow
 */
export async function adminFlowCreateHandler(c: AdminContext) {
  try {
    const tenantId = getTenantIdFromContext(asBaseContext(c));
    const db = new D1Adapter({ db: c.env.DB });

    const body = await c.req.json<{
      name: string;
      description?: string;
      profile_id: ProfileId;
      client_id?: string | null;
      graph_definition: GraphDefinition;
      version?: string;
      is_active?: boolean;
    }>();

    // Validate required fields
    if (!body.name) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Name is required',
        },
        400
      );
    }

    if (!body.profile_id) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Profile ID is required',
        },
        400
      );
    }

    const validProfiles: ProfileId[] = ['human-basic', 'human-org', 'ai-agent', 'iot-device'];
    if (!validProfiles.includes(body.profile_id)) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: `Invalid profile_id. Must be one of: ${validProfiles.join(', ')}`,
        },
        400
      );
    }

    if (!body.graph_definition) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Graph definition is required',
        },
        400
      );
    }

    // Validate graph definition
    const validation = validateGraphDefinition(body.graph_definition);
    if (!validation.valid) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Invalid graph definition',
          details: validation.errors,
        },
        400
      );
    }

    // Check for duplicate tenant+client+profile combination
    const existing = await db.queryOne<{ id: string }>(
      'SELECT id FROM flows WHERE tenant_id = ? AND client_id IS ? AND profile_id = ?',
      [tenantId, body.client_id || null, body.profile_id]
    );

    if (existing) {
      return c.json(
        {
          error: 'conflict',
          error_description: `A flow already exists for this tenant/client/profile combination`,
        },
        409
      );
    }

    const flowId = generateId();
    const now = Math.floor(Date.now() / 1000);
    const adminUserId = getAdminUserId(c);

    // Update graph definition with generated ID
    const graphDef: GraphDefinition = {
      ...body.graph_definition,
      id: flowId,
    };

    await db.execute(
      `INSERT INTO flows (
        id, tenant_id, client_id, profile_id, name, description,
        graph_definition, version, is_active, is_builtin,
        created_by, created_at, updated_by, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        flowId,
        tenantId,
        body.client_id || null,
        body.profile_id,
        body.name,
        body.description || null,
        JSON.stringify(graphDef),
        body.version || '1.0.0',
        body.is_active !== false ? 1 : 0,
        0, // Custom flows are not builtin
        adminUserId,
        now,
        adminUserId,
        now,
      ]
    );

    await createAuditLogFromContext(asBaseContext(c), 'flow_create', 'flow', flowId, {
      name: body.name,
      profile_id: body.profile_id,
    });

    return c.json(
      {
        success: true,
        flow_id: flowId,
      },
      201
    );
  } catch (error) {
    const log = getLogger(asBaseContext(c)).module('ADMIN-FLOWS');
    log.error('Failed to create flow', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to create flow',
      },
      500
    );
  }
}

/**
 * Update an existing flow
 */
export async function adminFlowUpdateHandler(c: AdminContext) {
  try {
    const tenantId = getTenantIdFromContext(asBaseContext(c));
    const db = new D1Adapter({ db: c.env.DB });
    const flowId = c.req.param('id');

    // Check existence
    const existing = await db.queryOne<FlowRow>(
      'SELECT * FROM flows WHERE tenant_id = ? AND id = ?',
      [tenantId, flowId]
    );

    if (!existing) {
      return c.json(
        {
          error: 'not_found',
          error_description: 'Flow not found',
        },
        404
      );
    }

    // Builtin flows cannot be modified
    if (existing.is_builtin === 1) {
      return c.json(
        {
          error: 'forbidden',
          error_description: 'Builtin flows cannot be modified',
        },
        403
      );
    }

    const body = await c.req.json<{
      name?: string;
      description?: string;
      graph_definition?: GraphDefinition;
      version?: string;
      is_active?: boolean;
    }>();

    const updates: string[] = [];
    const params: unknown[] = [];

    if (body.name !== undefined) {
      updates.push('name = ?');
      params.push(body.name);
    }
    if (body.description !== undefined) {
      updates.push('description = ?');
      params.push(body.description || null);
    }
    if (body.graph_definition !== undefined) {
      // Validate graph definition
      const validation = validateGraphDefinition(body.graph_definition);
      if (!validation.valid) {
        return c.json(
          {
            error: 'invalid_request',
            error_description: 'Invalid graph definition',
            details: validation.errors,
          },
          400
        );
      }

      // Preserve the original ID
      const graphDef: GraphDefinition = {
        ...body.graph_definition,
        id: flowId,
      };
      updates.push('graph_definition = ?');
      params.push(JSON.stringify(graphDef));

      // Clear compiled plan when graph changes
      updates.push('compiled_plan = ?');
      params.push(null);
    }
    if (body.version !== undefined) {
      updates.push('version = ?');
      params.push(body.version);
    }
    if (body.is_active !== undefined) {
      updates.push('is_active = ?');
      params.push(body.is_active ? 1 : 0);
    }

    if (updates.length === 0) {
      return c.json({ success: true });
    }

    const adminUserId = getAdminUserId(c);
    const now = Math.floor(Date.now() / 1000);

    updates.push('updated_by = ?', 'updated_at = ?');
    params.push(adminUserId, now, tenantId, flowId);

    await db.execute(
      `UPDATE flows SET ${updates.join(', ')} WHERE tenant_id = ? AND id = ?`,
      params
    );

    await createAuditLogFromContext(asBaseContext(c), 'flow_update', 'flow', flowId, {
      updates: Object.keys(body),
    });

    return c.json({ success: true });
  } catch (error) {
    const log = getLogger(asBaseContext(c)).module('ADMIN-FLOWS');
    log.error('Failed to update flow', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to update flow',
      },
      500
    );
  }
}

/**
 * Delete a flow
 */
export async function adminFlowDeleteHandler(c: AdminContext) {
  try {
    const tenantId = getTenantIdFromContext(asBaseContext(c));
    const db = new D1Adapter({ db: c.env.DB });
    const flowId = c.req.param('id');

    // Check existence
    const existing = await db.queryOne<FlowRow>(
      'SELECT * FROM flows WHERE tenant_id = ? AND id = ?',
      [tenantId, flowId]
    );

    if (!existing) {
      return c.json(
        {
          error: 'not_found',
          error_description: 'Flow not found',
        },
        404
      );
    }

    // Builtin flows cannot be deleted
    if (existing.is_builtin === 1) {
      return c.json(
        {
          error: 'forbidden',
          error_description: 'Builtin flows cannot be deleted',
        },
        403
      );
    }

    await db.execute('DELETE FROM flows WHERE tenant_id = ? AND id = ?', [tenantId, flowId]);

    await createAuditLogFromContext(asBaseContext(c), 'flow_delete', 'flow', flowId, {
      name: existing.name,
    });

    return c.json({ success: true });
  } catch (error) {
    const log = getLogger(asBaseContext(c)).module('ADMIN-FLOWS');
    log.error('Failed to delete flow', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to delete flow',
      },
      500
    );
  }
}

/**
 * Copy (duplicate) a flow
 */
export async function adminFlowCopyHandler(c: AdminContext) {
  try {
    const tenantId = getTenantIdFromContext(asBaseContext(c));
    const db = new D1Adapter({ db: c.env.DB });
    const flowId = c.req.param('id');

    // Get source flow
    const source = await db.queryOne<FlowRow>(
      'SELECT * FROM flows WHERE tenant_id = ? AND id = ?',
      [tenantId, flowId]
    );

    if (!source) {
      return c.json(
        {
          error: 'not_found',
          error_description: 'Flow not found',
        },
        404
      );
    }

    const body = await c.req.json<{
      name?: string;
      client_id?: string | null;
      profile_id?: ProfileId;
    }>();

    const newFlowId = generateId();
    const now = Math.floor(Date.now() / 1000);
    const adminUserId = getAdminUserId(c);
    const newName = body.name || `${source.name} (Copy)`;
    const newClientId = body.client_id !== undefined ? body.client_id : source.client_id;
    const newProfileId = body.profile_id || source.profile_id;

    // Check for duplicate
    const existing = await db.queryOne<{ id: string }>(
      'SELECT id FROM flows WHERE tenant_id = ? AND client_id IS ? AND profile_id = ?',
      [tenantId, newClientId, newProfileId]
    );

    if (existing) {
      return c.json(
        {
          error: 'conflict',
          error_description: 'A flow already exists for this tenant/client/profile combination',
        },
        409
      );
    }

    // Parse and update graph definition with new ID
    const graphDef = parseGraphDefinition(source.graph_definition);
    if (graphDef) {
      graphDef.id = newFlowId;
      graphDef.name = newName;
    }

    await db.execute(
      `INSERT INTO flows (
        id, tenant_id, client_id, profile_id, name, description,
        graph_definition, version, is_active, is_builtin,
        created_by, created_at, updated_by, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        newFlowId,
        tenantId,
        newClientId,
        newProfileId,
        newName,
        source.description,
        graphDef ? JSON.stringify(graphDef) : source.graph_definition,
        '1.0.0', // Reset version for copy
        1, // Active by default
        0, // Copies are not builtin
        adminUserId,
        now,
        adminUserId,
        now,
      ]
    );

    await createAuditLogFromContext(asBaseContext(c), 'flow_copy', 'flow', newFlowId, {
      source_flow_id: flowId,
      name: newName,
    });

    return c.json(
      {
        success: true,
        flow_id: newFlowId,
      },
      201
    );
  } catch (error) {
    const log = getLogger(asBaseContext(c)).module('ADMIN-FLOWS');
    log.error('Failed to copy flow', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to copy flow',
      },
      500
    );
  }
}

/**
 * Validate a flow definition
 */
export async function adminFlowValidateHandler(c: AdminContext) {
  try {
    const body = await c.req.json<{
      graph_definition: unknown;
    }>();

    if (!body.graph_definition) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Graph definition is required',
        },
        400
      );
    }

    const validation = validateGraphDefinition(body.graph_definition);

    if (validation.valid) {
      return c.json({
        valid: true,
        errors: [],
      });
    }

    return c.json({
      valid: false,
      errors: validation.errors,
    });
  } catch (error) {
    const log = getLogger(asBaseContext(c)).module('ADMIN-FLOWS');
    log.error('Failed to validate flow', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to validate flow',
      },
      500
    );
  }
}

/**
 * Serialize CompiledPlan to JSON-safe object
 * Converts Map to Record for JSON serialization
 */
function serializeCompiledPlan(plan: CompiledPlan): Record<string, unknown> {
  // Convert nodes Map to Record
  const nodesRecord: Record<string, CompiledNode> = {};
  plan.nodes.forEach((node, id) => {
    nodesRecord[id] = node;
  });

  // Convert transitions Map to Record
  const transitionsRecord: Record<string, CompiledTransition[]> = {};
  plan.transitions.forEach((transitions, id) => {
    transitionsRecord[id] = transitions;
  });

  return {
    id: plan.id,
    version: plan.version,
    sourceVersion: plan.sourceVersion,
    profileId: plan.profileId,
    entryNodeId: plan.entryNodeId,
    nodes: nodesRecord,
    transitions: transitionsRecord,
    compiledAt: plan.compiledAt,
  };
}

/**
 * Compile a flow definition to CompiledPlan
 */
export async function adminFlowCompileHandler(c: AdminContext) {
  try {
    const flowId = c.req.param('id');
    if (!flowId) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Flow ID is required',
        },
        400
      );
    }

    // Get tenantId from context
    const tenantId = getTenantIdFromContext(asBaseContext(c)) ?? 'default';

    // Get flow from database
    const db = new D1Adapter({ db: c.env.DB });
    const row = await db.queryOne<FlowRow>('SELECT * FROM flows WHERE id = ? AND tenant_id = ?', [
      flowId,
      tenantId,
    ]);

    if (!row) {
      return c.json(
        {
          error: 'not_found',
          error_description: 'Flow not found',
        },
        404
      );
    }

    // Parse graph definition
    const graphDef = parseGraphDefinition(row.graph_definition);
    if (!graphDef) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Invalid graph definition',
        },
        400
      );
    }

    // Compile the flow
    const compiler = createFlowCompiler();
    const compiledPlan = compiler.compile(graphDef);

    // Serialize for JSON response
    const serialized = serializeCompiledPlan(compiledPlan);

    return c.json({
      success: true,
      compiled_plan: serialized,
    });
  } catch (error) {
    const log = getLogger(asBaseContext(c)).module('ADMIN-FLOWS');
    log.error('Failed to compile flow', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: error instanceof Error ? error.message : 'Failed to compile flow',
      },
      500
    );
  }
}

/**
 * Get node type metadata for Flow Designer UI
 */
export async function adminFlowNodeTypesHandler(c: Context<{ Bindings: Env }>) {
  const categories = [
    { id: 'control', label: 'Control Flow', icon: 'git-branch' },
    { id: 'input', label: 'User Input', icon: 'edit' },
    { id: 'auth', label: 'Authentication', icon: 'key' },
    { id: 'consent', label: 'Consent', icon: 'check-circle' },
  ];

  const edgeTypes = [
    { type: 'success', label: 'Success', color: '#22c55e' },
    { type: 'error', label: 'Error', color: '#ef4444' },
    { type: 'conditional', label: 'Conditional', color: '#f59e0b' },
  ];

  return c.json({
    node_types: NODE_TYPE_METADATA,
    categories,
    edge_types: edgeTypes,
  });
}
