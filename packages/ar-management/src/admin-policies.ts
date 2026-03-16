/**
 * Admin Policies API
 *
 * Handlers for managing policy rules and simulations.
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
import {
  PolicyEngine,
  type PolicyRule,
  type PolicyCondition,
  type PolicyContext,
  type PolicyDecision,
} from '@authrim/ar-lib-policy';

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

interface PolicyRuleRow {
  id: string;
  tenant_id: string;
  name: string;
  description: string | null;
  priority: number;
  effect: 'allow' | 'deny';
  resource_types: string | null;
  actions: string | null;
  conditions: string;
  enabled: number;
  created_by: string | null;
  created_at: number;
  updated_by: string | null;
  updated_at: number;
}

interface PolicySimulationRow {
  id: string;
  tenant_id: string;
  context: string;
  allowed: number;
  reason: string;
  decided_by: string | null;
  details: string | null;
  matched_rules: string | null;
  simulated_by: string | null;
  simulated_at: number;
}

// =============================================================================
// Helper Functions
// =============================================================================

function parseJsonArray(value: string | null): string[] {
  if (!value) return [];
  try {
    return JSON.parse(value);
  } catch {
    return [];
  }
}

function parseConditions(value: string): PolicyCondition[] {
  try {
    return JSON.parse(value);
  } catch {
    return [];
  }
}

function rowToPolicyRule(row: PolicyRuleRow): PolicyRule {
  return {
    id: row.id,
    name: row.name,
    description: row.description || undefined,
    priority: row.priority,
    effect: row.effect,
    conditions: parseConditions(row.conditions),
  };
}

function getAdminUserId(c: AdminContext): string | null {
  const adminAuth = c.get('adminAuth');
  return adminAuth?.userId ?? null;
}

// =============================================================================
// Handlers
// =============================================================================

/**
 * List policy rules
 */
export async function adminPoliciesListHandler(c: Context<{ Bindings: Env }>) {
  try {
    const tenantId = getTenantIdFromContext(c);
    const db = new D1Adapter({ db: c.env.DB });

    const { enabled, search, page = '1', limit = '20' } = c.req.query();

    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
    const offset = (pageNum - 1) * limitNum;

    const whereClauses: string[] = ['tenant_id = ?'];
    const params: unknown[] = [tenantId];

    if (enabled !== undefined) {
      whereClauses.push('enabled = ?');
      params.push(enabled === 'true' ? 1 : 0);
    }

    if (search) {
      whereClauses.push('(name LIKE ? OR description LIKE ?)');
      params.push(`%${search}%`, `%${search}%`);
    }

    const whereClause = ' WHERE ' + whereClauses.join(' AND ');

    // Get total count
    const countResult = await db.queryOne<{ count: number }>(
      `SELECT COUNT(*) as count FROM policy_rules ${whereClause}`,
      params
    );
    const total = countResult?.count || 0;

    // Get rules
    const rows = await db.query<PolicyRuleRow>(
      `SELECT * FROM policy_rules ${whereClause} ORDER BY priority DESC, created_at DESC LIMIT ? OFFSET ?`,
      [...params, limitNum, offset]
    );

    const rules = rows.map((row) => ({
      ...rowToPolicyRule(row),
      resource_types: parseJsonArray(row.resource_types),
      actions: parseJsonArray(row.actions),
      enabled: row.enabled === 1,
      created_by: row.created_by,
      created_at: row.created_at,
      updated_by: row.updated_by,
      updated_at: row.updated_at,
    }));

    return c.json({
      rules,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        total_pages: Math.ceil(total / limitNum),
      },
    });
  } catch (error) {
    const log = getLogger(c).module('ADMIN-POLICIES');
    log.error('Failed to list policies', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to list policies',
      },
      500
    );
  }
}

/**
 * Get policy rule by ID
 */
