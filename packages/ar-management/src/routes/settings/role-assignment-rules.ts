/**
 * Role Assignment Rules Admin API
 *
 * CRUD operations for automatic role assignment rules based on IdP claims.
 *
 * POST   /api/admin/role-assignment-rules           - Create rule
 * GET    /api/admin/role-assignment-rules           - List rules
 * GET    /api/admin/role-assignment-rules/:id       - Get rule
 * PUT    /api/admin/role-assignment-rules/:id       - Update rule
 * DELETE /api/admin/role-assignment-rules/:id       - Delete rule
 * POST   /api/admin/role-assignment-rules/:id/test  - Test single rule
 * POST   /api/admin/role-assignment-rules/evaluate  - Evaluate all rules
 */

import type { Context } from 'hono';
import {
  D1Adapter,
  getLogger,
  type DatabaseAdapter,
  type RoleAssignmentRule,
  type RoleAssignmentRuleRow,
  type RoleAssignmentRuleInput,
  type RuleCondition,
  type CompoundCondition,
  type RuleAction,
  type RuleEvaluationContext,
  type ScopeType,
  createRuleEvaluator,
  testRuleAgainstContext,
  generateEmailDomainHash,
  getEmailDomainHashSecret,
} from '@authrim/ar-lib-core';

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_TENANT_ID = 'default';
const MAX_RULES_PER_PAGE = 100;

// =============================================================================
// Helpers
// =============================================================================

