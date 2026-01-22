/**
 * Admin Role Assignment Rules API Client
 *
 * Provides methods for managing automatic role assignment rules based on IdP claims.
 * These rules enable automatic role provisioning during SSO authentication.
 */

const API_BASE_URL = import.meta.env.PUBLIC_API_BASE_URL || '';

/**
 * Scope type for rule application
 */
export type ScopeType = 'global' | 'organization' | 'client';

/**
 * Condition operators for rule matching
 */
export type ConditionOperator =
	| 'equals'
	| 'not_equals'
	| 'contains'
	| 'not_contains'
	| 'starts_with'
	| 'ends_with'
	| 'regex'
	| 'in'
	| 'not_in'
	| 'exists'
	| 'not_exists';

/**
 * Single condition for matching IdP claims
 */
export interface RuleCondition {
	claim: string;
	operator: ConditionOperator;
	value?: string | string[];
}

/**
 * Compound condition with AND/OR logic
 */
export interface CompoundCondition {
	operator: 'and' | 'or';
	conditions: (RuleCondition | CompoundCondition)[];
}

/**
 * Action to perform when rule matches
 */
export interface RuleAction {
	type: 'assign_role' | 'remove_role' | 'add_to_group' | 'set_attribute';
	target: string;
	value?: string;
}

/**
 * Role Assignment Rule
 */
export interface RoleAssignmentRule {
	id: string;
	tenant_id: string;
	name: string;
	description?: string;
	role_id: string;
	scope_type: ScopeType;
	scope_target: string;
	condition: RuleCondition | CompoundCondition;
	actions: RuleAction[];
	priority: number;
	is_active: boolean;
	stop_processing: boolean;
	valid_from?: number;
	valid_until?: number;
	created_by?: string;
	created_at: number;
	updated_at: number;
}

/**
 * List response with pagination
 */
export interface RoleAssignmentRuleListResponse {
	rules: RoleAssignmentRule[];
	total: number;
	limit: number;
	offset: number;
}

/**
 * Create Rule Request
 */
export interface CreateRoleAssignmentRuleRequest {
	name: string;
	description?: string;
	role_id: string;
	scope_type?: ScopeType;
	scope_target?: string;
	condition: RuleCondition | CompoundCondition;
	actions: RuleAction[];
	priority?: number;
	is_active?: boolean;
	stop_processing?: boolean;
	valid_from?: number;
	valid_until?: number;
}

/**
 * Update Rule Request
 */
export interface UpdateRoleAssignmentRuleRequest {
	name?: string;
	description?: string;
	role_id?: string;
	scope_type?: ScopeType;
	scope_target?: string;
	condition?: RuleCondition | CompoundCondition;
	actions?: RuleAction[];
	priority?: number;
	is_active?: boolean;
	stop_processing?: boolean;
	valid_from?: number;
	valid_until?: number;
}

/**
 * Rule evaluation context for testing
 */
export interface RuleEvaluationContext {
	claims: Record<string, unknown>;
	email?: string;
	provider_id?: string;
	organization_id?: string;
	client_id?: string;
}

/**
 * Rule test result
 */
export interface RuleTestResult {
	rule_id: string;
	rule_name: string;
	matched: boolean;
	actions_applied: RuleAction[];
	evaluation_details?: {
		condition_results: Array<{
			claim: string;
			operator: string;
			expected: unknown;
			actual: unknown;
			matched: boolean;
		}>;
	};
}

/**
 * Rule evaluation result
 */
export interface RuleEvaluationResult {
	matched_rules: RuleTestResult[];
	total_rules_evaluated: number;
	assigned_roles: string[];
	actions_to_apply: RuleAction[];
}

/**
 * List params for filtering
 */
export interface ListRoleAssignmentRulesParams {
	limit?: number;
	offset?: number;
	scope_type?: ScopeType;
	is_active?: boolean;
	role_id?: string;
}

