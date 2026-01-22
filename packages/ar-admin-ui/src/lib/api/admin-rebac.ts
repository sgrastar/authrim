/**
 * Admin ReBAC API Client
 *
 * Provides methods for managing ReBAC (Relationship-Based Access Control):
 * - Relation definitions (Zanzibar-style DSL)
 * - Relationship tuples (user-relation-object)
 * - Permission check simulation
 */

const API_BASE_URL = import.meta.env.PUBLIC_API_BASE_URL || '';

// =============================================================================
// Types
// =============================================================================

/**
 * Relation expression types
 */
export type RelationExpressionType =
	| 'direct'
	| 'union'
	| 'intersection'
	| 'exclusion'
	| 'tuple_to_userset';

/**
 * Direct relation expression
 */
export interface DirectRelation {
	type: 'direct';
	relation: string;
}

/**
 * Union relation expression (OR logic)
 */
export interface UnionRelation {
	type: 'union';
	children: RelationExpression[];
}

/**
 * Intersection relation expression (AND logic)
 */
export interface IntersectionRelation {
	type: 'intersection';
	children: RelationExpression[];
}

/**
 * Exclusion relation expression (NOT logic)
 */
export interface ExclusionRelation {
	type: 'exclusion';
	base: RelationExpression;
	subtract: RelationExpression;
}

/**
 * Tuple-to-userset relation expression (inheritance)
 */
export interface TupleToUsersetRelation {
	type: 'tuple_to_userset';
	tupleset: {
		relation: string;
	};
	computed_userset: {
		relation: string;
	};
}

/**
 * Any relation expression
 */
export type RelationExpression =
	| DirectRelation
	| UnionRelation
	| IntersectionRelation
	| ExclusionRelation
	| TupleToUsersetRelation;

/**
 * Relation definition
 */
export interface RelationDefinition {
	id: string;
	tenant_id: string;
	object_type: string;
	relation_name: string;
	definition: RelationExpression;
	description: string | null;
	priority: number;
	is_active: boolean;
	created_at: number;
	updated_at: number;
}

/**
 * Relation definition list response
 */
export interface RelationDefinitionsListResponse {
	definitions: RelationDefinition[];
	pagination: {
		page: number;
		limit: number;
		total: number;
		total_pages: number;
	};
}

/**
 * Relation definition detail response
 */
export interface RelationDefinitionDetailResponse {
	definition: RelationDefinition;
}

/**
 * Relationship tuple
 */
export interface RelationshipTuple {
	id: string;
	tenant_id: string;
	relationship_type: string;
	from_type: string;
	from_id: string;
	to_type: string;
	to_id: string;
	permission_level: string;
	expires_at: number | null;
	is_bidirectional: boolean;
	metadata: Record<string, unknown> | null;
	created_at: number;
	updated_at: number;
}

/**
 * Relationship tuples list response
 */
export interface RelationshipTuplesListResponse {
	tuples: RelationshipTuple[];
	pagination: {
		page: number;
		limit: number;
		total: number;
		total_pages: number;
	};
}

/**
 * Permission check result
 */
export interface PermissionCheckResult {
	allowed: boolean;
	resolved_via?: string;
	path?: string[];
}

/**
 * Object type summary
 */
export interface ObjectTypeSummary {
	name: string;
	definition_count: number;
}

/**
 * Object types list response
 */
export interface ObjectTypesListResponse {
	object_types: ObjectTypeSummary[];
}

// =============================================================================
// API Client
// =============================================================================

/**
 * Admin ReBAC API client
 */