export async function adminPolicyGetHandler(c: Context<{ Bindings: Env }>) {
  try {
    const tenantId = getTenantIdFromContext(c);
    const db = new D1Adapter({ db: c.env.DB });
    const ruleId = c.req.param('id')!;

    const row = await db.queryOne<PolicyRuleRow>(
      'SELECT * FROM policy_rules WHERE tenant_id = ? AND id = ?',
      [tenantId, ruleId]
    );

    if (!row) {
      return c.json(
        {
          error: 'not_found',
          error_description: 'Policy rule not found',
        },
        404
      );
    }

    return c.json({
      rule: {
        ...rowToPolicyRule(row),
        resource_types: parseJsonArray(row.resource_types),
        actions: parseJsonArray(row.actions),
        enabled: row.enabled === 1,
        created_by: row.created_by,
        created_at: row.created_at,
        updated_by: row.updated_by,
        updated_at: row.updated_at,
      },
    });
  } catch (error) {
    const log = getLogger(c).module('ADMIN-POLICIES');
    log.error('Failed to get policy', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to get policy',
      },
      500
    );
  }
}

/**
 * Create policy rule
 */
export async function adminPolicyCreateHandler(c: AdminContext) {
  try {
    const tenantId = getTenantIdFromContext(asBaseContext(c));
    const db = new D1Adapter({ db: c.env.DB });
    const body = await c.req.json<{
      name: string;
      description?: string;
      priority?: number;
      effect: 'allow' | 'deny';
      resource_types?: string[];
      actions?: string[];
      conditions: PolicyCondition[];
      enabled?: boolean;
    }>();

    if (!body.name) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Name is required',
        },
        400
      );
    }

    if (!body.effect || !['allow', 'deny'].includes(body.effect)) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Valid effect is required',
        },
        400
      );
    }

    const ruleId = generateId();
    const now = Math.floor(Date.now() / 1000);
    const adminUserId = getAdminUserId(c);

    await db.execute(
      `INSERT INTO policy_rules (
        id, tenant_id, name, description, priority, effect,
        resource_types, actions, conditions, enabled,
        created_by, created_at, updated_by, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        ruleId,
        tenantId,
        body.name,
        body.description || null,
        body.priority ?? 100,
        body.effect,
        body.resource_types ? JSON.stringify(body.resource_types) : null,
        body.actions ? JSON.stringify(body.actions) : null,
        JSON.stringify(body.conditions || []),
        body.enabled !== false ? 1 : 0,
        adminUserId,
        now,
        adminUserId,
        now,
      ]
    );

    await createAuditLogFromContext(asBaseContext(c), 'policy_rule_create', 'policy_rule', ruleId, {
      name: body.name,
      effect: body.effect,
    });

    return c.json(
      {
        success: true,
        rule_id: ruleId,
      },
      201
    );
  } catch (error) {
    const log = getLogger(asBaseContext(c)).module('ADMIN-POLICIES');
    log.error('Failed to create policy', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to create policy',
      },
      500
    );
  }
}

/**
 * Update policy rule
 */
export async function adminPolicyUpdateHandler(c: AdminContext) {
  try {
    const tenantId = getTenantIdFromContext(asBaseContext(c));
    const db = new D1Adapter({ db: c.env.DB });
    const ruleId = c.req.param('id')!;

    // Check existence
    const existing = await db.queryOne<PolicyRuleRow>(
      'SELECT * FROM policy_rules WHERE tenant_id = ? AND id = ?',
      [tenantId, ruleId]
    );

    if (!existing) {
      return c.json(
        {
          error: 'not_found',
          error_description: 'Policy rule not found',
        },
        404
      );
    }

    const body = await c.req.json<{
      name?: string;
      description?: string;
      priority?: number;
      effect?: 'allow' | 'deny';
      resource_types?: string[];
      actions?: string[];
      conditions?: PolicyCondition[];
      enabled?: boolean;
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
    if (body.priority !== undefined) {
      updates.push('priority = ?');
      params.push(body.priority);
    }
    if (body.effect !== undefined) {
      updates.push('effect = ?');
      params.push(body.effect);
    }
    if (body.resource_types !== undefined) {
      updates.push('resource_types = ?');
      params.push(JSON.stringify(body.resource_types));
    }
    if (body.actions !== undefined) {
      updates.push('actions = ?');
      params.push(JSON.stringify(body.actions));
    }
    if (body.conditions !== undefined) {
      updates.push('conditions = ?');
      params.push(JSON.stringify(body.conditions));
    }
    if (body.enabled !== undefined) {
      updates.push('enabled = ?');
      params.push(body.enabled ? 1 : 0);
    }

    if (updates.length === 0) {
      return c.json({ success: true });
    }

    const adminUserId = getAdminUserId(c);
    const now = Math.floor(Date.now() / 1000);

    updates.push('updated_by = ?', 'updated_at = ?');
    params.push(adminUserId, now, tenantId, ruleId);

    await db.execute(
      `UPDATE policy_rules SET ${updates.join(', ')} WHERE tenant_id = ? AND id = ?`,
      params
    );

    await createAuditLogFromContext(asBaseContext(c), 'policy_rule_update', 'policy_rule', ruleId, {
      updates: Object.keys(body),
    });

    return c.json({ success: true });
  } catch (error) {
    const log = getLogger(asBaseContext(c)).module('ADMIN-POLICIES');
    log.error('Failed to update policy', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to update policy',
      },
      500
    );
  }
}

/**
 * Delete policy rule
 */
export async function adminPolicyDeleteHandler(c: AdminContext) {
  try {
    const tenantId = getTenantIdFromContext(asBaseContext(c));
    const db = new D1Adapter({ db: c.env.DB });
    const ruleId = c.req.param('id')!;

    // Check existence
    const existing = await db.queryOne<PolicyRuleRow>(
      'SELECT * FROM policy_rules WHERE tenant_id = ? AND id = ?',
      [tenantId, ruleId]
    );

    if (!existing) {
      return c.json(
        {
          error: 'not_found',
          error_description: 'Policy rule not found',
        },
        404
      );
    }

    await db.execute('DELETE FROM policy_rules WHERE tenant_id = ? AND id = ?', [tenantId, ruleId]);

    await createAuditLogFromContext(asBaseContext(c), 'policy_rule_delete', 'policy_rule', ruleId, {
      name: existing.name,
    });

    return c.json({ success: true });
  } catch (error) {
    const log = getLogger(asBaseContext(c)).module('ADMIN-POLICIES');
    log.error('Failed to delete policy', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to delete policy',
      },
      500
    );
  }
}

/**
 * Simulate policy evaluation
 */
export async function adminPolicySimulateHandler(c: AdminContext) {
  try {
    const tenantId = getTenantIdFromContext(asBaseContext(c));
    const db = new D1Adapter({ db: c.env.DB });

    const body = await c.req.json<{
      context: PolicyContext;
      save_history?: boolean;
    }>();

    if (!body.context) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Context is required',
        },
        400
      );
    }

    // Load enabled rules
    const rows = await db.query<PolicyRuleRow>(
      'SELECT * FROM policy_rules WHERE tenant_id = ? AND enabled = 1 ORDER BY priority DESC',
      [tenantId]
    );

    const rules: PolicyRule[] = rows.map(rowToPolicyRule);

    // Create engine and evaluate
    const engine = new PolicyEngine();
    engine.addRules(rules);
    const decision: PolicyDecision = engine.evaluate(body.context);

    // Optionally save simulation history
    if (body.save_history) {
      const simId = generateId();
      const now = Math.floor(Date.now() / 1000);
      const adminUserId = getAdminUserId(c);

      await db.execute(
        `INSERT INTO policy_simulations (
          id, tenant_id, context, allowed, reason, decided_by, details, matched_rules,
          simulated_by, simulated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          simId,
          tenantId,
          JSON.stringify(body.context),
          decision.allowed ? 1 : 0,
          decision.reason,
          decision.decidedBy || null,
          decision.details ? JSON.stringify(decision.details) : null,
          JSON.stringify(rules.map((r) => r.id)),
          adminUserId,
          now,
        ]
      );
    }

    return c.json({
      allowed: decision.allowed,
      reason: decision.reason,
      decided_by: decision.decidedBy,
      details: decision.details,
      evaluated_rules: rules.length,
    });
  } catch (error) {
    const log = getLogger(asBaseContext(c)).module('ADMIN-POLICIES');
    log.error('Failed to simulate policy', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to simulate policy',
      },
      500
    );
  }
}

