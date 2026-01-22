/**
 * Admin Policies API Client
 *
 * Provides methods for managing policy rules:
 * - List and search policies
 * - Create/update/delete policy rules
 * - Simulate policy evaluation
 * - View simulation history
 */

const API_BASE_URL = import.meta.env.PUBLIC_API_BASE_URL || '';

// =============================================================================
// Types
// =============================================================================

/**
 * Policy condition types
 */
export type ConditionType =
	// RBAC
	| 'has_role'
	| 'has_any_role'
	| 'has_all_roles'
	// Ownership
	| 'is_resource_owner'
	| 'same_organization'
	// ABAC
	| 'attribute_equals'
	| 'attribute_exists'
	| 'attribute_in'
	// Time-based
	| 'time_in_range'
	| 'day_of_week'
	| 'valid_during'
	// Numeric
	| 'numeric_gt'
	| 'numeric_gte'
	| 'numeric_lt'
	| 'numeric_lte'
	| 'numeric_between'
	// Geographic
	| 'country_in'
	| 'country_not_in'
	| 'ip_in_range'
	// Rate-based
	| 'request_count_lt'
	| 'request_count_lte'
	| 'request_count_gt'
	| 'request_count_gte';

/**
 * Policy condition
 */
export interface PolicyCondition {
	type: ConditionType;
	params: Record<string, unknown>;
}

/**
 * Policy rule
 */
export interface PolicyRule {
	id: string;
	name: string;
	description?: string;
	priority: number;
	effect: 'allow' | 'deny';
	resource_types: string[];
	actions: string[];
	conditions: PolicyCondition[];
	enabled: boolean;
	created_by?: string;
	created_at: number;
	updated_by?: string;
	updated_at: number;
}

/**
 * Policy subject for simulation
 */
export interface PolicySubject {
	id: string;
	userType?: string;
	roles: Array<{
		name: string;
		scope: string;
		scopeTarget?: string;
	}>;
	orgId?: string;
	plan?: string;
	orgType?: string;
}

/**
 * Policy resource for simulation
 */
export interface PolicyResource {
	type: string;
	id: string;
	ownerId?: string;
	orgId?: string;
	attributes?: Record<string, unknown>;
}

/**
 * Policy action for simulation
 */
export interface PolicyAction {
	name: string;
	operation?: string;
}

/**
 * Policy context for simulation
 */
export interface PolicyContext {
	subject: PolicySubject;
	resource: PolicyResource;
	action: PolicyAction;
	timestamp: number;
	environment?: {
		clientIp?: string;
		countryCode?: string;
		region?: string;
		timezone?: string;
		[key: string]: unknown;
	};
}

/**
 * Simulation result
 */
export interface SimulationResult {
	allowed: boolean;
	reason: string;
	decided_by?: string;
	details?: Record<string, unknown>;
	evaluated_rules: number;
}

/**
 * Simulation history entry
 */
export interface SimulationHistory {
	id: string;
	context: PolicyContext;
	allowed: boolean;
	reason: string;
	decided_by?: string;
	details?: Record<string, unknown>;
	simulated_by?: string;
	simulated_at: number;
}

/**
 * Condition type metadata
 */
export interface ConditionTypeMetadata {
	type: ConditionType;
	category: string;
	label: string;
	description: string;
	params: Array<{
		name: string;
		type: string;
		required: boolean;
		label: string;
	}>;
}

/**
 * Condition category
 */
export interface ConditionCategory {
	id: string;
	label: string;
	icon: string;
}

/**
 * Pagination info
 */
export interface PaginationInfo {
	page: number;
	limit: number;
	total: number;
	total_pages: number;
}

// =============================================================================
// API Client
// =============================================================================

/**
 * Admin Policies API client
 */
