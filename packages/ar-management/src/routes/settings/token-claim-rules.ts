/**
 * Token Claim Rules Admin API
 *
 * CRUD operations for custom claim embedding rules in access/ID tokens.
 *
 * POST   /api/admin/token-claim-rules           - Create rule
 * GET    /api/admin/token-claim-rules           - List rules
 * GET    /api/admin/token-claim-rules/:id       - Get rule
 * PUT    /api/admin/token-claim-rules/:id       - Update rule
 * DELETE /api/admin/token-claim-rules/:id       - Delete rule
 * POST   /api/admin/token-claim-rules/:id/test  - Test single rule
 * POST   /api/admin/token-claim-rules/evaluate  - Evaluate all rules
 */

import type { Context } from 'hono';
import {
  D1Adapter,
  getLogger,
  type DatabaseAdapter,
  type TokenClaimRule,
  type TokenClaimRuleRow,
  type TokenClaimRuleInput,
  type TokenClaimCondition,
  type TokenClaimCompoundCondition,
  type TokenClaimAction,
  type TokenClaimEvaluationContext,
  type TokenType,
  RESERVED_CLAIMS,
  createTokenClaimEvaluator,
  testTokenClaimRule,
} from '@authrim/ar-lib-core';

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_TENANT_ID = 'default';
const MAX_RULES_PER_PAGE = 100;

/** Reserved claim names that cannot be overwritten */
const RESERVED_CLAIM_NAMES = new Set(RESERVED_CLAIMS);

/** PII patterns that trigger warnings */
const PII_CLAIM_PATTERNS = ['email', 'name', 'phone', 'address', 'birthdate'];

// =============================================================================
// Helpers
// =============================================================================

function rowToRule(row: TokenClaimRuleRow): TokenClaimRule {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    name: row.name,
    description: row.description ?? undefined,
    token_type: row.token_type as TokenType,
    condition: JSON.parse(row.conditions_json) as TokenClaimCondition | TokenClaimCompoundCondition,
    actions: JSON.parse(row.actions_json) as TokenClaimAction[],
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

function validateRuleInput(input: TokenClaimRuleInput): {
  errors: string[];
  warnings: string[];
} {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!input.name || input.name.trim().length === 0) {
    errors.push('name is required');
  }

  if (!input.condition) {
    errors.push('condition is required');
  }

  if (!input.actions || !Array.isArray(input.actions) || input.actions.length === 0) {
    errors.push('actions is required and must be a non-empty array');
  }

  // Validate each action
  for (const action of input.actions || []) {
    if (!action.claim_name) {
      errors.push('Each action must have a claim_name');
      continue;
    }

    // Check reserved claims
    if (RESERVED_CLAIM_NAMES.has(action.claim_name as (typeof RESERVED_CLAIMS)[number])) {
      errors.push(`Cannot override reserved claim: ${action.claim_name}`);
    }

    // Warn about PII patterns
    const lowerName = action.claim_name.toLowerCase();
    for (const pattern of PII_CLAIM_PATTERNS) {
      if (lowerName.includes(pattern)) {
        warnings.push(
          `Claim "${action.claim_name}" may contain PII - ensure compliance with privacy policies`
        );
        break;
      }
    }
  }

  return { errors, warnings };
}

// =============================================================================
// Handlers
// =============================================================================

/**
 * POST /api/admin/token-claim-rules
 * Create a new token claim rule
 */