/**
 * Get simulation history
 */
export async function adminPolicySimulationsHandler(c: Context<{ Bindings: Env }>) {
  try {
    const tenantId = getTenantIdFromContext(c);
    const db = new D1Adapter({ db: c.env.DB });

    const { page = '1', limit = '20' } = c.req.query();
    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
    const offset = (pageNum - 1) * limitNum;

    // Get total count
    const countResult = await db.queryOne<{ count: number }>(
      'SELECT COUNT(*) as count FROM policy_simulations WHERE tenant_id = ?',
      [tenantId]
    );
    const total = countResult?.count || 0;

    // Get simulations
    const rows = await db.query<PolicySimulationRow>(
      'SELECT * FROM policy_simulations WHERE tenant_id = ? ORDER BY simulated_at DESC LIMIT ? OFFSET ?',
      [tenantId, limitNum, offset]
    );

    const simulations = rows.map((row) => ({
      id: row.id,
      context: JSON.parse(row.context),
      allowed: row.allowed === 1,
      reason: row.reason,
      decided_by: row.decided_by,
      details: row.details ? JSON.parse(row.details) : null,
      simulated_by: row.simulated_by,
      simulated_at: row.simulated_at,
    }));

    return c.json({
      simulations,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        total_pages: Math.ceil(total / limitNum),
      },
    });
  } catch (error) {
    const log = getLogger(c).module('ADMIN-POLICIES');
    log.error('Failed to get simulations', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to get simulations',
      },
      500
    );
  }
}