export const adminPoliciesAPI = {
	// =========================================================================
	// Policy Rules Management
	// =========================================================================

	/**
	 * List policy rules
	 */
	async listPolicies(params?: {
		page?: number;
		limit?: number;
		enabled?: boolean;
		search?: string;
	}): Promise<{ rules: PolicyRule[]; pagination: PaginationInfo }> {
		const searchParams = new URLSearchParams();
		if (params?.page) searchParams.set('page', params.page.toString());
		if (params?.limit) searchParams.set('limit', params.limit.toString());
		if (params?.enabled !== undefined) searchParams.set('enabled', String(params.enabled));
		if (params?.search) searchParams.set('search', params.search);

		const response = await fetch(`${API_BASE_URL}/api/admin/policies?${searchParams}`, {
			method: 'GET',
			credentials: 'include'
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || 'Failed to list policies');
		}

		return response.json();
	},

	/**
	 * Get policy rule by ID
	 */
	async getPolicy(id: string): Promise<{ rule: PolicyRule }> {
		const response = await fetch(`${API_BASE_URL}/api/admin/policies/${id}`, {
			method: 'GET',
			credentials: 'include'
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || 'Failed to get policy');
		}

		return response.json();
	},

	/**
	 * Create policy rule
	 */
	async createPolicy(data: {
		name: string;
		description?: string;
		priority?: number;
		effect: 'allow' | 'deny';
		resource_types?: string[];
		actions?: string[];
		conditions: PolicyCondition[];
		enabled?: boolean;
	}): Promise<{ success: boolean; rule_id: string }> {
		const response = await fetch(`${API_BASE_URL}/api/admin/policies`, {
			method: 'POST',
			credentials: 'include',
			headers: {
				'Content-Type': 'application/json'
			},
			body: JSON.stringify(data)
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || 'Failed to create policy');
		}

		return response.json();
	},

	/**
	 * Update policy rule
	 */
	async updatePolicy(
		id: string,
		data: {
			name?: string;
			description?: string;
			priority?: number;
			effect?: 'allow' | 'deny';
			resource_types?: string[];
			actions?: string[];
			conditions?: PolicyCondition[];
			enabled?: boolean;
		}
	): Promise<{ success: boolean }> {
		const response = await fetch(`${API_BASE_URL}/api/admin/policies/${id}`, {
			method: 'PUT',
			credentials: 'include',
			headers: {
				'Content-Type': 'application/json'
			},
			body: JSON.stringify(data)
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || 'Failed to update policy');
		}

		return response.json();
	},

	/**
	 * Delete policy rule
	 */
	async deletePolicy(id: string): Promise<{ success: boolean }> {
		const response = await fetch(`${API_BASE_URL}/api/admin/policies/${id}`, {
			method: 'DELETE',
			credentials: 'include'
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || 'Failed to delete policy');
		}

		return response.json();
	},

	// =========================================================================
	// Simulation
	// =========================================================================

	/**
	 * Simulate policy evaluation
	 */
	async simulate(context: PolicyContext, saveHistory?: boolean): Promise<SimulationResult> {
		const response = await fetch(`${API_BASE_URL}/api/admin/policies/simulate`, {
			method: 'POST',
			credentials: 'include',
			headers: {
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({ context, save_history: saveHistory })
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || 'Failed to simulate policy');
		}

		return response.json();
	},

	/**
	 * Get simulation history
	 */
	async getSimulations(params?: {
		page?: number;
		limit?: number;
	}): Promise<{ simulations: SimulationHistory[]; pagination: PaginationInfo }> {
		const searchParams = new URLSearchParams();
		if (params?.page) searchParams.set('page', params.page.toString());
		if (params?.limit) searchParams.set('limit', params.limit.toString());

		const response = await fetch(`${API_BASE_URL}/api/admin/policies/simulations?${searchParams}`, {
			method: 'GET',
			credentials: 'include'
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || 'Failed to get simulations');
		}

		return response.json();
	},

	// =========================================================================
	// Metadata
	// =========================================================================

	/**
	 * Get condition types metadata
	 */
	async getConditionTypes(): Promise<{
		condition_types: ConditionTypeMetadata[];
		categories: ConditionCategory[];
	}> {
		const response = await fetch(`${API_BASE_URL}/api/admin/policies/condition-types`, {
			method: 'GET',
			credentials: 'include'
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || 'Failed to get condition types');
		}

		return response.json();
	}
};

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Get effect badge color
 */
export function getEffectColor(effect: 'allow' | 'deny'): string {
	return effect === 'allow' ? 'success' : 'danger';
}

/**
 * Get effect label
 */
export function getEffectLabel(effect: 'allow' | 'deny'): string {
	return effect === 'allow' ? 'Allow' : 'Deny';
}

/**
 * Format condition for display
 */
export function formatCondition(condition: PolicyCondition): string {
	const { type, params } = condition;

	switch (type) {
		case 'has_role':
			return `Has role "${params.role}"${params.scope ? ` (${params.scope})` : ''}`;
		case 'has_any_role':
			return `Has any role: ${(params.roles as string[]).join(', ')}`;
		case 'has_all_roles':
			return `Has all roles: ${(params.roles as string[]).join(', ')}`;
		case 'is_resource_owner':
			return 'Is resource owner';
		case 'same_organization':
			return 'In same organization';
		case 'attribute_equals':
			return `${params.attribute} = "${params.value}"`;
		case 'attribute_exists':
			return `Has attribute "${params.attribute}"`;
		case 'attribute_in':
			return `${params.attribute} in [${(params.values as string[]).join(', ')}]`;
		case 'time_in_range':
			return `Time between ${params.start_hour}:00 - ${params.end_hour}:00`;
		case 'day_of_week':
			return `Day of week in [${(params.days as number[]).join(', ')}]`;
		case 'valid_during':
			return `Valid from ${params.start || 'now'} to ${params.end || '∞'}`;
		case 'country_in':
			return `Country in [${(params.countries as string[]).join(', ')}]`;
		case 'country_not_in':
			return `Country not in [${(params.countries as string[]).join(', ')}]`;
		case 'ip_in_range':
			return `IP in ${params.cidr}`;
		case 'numeric_gt':
			return `${params.attribute} > ${params.threshold}`;
		case 'numeric_gte':
			return `${params.attribute} >= ${params.threshold}`;
		case 'numeric_lt':
			return `${params.attribute} < ${params.threshold}`;
		case 'numeric_lte':
			return `${params.attribute} <= ${params.threshold}`;
		case 'numeric_between':
			return `${params.min} <= ${params.attribute} <= ${params.max}`;
		case 'request_count_lt':
			return `Request count < ${params.limit}`;
		case 'request_count_lte':
			return `Request count <= ${params.limit}`;
		default:
			return JSON.stringify(condition);
	}
}

/**
 * Get category icon
 */
export function getCategoryIcon(categoryId: string): string {
	const icons: Record<string, string> = {
		rbac: '👤',
		ownership: '🛡️',
		abac: '🏷️',
		time: '⏰',
		numeric: '#️⃣',
		geo: '🌍',
		rate: '📈'
	};
	return icons[categoryId] || '📋';
}

/**
 * Create empty policy context for simulation
 */
export function createEmptyContext(): PolicyContext {
	return {
		subject: {
			id: '',
			roles: []
		},
		resource: {
			type: '',
			id: ''
		},
		action: {
			name: ''
		},
		timestamp: Math.floor(Date.now() / 1000)
	};
}