function rowToRule(row: RoleAssignmentRuleRow): RoleAssignmentRule {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    name: row.name,
    description: row.description ?? undefined,
    role_id: row.role_id,
    scope_type: row.scope_type as ScopeType,
    scope_target: row.scope_target,
    condition: JSON.parse(row.conditions_json) as RuleCondition | CompoundCondition,
    actions: JSON.parse(row.actions_json) as RuleAction[],
    priority: row.priority,
    is_active: true,
    stop_processing: row.stop_processing === 1,
    valid_from: row.valid_from ?? undefined,
    valid_until: row.valid_until ?? undefined,
    created_by: row.created_by ?? undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function validateRuleInput(input: RoleAssignmentRuleInput): string[] {
  const errors: string[] = [];

  if (!input.name || input.name.trim().length === 0) {
    errors.push('name is required');
  }

  if (!input.role_id || input.role_id.trim().length === 0) {
    errors.push('role_id is required');
  }

  if (!input.condition) {
    errors.push('condition is required');
  }

  if (!input.actions || !Array.isArray(input.actions) || input.actions.length === 0) {
    errors.push('actions is required and must be a non-empty array');
  }

  return errors;
}

// =============================================================================
// Handlers
// =============================================================================

/**
 * POST /api/admin/role-assignment-rules
 * Create a new role assignment rule
 */
export async function createRoleAssignmentRule(c: Context) {
  const log = getLogger(c).module('RoleAssignmentRulesAPI');
  const body = await c.req.json<RoleAssignmentRuleInput>();
  const tenantId = DEFAULT_TENANT_ID;

  // Validate input
  const errors = validateRuleInput(body);
  if (errors.length > 0) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: errors.join(', '),
      },
      400
    );
  }

  const id = `rar_${crypto.randomUUID().replace(/-/g, '')}`;
  const now = Math.floor(Date.now() / 1000);

  const coreAdapter: DatabaseAdapter = new D1Adapter({ db: c.env.DB });

  try {
    // Check if name already exists
    const existing = await coreAdapter.queryOne<{ id: string }>(
      'SELECT id FROM role_assignment_rules WHERE tenant_id = ? AND name = ?',
      [tenantId, body.name]
    );

    if (existing) {
      return c.json(
        {
          error: 'conflict',
          error_description: `Rule with name "${body.name}" already exists`,
        },
        409
      );
    }

    // Insert rule
    await coreAdapter.execute(
      `INSERT INTO role_assignment_rules (
        id, tenant_id, name, description, role_id, scope_type, scope_target,
        conditions_json, actions_json, priority, is_active, stop_processing,
        valid_from, valid_until, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        tenantId,
        body.name,
        body.description || null,
        body.role_id,
        body.scope_type || 'global',
        body.scope_target || '',
        JSON.stringify(body.condition),
        JSON.stringify(body.actions),
        body.priority ?? 0,
        body.is_active !== false ? 1 : 0,
        body.stop_processing ? 1 : 0,
        body.valid_from || null,
        body.valid_until || null,
        null, // created_by - TODO: get from context
        now,
        now,
      ]
    );

    // Invalidate cache
    if (c.env.SETTINGS) {
      try {
        await c.env.SETTINGS.delete(`role_assignment_rules_cache:${tenantId}`);
      } catch {
        // Ignore cache invalidation errors
      }
    }

    // Return created rule
    const rule: RoleAssignmentRule = {
      id,
      tenant_id: tenantId,
      name: body.name,
      description: body.description,
      role_id: body.role_id,
      scope_type: (body.scope_type || 'global') as ScopeType,
      scope_target: body.scope_target || '',
      condition: body.condition,
      actions: body.actions,
      priority: body.priority ?? 0,
      is_active: body.is_active !== false,
      stop_processing: body.stop_processing ?? false,
      valid_from: body.valid_from,
      valid_until: body.valid_until,
      created_at: now,
      updated_at: now,
    };

    return c.json(rule, 201);
  } catch (error) {
    log.error('Create error', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to create rule',
      },
      500
    );
  }
}

/**
 * GET /api/admin/role-assignment-rules
 * List all role assignment rules
 */
export async function listRoleAssignmentRules(c: Context) {
  const log = getLogger(c).module('RoleAssignmentRulesAPI');
  const tenantId = DEFAULT_TENANT_ID;
  const limit = Math.min(parseInt(c.req.query('limit') || '50', 10), MAX_RULES_PER_PAGE);
  const offset = parseInt(c.req.query('offset') || '0', 10);
  const isActive = c.req.query('is_active');

  const coreAdapter: DatabaseAdapter = new D1Adapter({ db: c.env.DB });

  try {
    let whereClause = 'WHERE tenant_id = ?';
    const values: unknown[] = [tenantId];

    if (isActive !== undefined) {
      whereClause += ' AND is_active = ?';
      values.push(isActive === 'true' ? 1 : 0);
    }

    // Get total count
    const countResult = await coreAdapter.queryOne<{ count: number }>(
      `SELECT COUNT(*) as count FROM role_assignment_rules ${whereClause}`,
      values
    );
    const total = countResult?.count ?? 0;

    // Get rules using D1 directly since DatabaseAdapter doesn't have queryAll
    const result = await c.env.DB.prepare(
      `SELECT * FROM role_assignment_rules ${whereClause}
       ORDER BY priority DESC, created_at DESC
       LIMIT ? OFFSET ?`
    )
      .bind(...[...values, limit, offset])
      .all();

    const rules = ((result.results || []) as RoleAssignmentRuleRow[]).map(rowToRule);

    return c.json({
      rules,
      total,
      limit,
      offset,
    });
  } catch (error) {
    log.error('List error', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to list rules',
      },
      500
    );
  }
}

/**
 * GET /api/admin/role-assignment-rules/:id
 * Get a single rule by ID
 */
export async function getRoleAssignmentRule(c: Context) {
  const log = getLogger(c).module('RoleAssignmentRulesAPI');
  const id = c.req.param('id');
  const tenantId = DEFAULT_TENANT_ID;

  const coreAdapter: DatabaseAdapter = new D1Adapter({ db: c.env.DB });

  try {
    const row = await coreAdapter.queryOne<RoleAssignmentRuleRow>(
      'SELECT * FROM role_assignment_rules WHERE id = ? AND tenant_id = ?',
      [id, tenantId]
    );

    if (!row) {
      return c.json(
        {
          error: 'not_found',
          error_description: `Rule ${id} not found`,
        },
        404
      );
    }

    return c.json(rowToRule(row));
  } catch (error) {
    log.error('Get error', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to get rule',
      },
      500
    );
  }
}

/**
 * PUT /api/admin/role-assignment-rules/:id
 * Update a rule
 */
export async function updateRoleAssignmentRule(c: Context) {
  const log = getLogger(c).module('RoleAssignmentRulesAPI');
  const id = c.req.param('id');
  const tenantId = DEFAULT_TENANT_ID;
  const body = await c.req.json<Partial<RoleAssignmentRuleInput>>();

  const coreAdapter: DatabaseAdapter = new D1Adapter({ db: c.env.DB });

  try {
    // Check if rule exists
    const existing = await coreAdapter.queryOne<RoleAssignmentRuleRow>(
      'SELECT * FROM role_assignment_rules WHERE id = ? AND tenant_id = ?',
      [id, tenantId]
    );

    if (!existing) {
      return c.json(
        {
          error: 'not_found',
          error_description: `Rule ${id} not found`,
        },
        404
      );
    }

    // Build update query
    const setClauses: string[] = [];
    const values: unknown[] = [];

    if (body.name !== undefined) {
      setClauses.push('name = ?');
      values.push(body.name);
    }
    if (body.description !== undefined) {
      setClauses.push('description = ?');
      values.push(body.description);
    }
    if (body.role_id !== undefined) {
      setClauses.push('role_id = ?');
      values.push(body.role_id);
    }
    if (body.scope_type !== undefined) {
      setClauses.push('scope_type = ?');
      values.push(body.scope_type);
    }
    if (body.scope_target !== undefined) {
      setClauses.push('scope_target = ?');
      values.push(body.scope_target);
    }
    if (body.condition !== undefined) {
      setClauses.push('conditions_json = ?');
      values.push(JSON.stringify(body.condition));
    }
    if (body.actions !== undefined) {
      setClauses.push('actions_json = ?');
      values.push(JSON.stringify(body.actions));
    }
    if (body.priority !== undefined) {
      setClauses.push('priority = ?');
      values.push(body.priority);
    }
    if (body.is_active !== undefined) {
      setClauses.push('is_active = ?');
      values.push(body.is_active ? 1 : 0);
    }
    if (body.stop_processing !== undefined) {
      setClauses.push('stop_processing = ?');
      values.push(body.stop_processing ? 1 : 0);
    }
    if (body.valid_from !== undefined) {
      setClauses.push('valid_from = ?');
      values.push(body.valid_from);
    }
    if (body.valid_until !== undefined) {
      setClauses.push('valid_until = ?');
      values.push(body.valid_until);
    }

    if (setClauses.length === 0) {
      return c.json(rowToRule(existing));
    }

    const now = Math.floor(Date.now() / 1000);
    setClauses.push('updated_at = ?');
    values.push(now, id, tenantId);

    await coreAdapter.execute(
      `UPDATE role_assignment_rules SET ${setClauses.join(', ')} WHERE id = ? AND tenant_id = ?`,
      values
    );

    // Invalidate cache
    if (c.env.SETTINGS) {
      try {
        await c.env.SETTINGS.delete(`role_assignment_rules_cache:${tenantId}`);
      } catch {
        // Ignore cache invalidation errors
      }
    }

    // Return updated rule
    const updated = await coreAdapter.queryOne<RoleAssignmentRuleRow>(
      'SELECT * FROM role_assignment_rules WHERE id = ? AND tenant_id = ?',
      [id, tenantId]
    );

    return c.json(rowToRule(updated!));
  } catch (error) {
    log.error('Update error', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to update rule',
      },
      500
    );
  }
}

/**
 * DELETE /api/admin/role-assignment-rules/:id
 * Delete a rule
 */
export async function deleteRoleAssignmentRule(c: Context) {
  const log = getLogger(c).module('RoleAssignmentRulesAPI');
  const id = c.req.param('id');
  const tenantId = DEFAULT_TENANT_ID;

  const coreAdapter: DatabaseAdapter = new D1Adapter({ db: c.env.DB });

  try {
    const result = await coreAdapter.execute(
      'DELETE FROM role_assignment_rules WHERE id = ? AND tenant_id = ?',
      [id, tenantId]
    );

    if (result.rowsAffected === 0) {
      return c.json(
        {
          error: 'not_found',
          error_description: `Rule ${id} not found`,
        },
        404
      );
    }

    // Invalidate cache
    if (c.env.SETTINGS) {
      try {
        await c.env.SETTINGS.delete(`role_assignment_rules_cache:${tenantId}`);
      } catch {
        // Ignore cache invalidation errors
      }
    }

    return c.json({ success: true });
  } catch (error) {
    log.error('Delete error', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to delete rule',
      },
      500
    );
  }
}

/**
 * POST /api/admin/role-assignment-rules/:id/test
 * Test a single rule against a provided context
 */
export async function testRoleAssignmentRule(c: Context) {
  const log = getLogger(c).module('RoleAssignmentRulesAPI');
  const id = c.req.param('id');
  const tenantId = DEFAULT_TENANT_ID;
  const body = await c.req.json<{
    context: {
      email?: string;
      email_verified?: boolean;
      provider_id?: string;
      idp_claims?: Record<string, unknown>;
      user_type?: string;
    };
  }>();

  const coreAdapter: DatabaseAdapter = new D1Adapter({ db: c.env.DB });

  try {
    // Get rule
    const row = await coreAdapter.queryOne<RoleAssignmentRuleRow>(
      'SELECT * FROM role_assignment_rules WHERE id = ? AND tenant_id = ?',
      [id, tenantId]
    );

    if (!row) {
      return c.json(
        {
          error: 'not_found',
          error_description: `Rule ${id} not found`,
        },
        404
      );
    }

    const rule = rowToRule(row);

    // Generate email_domain_hash if email provided
    let emailDomainHash: string | undefined;
    if (body.context.email && body.context.email.includes('@')) {
      try {
        const secret = await getEmailDomainHashSecret(c.env);
        emailDomainHash = await generateEmailDomainHash(body.context.email, secret);
      } catch {
        // If no secret configured, skip hash generation
      }
    }

    // Build evaluation context
    const evalContext: RuleEvaluationContext = {
      email_domain_hash: emailDomainHash,
      email_verified: body.context.email_verified ?? false,
      idp_claims: body.context.idp_claims ?? {},
      provider_id: body.context.provider_id ?? '',
      user_type: body.context.user_type,
      tenant_id: tenantId,
    };

    // Test rule
    const result = testRuleAgainstContext(rule, evalContext);

    return c.json(result);
  } catch (error) {
    log.error('Test error', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to test rule',
      },
      500
    );
  }
}

/**
 * POST /api/admin/role-assignment-rules/evaluate
 * Evaluate all rules against a provided context
 */
export async function evaluateRoleAssignmentRules(c: Context) {
  const log = getLogger(c).module('RoleAssignmentRulesAPI');
  const tenantId = DEFAULT_TENANT_ID;
  const body = await c.req.json<{
    context: {
      email?: string;
      email_verified?: boolean;
      provider_id?: string;
      idp_claims?: Record<string, unknown>;
      user_type?: string;
    };
  }>();

  try {
    // Generate email_domain_hash if email provided
    let emailDomainHash: string | undefined;
    if (body.context.email && body.context.email.includes('@')) {
      try {
        const secret = await getEmailDomainHashSecret(c.env);
        emailDomainHash = await generateEmailDomainHash(body.context.email, secret);
      } catch {
        // If no secret configured, skip hash generation
      }
    }

    // Build evaluation context
    const evalContext: RuleEvaluationContext = {
      email_domain_hash: emailDomainHash,
      email_verified: body.context.email_verified ?? false,
      idp_claims: body.context.idp_claims ?? {},
      provider_id: body.context.provider_id ?? '',
      user_type: body.context.user_type,
      tenant_id: tenantId,
    };

    // Create evaluator and run
    const evaluator = createRuleEvaluator(c.env.DB, c.env.SETTINGS);
    const result = await evaluator.evaluate(evalContext);

    return c.json({
      matched_rules: result.matched_rules,
      final_roles: result.roles_to_assign,
      final_orgs: result.orgs_to_join,
      attributes_to_set: result.attributes_to_set,
      denied: result.denied,
      deny_code: result.deny_code,
      deny_description: result.deny_description,
    });
  } catch (error) {
    log.error('Evaluate error', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to evaluate rules',
      },
      500
    );
  }
}