export const adminRoleRulesAPI = {
	/**
	 * List all role assignment rules with optional filtering
	 */
	async list(params: ListRoleAssignmentRulesParams = {}): Promise<RoleAssignmentRuleListResponse> {
		const searchParams = new URLSearchParams();
		if (params.limit !== undefined) searchParams.set('limit', params.limit.toString());
		if (params.offset !== undefined) searchParams.set('offset', params.offset.toString());
		if (params.scope_type) searchParams.set('scope_type', params.scope_type);
		if (params.is_active !== undefined) searchParams.set('is_active', params.is_active.toString());
		if (params.role_id) searchParams.set('role_id', params.role_id);

		const query = searchParams.toString();
		const response = await fetch(
			`${API_BASE_URL}/api/admin/role-assignment-rules${query ? '?' + query : ''}`,
			{ credentials: 'include' }
		);

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(
				error.error_description || error.message || 'Failed to fetch role assignment rules'
			);
		}
		return response.json();
	},

	/**
	 * Get a single rule by ID
	 */
	async get(id: string): Promise<RoleAssignmentRule> {
		const response = await fetch(
			`${API_BASE_URL}/api/admin/role-assignment-rules/${encodeURIComponent(id)}`,
			{ credentials: 'include' }
		);

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(
				error.error_description || error.message || 'Failed to fetch role assignment rule'
			);
		}
		return response.json();
	},

	/**
	 * Create a new role assignment rule
	 */
	async create(data: CreateRoleAssignmentRuleRequest): Promise<RoleAssignmentRule> {
		const response = await fetch(`${API_BASE_URL}/api/admin/role-assignment-rules`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			credentials: 'include',
			body: JSON.stringify(data)
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(
				error.error_description || error.message || 'Failed to create role assignment rule'
			);
		}
		return response.json();
	},

	/**
	 * Update an existing rule
	 */
	async update(id: string, data: UpdateRoleAssignmentRuleRequest): Promise<RoleAssignmentRule> {
		const response = await fetch(
			`${API_BASE_URL}/api/admin/role-assignment-rules/${encodeURIComponent(id)}`,
			{
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				credentials: 'include',
				body: JSON.stringify(data)
			}
		);

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(
				error.error_description || error.message || 'Failed to update role assignment rule'
			);
		}
		return response.json();
	},

	/**
	 * Delete a rule
	 */
	async delete(id: string): Promise<{ success: boolean }> {
		const response = await fetch(
			`${API_BASE_URL}/api/admin/role-assignment-rules/${encodeURIComponent(id)}`,
			{
				method: 'DELETE',
				credentials: 'include'
			}
		);

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(
				error.error_description || error.message || 'Failed to delete role assignment rule'
			);
		}
		return response.json();
	},

	/**
	 * Test a single rule against a context
	 */
	async testRule(id: string, context: RuleEvaluationContext): Promise<RuleTestResult> {
		const response = await fetch(
			`${API_BASE_URL}/api/admin/role-assignment-rules/${encodeURIComponent(id)}/test`,
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				credentials: 'include',
				body: JSON.stringify(context)
			}
		);

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || error.message || 'Failed to test rule');
		}
		return response.json();
	},

	/**
	 * Evaluate all rules against a context
	 */
	async evaluateRules(context: RuleEvaluationContext): Promise<RuleEvaluationResult> {
		const response = await fetch(`${API_BASE_URL}/api/admin/role-assignment-rules/evaluate`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			credentials: 'include',
			body: JSON.stringify(context)
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || error.message || 'Failed to evaluate rules');
		}
		return response.json();
	}
};

/**
 * Helper: Create a simple equals condition
 */
export function createEqualsCondition(claim: string, value: string): RuleCondition {
	return { claim, operator: 'equals', value };
}

/**
 * Helper: Create a contains condition
 */
export function createContainsCondition(claim: string, value: string): RuleCondition {
	return { claim, operator: 'contains', value };
}

/**
 * Helper: Create an "in" condition (value must be one of the list)
 */
export function createInCondition(claim: string, values: string[]): RuleCondition {
	return { claim, operator: 'in', value: values };
}

/**
 * Helper: Create an AND compound condition
 */
export function createAndCondition(
	conditions: (RuleCondition | CompoundCondition)[]
): CompoundCondition {
	return { operator: 'and', conditions };
}

/**
 * Helper: Create an OR compound condition
 */
export function createOrCondition(
	conditions: (RuleCondition | CompoundCondition)[]
): CompoundCondition {
	return { operator: 'or', conditions };
}

/**
 * Helper: Create an assign_role action
 */
export function createAssignRoleAction(roleId: string): RuleAction {
	return { type: 'assign_role', target: roleId };
}