/**
 * Get condition types metadata
 * Returns available condition types with their parameter definitions
 */
export async function adminConditionTypesHandler(c: Context<{ Bindings: Env }>) {
  const conditionTypes = [
    // RBAC conditions
    {
      type: 'has_role',
      category: 'rbac',
      label: 'Has Role',
      description: 'Subject has a specific role',
      params: [
        { name: 'role', type: 'string', required: true, label: 'Role Name' },
        { name: 'scope', type: 'string', required: false, label: 'Scope' },
      ],
    },
    {
      type: 'has_any_role',
      category: 'rbac',
      label: 'Has Any Role',
      description: 'Subject has any of the specified roles',
      params: [{ name: 'roles', type: 'string[]', required: true, label: 'Role Names' }],
    },
    {
      type: 'has_all_roles',
      category: 'rbac',
      label: 'Has All Roles',
      description: 'Subject has all specified roles',
      params: [{ name: 'roles', type: 'string[]', required: true, label: 'Role Names' }],
    },
    // Ownership conditions
    {
      type: 'is_resource_owner',
      category: 'ownership',
      label: 'Is Resource Owner',
      description: 'Subject owns the resource',
      params: [],
    },
    {
      type: 'same_organization',
      category: 'ownership',
      label: 'Same Organization',
      description: 'Subject and resource are in the same organization',
      params: [],
    },
    // ABAC conditions
    {
      type: 'attribute_equals',
      category: 'abac',
      label: 'Attribute Equals',
      description: 'Subject attribute equals a specific value',
      params: [
        { name: 'attribute', type: 'string', required: true, label: 'Attribute Name' },
        { name: 'value', type: 'string', required: true, label: 'Expected Value' },
      ],
    },
    {
      type: 'attribute_exists',
      category: 'abac',
      label: 'Attribute Exists',
      description: 'Subject has the specified attribute',
      params: [{ name: 'attribute', type: 'string', required: true, label: 'Attribute Name' }],
    },
    {
      type: 'attribute_in',
      category: 'abac',
      label: 'Attribute In List',
      description: 'Subject attribute value is in a list',
      params: [
        { name: 'attribute', type: 'string', required: true, label: 'Attribute Name' },
        { name: 'values', type: 'string[]', required: true, label: 'Allowed Values' },
      ],
    },
    // Time-based conditions
    {
      type: 'time_in_range',
      category: 'time',
      label: 'Time In Range',
      description: 'Current time is within a specific hour range',
      params: [
        { name: 'start_hour', type: 'number', required: true, label: 'Start Hour (0-23)' },
        { name: 'end_hour', type: 'number', required: true, label: 'End Hour (0-23)' },
        { name: 'timezone', type: 'string', required: false, label: 'Timezone' },
      ],
    },
    {
      type: 'day_of_week',
      category: 'time',
      label: 'Day of Week',
      description: 'Current day matches allowed days',
      params: [
        {
          name: 'days',
          type: 'number[]',
          required: true,
          label: 'Allowed Days (0=Sun, 6=Sat)',
        },
      ],
    },
    {
      type: 'valid_during',
      category: 'time',
      label: 'Valid During',
      description: 'Current time is within a date range',
      params: [
        { name: 'start', type: 'number', required: false, label: 'Start (Unix seconds)' },
        { name: 'end', type: 'number', required: false, label: 'End (Unix seconds)' },
      ],
    },
    // Numeric conditions
    {
      type: 'numeric_gt',
      category: 'numeric',
      label: 'Greater Than',
      description: 'Attribute value > threshold',
      params: [
        { name: 'attribute', type: 'string', required: true, label: 'Attribute Name' },
        { name: 'threshold', type: 'number', required: true, label: 'Threshold' },
      ],
    },
    {
      type: 'numeric_gte',
      category: 'numeric',
      label: 'Greater Than or Equal',
      description: 'Attribute value >= threshold',
      params: [
        { name: 'attribute', type: 'string', required: true, label: 'Attribute Name' },
        { name: 'threshold', type: 'number', required: true, label: 'Threshold' },
      ],
    },
    {
      type: 'numeric_lt',
      category: 'numeric',
      label: 'Less Than',
      description: 'Attribute value < threshold',
      params: [
        { name: 'attribute', type: 'string', required: true, label: 'Attribute Name' },
        { name: 'threshold', type: 'number', required: true, label: 'Threshold' },
      ],
    },
    {
      type: 'numeric_lte',
      category: 'numeric',
      label: 'Less Than or Equal',
      description: 'Attribute value <= threshold',
      params: [
        { name: 'attribute', type: 'string', required: true, label: 'Attribute Name' },
        { name: 'threshold', type: 'number', required: true, label: 'Threshold' },
      ],
    },
    {
      type: 'numeric_between',
      category: 'numeric',
      label: 'Between',
      description: 'Attribute value is between min and max',
      params: [
        { name: 'attribute', type: 'string', required: true, label: 'Attribute Name' },
        { name: 'min', type: 'number', required: true, label: 'Minimum' },
        { name: 'max', type: 'number', required: true, label: 'Maximum' },
      ],
    },
    // Geographic conditions
    {
      type: 'country_in',
      category: 'geo',
      label: 'Country In List',
      description: 'Request country code is in allowed list',
      params: [{ name: 'countries', type: 'string[]', required: true, label: 'Allowed Countries' }],
    },
    {
      type: 'country_not_in',
      category: 'geo',
      label: 'Country Not In List',
      description: 'Request country code is NOT in blocked list',
      params: [{ name: 'countries', type: 'string[]', required: true, label: 'Blocked Countries' }],
    },
    {
      type: 'ip_in_range',
      category: 'geo',
      label: 'IP In CIDR Range',
      description: 'Request IP is within CIDR range',
      params: [{ name: 'cidr', type: 'string', required: true, label: 'CIDR Range' }],
    },
    // Rate-based conditions
    {
      type: 'request_count_lt',
      category: 'rate',
      label: 'Request Count <',
      description: 'Request count is less than limit',
      params: [
        { name: 'key', type: 'string', required: true, label: 'Count Key' },
        { name: 'limit', type: 'number', required: true, label: 'Limit' },
      ],
    },
    {
      type: 'request_count_lte',
      category: 'rate',
      label: 'Request Count <=',
      description: 'Request count is less than or equal to limit',
      params: [
        { name: 'key', type: 'string', required: true, label: 'Count Key' },
        { name: 'limit', type: 'number', required: true, label: 'Limit' },
      ],
    },
  ];

  const categories = [
    { id: 'rbac', label: 'Role-Based (RBAC)', icon: 'user-check' },
    { id: 'ownership', label: 'Ownership', icon: 'shield' },
    { id: 'abac', label: 'Attribute-Based (ABAC)', icon: 'tag' },
    { id: 'time', label: 'Time-Based', icon: 'clock' },
    { id: 'numeric', label: 'Numeric', icon: 'hash' },
    { id: 'geo', label: 'Geographic', icon: 'globe' },
    { id: 'rate', label: 'Rate Limiting', icon: 'activity' },
  ];

  return c.json({ condition_types: conditionTypes, categories });
}
