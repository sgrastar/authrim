/**
 * Admin Policies API
 *
 * Handlers for managing policy rules and simulations.
 */

import { Context } from 'hono';
import type { Env, AdminAuthContext } from '@authrim/ar-lib-core';
import {
  createAuthContextFromHono,
  type DatabaseAdapter,
  generateId,
  getTenantIdFromContext,
  createAuditLogFromContext,
  getLogger,
  readPolicyFlags,
} from '@authrim/ar-lib-core';
import {
  CHECK_API_CONDITION_TYPES,
  evaluateTenantRules,
  tenantRulesUnusableReason,
  toTenantPolicyRule,
  validatePolicyConditions,
  type TenantPolicyRule,
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

function getCoreAdapter(c: BaseContext, tenantId: string): DatabaseAdapter {
  return createAuthContextFromHono(c, tenantId).coreAdapter;
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
    const db = getCoreAdapter(c, tenantId);

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
    const db = getCoreAdapter(c, tenantId);
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
 * Why a rule as sent could not be evaluated as written, or null. The Check API refuses to grant
 * from a tenant's rules while one of them cannot be evaluated (a deny that never applies could
 * let a later allow through), so such a rule is not saved.
 */
function validatePolicyRuleBody(body: {
  priority?: unknown;
  effect?: unknown;
  resource_types?: unknown;
  actions?: unknown;
  conditions?: unknown;
}): string | null {
  if (body.priority !== undefined && !Number.isSafeInteger(body.priority)) {
    return 'priority must be an integer';
  }
  if (body.effect !== undefined && body.effect !== 'allow' && body.effect !== 'deny') {
    return 'effect must be allow or deny';
  }
  for (const field of ['resource_types', 'actions'] as const) {
    const value = body[field];
    if (
      value !== undefined &&
      (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string'))
    ) {
      return `${field} must be an array of strings`;
    }
  }
  if (body.conditions !== undefined) {
    // The rules are the tenant's custom rules of the Check API: only conditions it can evaluate.
    return validatePolicyConditions(body.conditions, CHECK_API_CONDITION_TYPES, {
      expiredAttributesKnown: false,
    });
  }
  return null;
}

/**
 * Create policy rule
 */
export async function adminPolicyCreateHandler(c: AdminContext) {
  try {
    const tenantId = getTenantIdFromContext(asBaseContext(c));
    const db = getCoreAdapter(asBaseContext(c), tenantId);
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

    // Left out: no conditions. Sent as null (or anything else not an array): refused.
    const conditions = body.conditions === undefined ? [] : body.conditions;
    const createProblem = validatePolicyRuleBody({ ...body, conditions });
    if (createProblem) {
      return c.json({ error: 'invalid_request', error_description: createProblem }, 400);
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
        JSON.stringify(conditions),
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
    const db = getCoreAdapter(asBaseContext(c), tenantId);
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

    const updateProblem = validatePolicyRuleBody(body);
    if (updateProblem) {
      return c.json({ error: 'invalid_request', error_description: updateProblem }, 400);
    }

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
    const db = getCoreAdapter(asBaseContext(c), tenantId);
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
    const db = getCoreAdapter(asBaseContext(c), tenantId);

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

    if (
      typeof body.context.resource?.type !== 'string' ||
      typeof body.context.action?.name !== 'string'
    ) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'context.resource.type and context.action.name are required',
        },
        400
      );
    }

    // As checks decide: the tenant's settings first (read fresh; unreadable settings are not
    // "off"), then the rules as stored, then the rules for the resource type and action.
    const flags = await readPolicyFlags(asBaseContext(c).env, tenantId, { fresh: true });
    if (!flags) {
      return c.json(
        {
          error: 'settings_unavailable',
          error_description: 'The policy settings could not be read',
        },
        503
      );
    }
    const verifiedAttributes = flags.abac && flags.verifiedAttributes;
    const rules: TenantPolicyRule[] = [];
    const unusable: string[] = [];
    for (const row of rows) {
      const rule = toTenantPolicyRule(row);
      if (rule) rules.push(rule);
      else unusable.push(row.id);
    }
    const unusableReason =
      unusable.length > 0
        ? 'Some rules cannot be evaluated as stored: checks grant nothing from the rules until they are fixed'
        : tenantRulesUnusableReason(rules, { verifiedAttributes });
    const decision: PolicyDecision =
      !flags.abac || !flags.customRules
        ? {
            allowed: false,
            reason:
              'Attribute-based policy or custom rules are off for this tenant: checks grant nothing from the rules',
            details: { abac: flags.abac, custom_rules: flags.customRules },
          }
        : unusableReason
          ? {
              allowed: false,
              reason: unusableReason,
              ...(unusable.length > 0 ? { details: { unusable_rules: unusable } } : {}),
            }
          : evaluateTenantRules(rules, {
              ...body.context,
              // Evaluated now unless the request says when (in UNIX milliseconds).
              timestamp:
                typeof body.context.timestamp === 'number' ? body.context.timestamp : Date.now(),
              // Checks do not load verified attributes while the settings keep them off.
              subject: verifiedAttributes
                ? body.context.subject
                : ({ ...body.context.subject, verifiedAttributes: [] } as PolicyContext['subject']),
            });

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
      evaluated_rules: rows.length,
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
    const db = getCoreAdapter(c, tenantId);

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
  // The Check API's tenant rules: only the conditions it can evaluate, with the parameter names
  // the policy engine reads (validatePolicyConditions checks the same on save).
  const scopeParams = [
    { name: 'scope', type: 'string', required: false, label: 'Scope (global, org or resource)' },
    {
      name: 'scopeTarget',
      type: 'string',
      required: false,
      label: 'Scope Target (e.g. org:org_123)',
    },
  ];
  const numeric = (type: string, label: string, description: string) => ({
    type,
    category: 'numeric',
    label,
    description,
    params: [
      { name: 'name', type: 'string', required: true, label: 'Attribute Name' },
      { name: 'value', type: 'number', required: true, label: 'Value' },
    ],
  });
  const conditionTypes = [
    // RBAC conditions
    {
      type: 'has_role',
      category: 'rbac',
      label: 'Has Role',
      description: 'Subject has a specific role',
      params: [
        { name: 'role', type: 'string', required: true, label: 'Role Name' },
        ...scopeParams,
      ],
    },
    {
      type: 'has_any_role',
      category: 'rbac',
      label: 'Has Any Role',
      description: 'Subject has any of the specified roles',
      params: [
        { name: 'roles', type: 'string[]', required: true, label: 'Role Names' },
        ...scopeParams,
      ],
    },
    {
      type: 'has_all_roles',
      category: 'rbac',
      label: 'Has All Roles',
      description: 'Subject has all specified roles',
      params: [
        { name: 'roles', type: 'string[]', required: true, label: 'Role Names' },
        ...scopeParams,
      ],
    },
    // Ownership conditions
    {
      type: 'is_resource_owner',
      category: 'ownership',
      label: 'Is Resource Owner',
      description: 'Subject owns the resource (from the check’s resource context)',
      params: [],
    },
    // ABAC conditions (the subject's verified attributes)
    {
      type: 'attribute_equals',
      category: 'abac',
      label: 'Attribute Equals',
      description: 'Subject attribute equals a specific value',
      params: [
        { name: 'name', type: 'string', required: true, label: 'Attribute Name' },
        { name: 'value', type: 'string', required: true, label: 'Expected Value' },
      ],
    },
    {
      type: 'attribute_exists',
      category: 'abac',
      label: 'Attribute Exists',
      description: 'Subject has the specified attribute',
      params: [{ name: 'name', type: 'string', required: true, label: 'Attribute Name' }],
    },
    {
      type: 'attribute_in',
      category: 'abac',
      label: 'Attribute In List',
      description: 'Subject attribute value is in a list',
      params: [
        { name: 'name', type: 'string', required: true, label: 'Attribute Name' },
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
        { name: 'startHour', type: 'number', required: true, label: 'Start Hour (0-23)' },
        { name: 'endHour', type: 'number', required: true, label: 'End Hour (0-24)' },
        { name: 'timezone', type: 'string', required: false, label: 'Timezone (IANA)' },
      ],
    },
    {
      type: 'day_of_week',
      category: 'time',
      label: 'Day of Week',
      description: 'Current day matches allowed days',
      params: [
        {
          name: 'allowedDays',
          type: 'number[]',
          required: true,
          label: 'Allowed Days (0=Sun, 6=Sat)',
        },
        { name: 'timezone', type: 'string', required: false, label: 'Timezone (IANA)' },
      ],
    },
    {
      type: 'valid_during',
      category: 'time',
      label: 'Valid During',
      description: 'Current time is within a date range',
      params: [
        { name: 'from', type: 'number', required: false, label: 'From (Unix seconds)' },
        { name: 'to', type: 'number', required: false, label: 'To (Unix seconds)' },
      ],
    },
    // Numeric conditions (the subject's verified attributes, read as numbers)
    numeric('numeric_gt', 'Greater Than', 'Attribute value > value'),
    numeric('numeric_gte', 'Greater Than or Equal', 'Attribute value >= value'),
    numeric('numeric_lt', 'Less Than', 'Attribute value < value'),
    numeric('numeric_lte', 'Less Than or Equal', 'Attribute value <= value'),
    numeric('numeric_eq', 'Equals', 'Attribute value = value'),
    {
      type: 'numeric_between',
      category: 'numeric',
      label: 'Between',
      description: 'Attribute value is between min and max',
      params: [
        { name: 'name', type: 'string', required: true, label: 'Attribute Name' },
        { name: 'min', type: 'number', required: true, label: 'Minimum' },
        { name: 'max', type: 'number', required: true, label: 'Maximum' },
      ],
    },
  ];

  const categories = [
    { id: 'rbac', label: 'Role-Based (RBAC)', icon: 'user-check' },
    { id: 'ownership', label: 'Ownership', icon: 'shield' },
    { id: 'abac', label: 'Attribute-Based (ABAC)', icon: 'tag' },
    { id: 'time', label: 'Time-Based', icon: 'clock' },
    { id: 'numeric', label: 'Numeric', icon: 'hash' },
  ];

  return c.json({ condition_types: conditionTypes, categories });
}