export const adminReBACAPI = {
	// =========================================================================
	// Relation Definitions
	// =========================================================================

	/**
	 * List relation definitions
	 */
	async listDefinitions(params?: {
		page?: number;
		limit?: number;
		object_type?: string;
		search?: string;
		is_active?: boolean;
	}): Promise<RelationDefinitionsListResponse> {
		const searchParams = new URLSearchParams();
		if (params?.page) searchParams.set('page', params.page.toString());
		if (params?.limit) searchParams.set('limit', params.limit.toString());
		if (params?.object_type) searchParams.set('object_type', params.object_type);
		if (params?.search) searchParams.set('search', params.search);
		if (params?.is_active !== undefined) searchParams.set('is_active', params.is_active.toString());

		const response = await fetch(
			`${API_BASE_URL}/api/admin/rebac/relation-definitions?${searchParams}`,
			{
				method: 'GET',
				credentials: 'include'
			}
		);

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || 'Failed to list relation definitions');
		}

		return response.json();
	},

	/**
	 * Get a specific relation definition
	 */
	async getDefinition(id: string): Promise<RelationDefinitionDetailResponse> {
		const response = await fetch(`${API_BASE_URL}/api/admin/rebac/relation-definitions/${id}`, {
			method: 'GET',
			credentials: 'include'
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || 'Failed to get relation definition');
		}

		return response.json();
	},

	/**
	 * Create a new relation definition
	 */
	async createDefinition(data: {
		object_type: string;
		relation_name: string;
		definition: RelationExpression;
		description?: string;
		priority?: number;
		is_active?: boolean;
	}): Promise<RelationDefinitionDetailResponse> {
		const response = await fetch(`${API_BASE_URL}/api/admin/rebac/relation-definitions`, {
			method: 'POST',
			credentials: 'include',
			headers: {
				'Content-Type': 'application/json'
			},
			body: JSON.stringify(data)
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || 'Failed to create relation definition');
		}

		return response.json();
	},

	/**
	 * Update a relation definition
	 */
	async updateDefinition(
		id: string,
		data: {
			definition?: RelationExpression;
			description?: string;
			priority?: number;
			is_active?: boolean;
		}
	): Promise<{ success: boolean }> {
		const response = await fetch(`${API_BASE_URL}/api/admin/rebac/relation-definitions/${id}`, {
			method: 'PUT',
			credentials: 'include',
			headers: {
				'Content-Type': 'application/json'
			},
			body: JSON.stringify(data)
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || 'Failed to update relation definition');
		}

		return response.json();
	},

	/**
	 * Delete a relation definition
	 */
	async deleteDefinition(id: string): Promise<{ success: boolean }> {
		const response = await fetch(`${API_BASE_URL}/api/admin/rebac/relation-definitions/${id}`, {
			method: 'DELETE',
			credentials: 'include'
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || 'Failed to delete relation definition');
		}

		return response.json();
	},

	// =========================================================================
	// Relationship Tuples
	// =========================================================================

	/**
	 * List relationship tuples
	 */
	async listTuples(params?: {
		page?: number;
		limit?: number;
		from_type?: string;
		from_id?: string;
		to_type?: string;
		to_id?: string;
		relationship_type?: string;
	}): Promise<RelationshipTuplesListResponse> {
		const searchParams = new URLSearchParams();
		if (params?.page) searchParams.set('page', params.page.toString());
		if (params?.limit) searchParams.set('limit', params.limit.toString());
		if (params?.from_type) searchParams.set('from_type', params.from_type);
		if (params?.from_id) searchParams.set('from_id', params.from_id);
		if (params?.to_type) searchParams.set('to_type', params.to_type);
		if (params?.to_id) searchParams.set('to_id', params.to_id);
		if (params?.relationship_type) searchParams.set('relationship_type', params.relationship_type);

		const response = await fetch(`${API_BASE_URL}/api/admin/rebac/tuples?${searchParams}`, {
			method: 'GET',
			credentials: 'include'
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || 'Failed to list relationship tuples');
		}

		return response.json();
	},

	/**
	 * Create a new relationship tuple
	 */
	async createTuple(data: {
		relationship_type: string;
		from_type?: string;
		from_id: string;
		to_type: string;
		to_id: string;
		permission_level?: string;
		expires_at?: number;
		metadata?: Record<string, unknown>;
	}): Promise<{ tuple: RelationshipTuple }> {
		const response = await fetch(`${API_BASE_URL}/api/admin/rebac/tuples`, {
			method: 'POST',
			credentials: 'include',
			headers: {
				'Content-Type': 'application/json'
			},
			body: JSON.stringify(data)
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || 'Failed to create relationship tuple');
		}

		return response.json();
	},

	/**
	 * Delete a relationship tuple
	 */
	async deleteTuple(id: string): Promise<{ success: boolean }> {
		const response = await fetch(`${API_BASE_URL}/api/admin/rebac/tuples/${id}`, {
			method: 'DELETE',
			credentials: 'include'
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || 'Failed to delete relationship tuple');
		}

		return response.json();
	},

	// =========================================================================
	// Permission Check
	// =========================================================================

	/**
	 * Simulate a permission check
	 */
	async checkPermission(data: {
		user_id: string;
		relation: string;
		object: string;
		object_type?: string;
		contextual_tuples?: Array<{
			user_id: string;
			relation: string;
			object: string;
			object_type?: string;
		}>;
	}): Promise<PermissionCheckResult> {
		const response = await fetch(`${API_BASE_URL}/api/admin/rebac/check`, {
			method: 'POST',
			credentials: 'include',
			headers: {
				'Content-Type': 'application/json'
			},
			body: JSON.stringify(data)
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || 'Failed to check permission');
		}

		return response.json();
	},

	// =========================================================================
	// Object Types
	// =========================================================================

	/**
	 * List object types with their definition counts
	 */
	async listObjectTypes(): Promise<ObjectTypesListResponse> {
		const response = await fetch(`${API_BASE_URL}/api/admin/rebac/object-types`, {
			method: 'GET',
			credentials: 'include'
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || 'Failed to list object types');
		}

		return response.json();
	}
};

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Format a relation expression to human-readable string
 */
export function formatRelationExpression(expr: RelationExpression): string {
	switch (expr.type) {
		case 'direct':
			return `direct:${expr.relation}`;
		case 'union':
			return `(${expr.children.map(formatRelationExpression).join(' OR ')})`;
		case 'intersection':
			return `(${expr.children.map(formatRelationExpression).join(' AND ')})`;
		case 'exclusion':
			return `(${formatRelationExpression(expr.base)} EXCEPT ${formatRelationExpression(expr.subtract)})`;
		case 'tuple_to_userset':
			return `${expr.tupleset.relation}->${expr.computed_userset.relation}`;
		default:
			return 'unknown';
	}
}

/**
 * Get a friendly display name for relation expression type
 */
export function getExpressionTypeLabel(type: RelationExpressionType): string {
	switch (type) {
		case 'direct':
			return 'Direct';
		case 'union':
			return 'Union (OR)';
		case 'intersection':
			return 'Intersection (AND)';
		case 'exclusion':
			return 'Exclusion (NOT)';
		case 'tuple_to_userset':
			return 'Inherited';
		default:
			return type;
	}
}

/**
 * Format a relationship tuple to human-readable string (Zanzibar notation)
 */
export function formatTupleString(tuple: RelationshipTuple): string {
	return `${tuple.to_type}:${tuple.to_id}#${tuple.relationship_type}@${tuple.from_type}:${tuple.from_id}`;
}