export async function createTokenClaimRule(c: Context) {
  const log = getLogger(c).module('TokenClaimRulesAPI');
  const body = await c.req.json<TokenClaimRuleInput>();
  const tenantId = DEFAULT_TENANT_ID;

  // Validate input
  const { errors, warnings } = validateRuleInput(body);
  if (errors.length > 0) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: errors.join(', '),
      },
      400
    );
  }

  // Log PII warnings
  if (warnings.length > 0) {
    log.warn('PII warnings', { warnings: warnings.join('; ') });
  }

  const id = `tcr_${crypto.randomUUID().replace(/-/g, '')}`;
  const now = Math.floor(Date.now() / 1000);

  const coreAdapter: DatabaseAdapter = new D1Adapter({ db: c.env.DB });

  try {
    // Check if name already exists
    const existing = await coreAdapter.queryOne<{ id: string }>(
      'SELECT id FROM token_claim_rules WHERE tenant_id = ? AND name = ?',
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
      `INSERT INTO token_claim_rules (
        id, tenant_id, name, description, token_type,
        conditions_json, actions_json, priority, is_active, stop_processing,
        valid_from, valid_until, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        tenantId,
        body.name,
        body.description || null,
        body.token_type || 'access',
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
        await c.env.SETTINGS.delete(`token_claim_rules_cache:${tenantId}:access`);
        await c.env.SETTINGS.delete(`token_claim_rules_cache:${tenantId}:id`);
      } catch {
        // Ignore cache invalidation errors
      }
    }

    // Return created rule
    const rule: TokenClaimRule = {
      id,
      tenant_id: tenantId,
      name: body.name,
      description: body.description,
      token_type: (body.token_type || 'access') as TokenType,
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
 * GET /api/admin/token-claim-rules
 * List all token claim rules
 */
export async function listTokenClaimRules(c: Context) {
  const log = getLogger(c).module('TokenClaimRulesAPI');
  const tenantId = DEFAULT_TENANT_ID;
  const limit = Math.min(parseInt(c.req.query('limit') || '50', 10), MAX_RULES_PER_PAGE);
  const offset = parseInt(c.req.query('offset') || '0', 10);
  const isActive = c.req.query('is_active');
  const tokenType = c.req.query('token_type') as TokenType | undefined;

  const coreAdapter: DatabaseAdapter = new D1Adapter({ db: c.env.DB });

  try {
    let whereClause = 'WHERE tenant_id = ?';
    const values: unknown[] = [tenantId];

    if (isActive !== undefined) {
      whereClause += ' AND is_active = ?';
      values.push(isActive === 'true' ? 1 : 0);
    }

    if (tokenType) {
      whereClause += ' AND (token_type = ? OR token_type = ?)';
      values.push(tokenType, 'both');
    }

    // Get total count
    const countResult = await coreAdapter.queryOne<{ count: number }>(
      `SELECT COUNT(*) as count FROM token_claim_rules ${whereClause}`,
      values
    );
    const total = countResult?.count ?? 0;

    // Get rules
    const result = await c.env.DB.prepare(
      `SELECT * FROM token_claim_rules ${whereClause}
       ORDER BY priority DESC, created_at ASC
       LIMIT ? OFFSET ?`
    )
      .bind(...[...values, limit, offset])
      .all();

    const rules = ((result.results || []) as TokenClaimRuleRow[]).map(rowToRule);

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
 * GET /api/admin/token-claim-rules/:id
 * Get a single rule by ID
 */
export async function getTokenClaimRule(c: Context) {
  const log = getLogger(c).module('TokenClaimRulesAPI');
  const id = c.req.param('id');
  const tenantId = DEFAULT_TENANT_ID;

  const coreAdapter: DatabaseAdapter = new D1Adapter({ db: c.env.DB });

  try {
    const row = await coreAdapter.queryOne<TokenClaimRuleRow>(
      'SELECT * FROM token_claim_rules WHERE id = ? AND tenant_id = ?',
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
 * PUT /api/admin/token-claim-rules/:id
 * Update a rule
 */
export async function updateTokenClaimRule(c: Context) {
  const log = getLogger(c).module('TokenClaimRulesAPI');
  const id = c.req.param('id');
  const tenantId = DEFAULT_TENANT_ID;
  const body = await c.req.json<Partial<TokenClaimRuleInput>>();

  const coreAdapter: DatabaseAdapter = new D1Adapter({ db: c.env.DB });

  try {
    // Check if rule exists
    const existing = await coreAdapter.queryOne<TokenClaimRuleRow>(
      'SELECT * FROM token_claim_rules WHERE id = ? AND tenant_id = ?',
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

    // Validate actions if provided
    if (body.actions) {
      const { errors: validationErrors, warnings } = validateRuleInput({
        name: body.name || existing.name,
        condition: body.condition || JSON.parse(existing.conditions_json),
        actions: body.actions,
      });
      if (validationErrors.length > 0) {
        return c.json(
          {
            error: 'invalid_request',
            error_description: validationErrors.join(', '),
          },
          400
        );
      }
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
    if (body.token_type !== undefined) {
      setClauses.push('token_type = ?');
      values.push(body.token_type);
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
      `UPDATE token_claim_rules SET ${setClauses.join(', ')} WHERE id = ? AND tenant_id = ?`,
      values
    );

    // Invalidate cache
    if (c.env.SETTINGS) {
      try {
        await c.env.SETTINGS.delete(`token_claim_rules_cache:${tenantId}:access`);
        await c.env.SETTINGS.delete(`token_claim_rules_cache:${tenantId}:id`);
      } catch {
        // Ignore cache invalidation errors
      }
    }

    // Return updated rule
    const updated = await coreAdapter.queryOne<TokenClaimRuleRow>(
      'SELECT * FROM token_claim_rules WHERE id = ? AND tenant_id = ?',
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
 * DELETE /api/admin/token-claim-rules/:id
 * Delete a rule
 */
export async function deleteTokenClaimRule(c: Context) {
  const log = getLogger(c).module('TokenClaimRulesAPI');
  const id = c.req.param('id');
  const tenantId = DEFAULT_TENANT_ID;

  const coreAdapter: DatabaseAdapter = new D1Adapter({ db: c.env.DB });

  try {
    const result = await coreAdapter.execute(
      'DELETE FROM token_claim_rules WHERE id = ? AND tenant_id = ?',
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
        await c.env.SETTINGS.delete(`token_claim_rules_cache:${tenantId}:access`);
        await c.env.SETTINGS.delete(`token_claim_rules_cache:${tenantId}:id`);
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
 * POST /api/admin/token-claim-rules/:id/test
 * Test a single rule against a provided context
 */
export async function testTokenClaimRuleHandler(c: Context) {
  const log = getLogger(c).module('TokenClaimRulesAPI');
  const id = c.req.param('id');
  const tenantId = DEFAULT_TENANT_ID;
  const body = await c.req.json<{
    context: {
      subject_id: string;
      client_id: string;
      scope?: string;
      roles?: string[];
      permissions?: string[];
      org_id?: string;
      org_type?: string;
      user_type?: string;
      idp_claims?: Record<string, unknown>;
    };
  }>();

  const coreAdapter: DatabaseAdapter = new D1Adapter({ db: c.env.DB });

  try {
    // Get rule
    const row = await coreAdapter.queryOne<TokenClaimRuleRow>(
      'SELECT * FROM token_claim_rules WHERE id = ? AND tenant_id = ?',
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

    // Build evaluation context
    const evalContext: TokenClaimEvaluationContext = {
      tenant_id: tenantId,
      subject_id: body.context.subject_id,
      client_id: body.context.client_id,
      scope: body.context.scope || '',
      roles: body.context.roles || [],
      permissions: body.context.permissions || [],
      org_id: body.context.org_id,
      org_type: body.context.org_type,
      user_type: body.context.user_type,
      idp_claims: body.context.idp_claims,
    };

    // Test rule
    const result = testTokenClaimRule(rule, evalContext);

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
 * POST /api/admin/token-claim-rules/evaluate
 * Evaluate all rules against a provided context
 */
export async function evaluateTokenClaimRules(c: Context) {
  const log = getLogger(c).module('TokenClaimRulesAPI');
  const tenantId = DEFAULT_TENANT_ID;
  const body = await c.req.json<{
    token_type: 'access' | 'id';
    context: {
      subject_id: string;
      client_id: string;
      scope?: string;
      roles?: string[];
      permissions?: string[];
      org_id?: string;
      org_type?: string;
      user_type?: string;
      idp_claims?: Record<string, unknown>;
    };
  }>();

  try {
    // Build evaluation context
    const evalContext: TokenClaimEvaluationContext = {
      tenant_id: tenantId,
      subject_id: body.context.subject_id,
      client_id: body.context.client_id,
      scope: body.context.scope || '',
      roles: body.context.roles || [],
      permissions: body.context.permissions || [],
      org_id: body.context.org_id,
      org_type: body.context.org_type,
      user_type: body.context.user_type,
      idp_claims: body.context.idp_claims,
    };

    // Create evaluator and run
    const evaluator = createTokenClaimEvaluator(c.env.DB, c.env.SETTINGS);
    const result = await evaluator.evaluate(evalContext, body.token_type);

    return c.json({
      matched_rules: result.matched_rules,
      claims_to_add: result.claims_to_add,
      claim_overrides: result.claim_overrides,
      truncated: result.truncated,
      truncation_reason: result.truncation_reason,
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
