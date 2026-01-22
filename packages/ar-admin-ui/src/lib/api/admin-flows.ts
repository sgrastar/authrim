/**
 * Admin Flows API Client
 *
 * Provides methods for managing authentication/authorization flows.
 * Flows define the steps and capabilities required for different auth scenarios.
 */

const API_BASE_URL = import.meta.env.PUBLIC_API_BASE_URL || '';

// =============================================================================
// Types
// =============================================================================

/**
 * Profile ID type
 */
export type ProfileId = 'human-basic' | 'human-org' | 'ai-agent' | 'iot-device';

/**
 * Node type for flow graph
 *
 * Design Principles:
 * - Selection = UI nodes (user chooses)
 * - Check = Check/Resolve nodes (system decides)
 * - Execute = Action nodes (side effects)
 * - Control = Control nodes (flow control)
 */
export type GraphNodeType =
	// === 1. Control Nodes ===
	| 'start' // Flow start
	| 'end' // Flow end
	| 'goto' // Jump within flow

	// === 2. State/Check Nodes ===
	| 'check_session' // Session exists check
	| 'check_auth_level' // ACR/strength check
	| 'check_first_login' // First login check
	| 'check_user_attribute' // User attribute check
	| 'check_context' // Client/locale/ip/country
	| 'check_risk' // Risk score

	// === 3. Selection/UI Nodes ===
	| 'auth_method_select' // Auth method selection (email or social)
	| 'login_method_select' // Login method selection (passkey or OTP)
	| 'identifier' // Identifier input (email/phone/username)
	| 'profile_input' // Profile input (name/birthdate etc)
	| 'custom_form' // Admin-defined form
	| 'information' // Information display (read-only)
	| 'challenge' // CAPTCHA/Bot challenge

	// === 4. Authentication Nodes ===
	| 'login' // Authentication execution
	| 'mfa' // Additional authentication
	| 'register' // Registration

	// === 5. Consent/Profile Nodes ===
	| 'consent' // Terms/consent
	| 'check_consent_status' // Check if consented
	| 'record_consent' // Record consent (audit)

	// === 6. Resolve Nodes ===
	| 'resolve_tenant' // Tenant resolution (from email domain etc)
	| 'resolve_org' // Organization resolution
	| 'resolve_policy' // Policy resolution

	// === 7. Session/Token Nodes ===
	| 'issue_tokens' // Token issuance
	| 'refresh_session' // Session refresh
	| 'revoke_session' // Forced logout
	| 'bind_device' // Device binding
	| 'link_account' // Social linking/ID unification

	// === 8. Side Effect Nodes ===
	| 'redirect' // Semantic redirect
	| 'webhook' // External notification
	| 'event_emit' // Internal event (audit/analytics)
	| 'email_send' // Email send
	| 'sms_send' // SMS send
	| 'push_notify' // Push notification

	// === 9. Logic/Decision Nodes ===
	| 'decision' // Complex condition branching
	| 'switch' // Enum branching (locale/client_type)

	// === 10. Policy Nodes ===
	| 'policy_check' // RBAC/ABAC/ReBAC check

	// === 11. Error/Debug Nodes ===
	| 'error' // Error display
	| 'log' // Log output (dev)

	// === Legacy (deprecated) ===
	| 'auth_method' // → auth_method_select
	| 'user_input' // → profile_input/custom_form
	| 'condition' // → decision
	| 'check_user' // → check_user_attribute
	| 'set_variable' // → internal
	| 'call_api' // → webhook
	| 'send_notification' // → email_send/sms_send/push_notify
	| 'risk_check' // → check_risk
	| 'wait_input'; // → custom_form

/**
 * Node category for palette organization
 */
export type NodeCategory =
	| 'control'
	| 'check'
	| 'selection'
	| 'auth'
	| 'consent'
	| 'resolve'
	| 'session'
	| 'side_effect'
	| 'logic'
	| 'policy'
	| 'error';

/**
 * Get node category
 */
export function getNodeCategory(type: GraphNodeType): NodeCategory {
	const categoryMap: Record<GraphNodeType, NodeCategory> = {
		// Control
		start: 'control',
		end: 'control',
		goto: 'control',
		// Check
		check_session: 'check',
		check_auth_level: 'check',
		check_first_login: 'check',
		check_user_attribute: 'check',
		check_context: 'check',
		check_risk: 'check',
		// Selection
		auth_method_select: 'selection',
		login_method_select: 'selection',
		identifier: 'selection',
		profile_input: 'selection',
		custom_form: 'selection',
		information: 'selection',
		challenge: 'selection',
		// Auth
		login: 'auth',
		mfa: 'auth',
		register: 'auth',
		// Consent
		consent: 'consent',
		check_consent_status: 'consent',
		record_consent: 'consent',
		// Resolve
		resolve_tenant: 'resolve',
		resolve_org: 'resolve',
		resolve_policy: 'resolve',
		// Session
		issue_tokens: 'session',
		refresh_session: 'session',
		revoke_session: 'session',
		bind_device: 'session',
		link_account: 'session',
		// Side Effect
		redirect: 'side_effect',
		webhook: 'side_effect',
		event_emit: 'side_effect',
		email_send: 'side_effect',
		sms_send: 'side_effect',
		push_notify: 'side_effect',
		// Logic
		decision: 'logic',
		switch: 'logic',
		// Policy
		policy_check: 'policy',
		// Error
		error: 'error',
		log: 'error',
		// Legacy
		auth_method: 'selection',
		user_input: 'selection',
		condition: 'logic',
		check_user: 'check',
		set_variable: 'side_effect',
		call_api: 'side_effect',
		send_notification: 'side_effect',
		risk_check: 'check',
		wait_input: 'selection'
	};
	return categoryMap[type] || 'control';
}

// =============================================================================
// V1 Semantic Types (UI Contract aligned)
// =============================================================================

/**
 * Redirect destination - semantic names instead of URLs
 * URLs are resolved by SDK/runtime based on context
 */
export type RedirectDestination =
	| 'post_login' // After successful login
	| 'post_register' // After successful registration
	| 'post_logout' // After logout
	| 'post_consent' // After consent granted
	| 'error_page' // Generic error page
	| 'mfa_setup' // MFA setup flow
	| 'password_reset' // Password reset flow
	| 'account_settings' // User account settings
	| 'return_url'; // Return to original requested URL (from OAuth state)

/**
 * Session facts for declarative check_session
 * Maps to runtime context evaluation
 */
export type SessionFact =
	| 'session.authenticated' // User is logged in
	| 'session.mfa_verified' // MFA was completed this session
	| 'session.fresh' // Session is fresh (recent auth)
	| 'user.email_verified' // Email is verified
	| 'user.phone_verified' // Phone is verified
	| 'user.mfa_enabled' // User has MFA set up
	| 'user.has_password' // User has password credential
	| 'user.has_passkey' // User has passkey credential
	| 'user.first_login' // This is user's first login
	| 'consent.terms_accepted' // Terms of service accepted
	| 'consent.privacy_accepted' // Privacy policy accepted
	| 'context.new_device' // Request is from new device
	| 'context.high_risk'; // Risk score indicates high risk

/**
 * Error reasons for error screen
 */
export type ErrorReason =
	| 'login_failed' // Authentication failed
	| 'account_locked' // Account is locked
	| 'account_disabled' // Account is disabled
	| 'session_expired' // Session has expired
	| 'invalid_credentials' // Wrong username/password
	| 'mfa_failed' // MFA verification failed
	| 'rate_limited' // Too many attempts
	| 'consent_declined' // User declined consent
	| 'registration_failed' // Registration failed
	| 'unknown_error'; // Generic error

/**
 * Identifier input kinds
 */
export type IdentifierKind =
	| 'email' // Email address
	| 'phone' // Phone number
	| 'username' // Username
	| 'employee_id'; // Employee ID (enterprise)

/**
 * Consent types
 */
export type ConsentType =
	| 'terms' // Terms of Service
	| 'privacy' // Privacy Policy
	| 'marketing' // Marketing communications
	| 'data_processing' // Data processing agreement
	| 'cookie' // Cookie consent
	| 'third_party'; // Third party data sharing

/**
 * Authentication methods
 */
export type AuthMethod =
	| 'password' // Password authentication
	| 'passkey' // WebAuthn/Passkey
	| 'social' // Social login (OAuth)
	| 'magic_link' // Email magic link
	| 'otp_email' // Email OTP
	| 'otp_sms'; // SMS OTP

/**
 * MFA factors
 */
export type MfaFactor =
	| 'totp' // Time-based OTP (authenticator app)
	| 'sms' // SMS code
	| 'email' // Email code
	| 'webauthn' // Security key
	| 'recovery_code'; // Recovery code

// =============================================================================
// Condition Types
// =============================================================================

/**
 * Condition operator for flow conditions
 */
export type ConditionOperator =
	| 'equals'
	| 'notEquals'
	| 'contains'
	| 'notContains'
	| 'startsWith'
	| 'endsWith'
	| 'greaterThan'
	| 'lessThan'
	| 'greaterOrEqual'
	| 'lessOrEqual'
	| 'in'
	| 'notIn'
	| 'exists'
	| 'notExists'
	| 'matches'
	| 'isTrue'
	| 'isFalse';

/**
 * Single flow condition
 */
export interface FlowCondition {
	key: string;
	operator: ConditionOperator;
	value?: unknown;
}

/**
 * Condition group with AND/OR logic
 */
export interface ConditionGroup {
	logic: 'and' | 'or';
	conditions: (FlowCondition | ConditionGroup)[];
}

/**
 * Edge type for flow graph
 */
export type GraphEdgeType = 'success' | 'error' | 'conditional' | 'unavailable';

/**
 * Graph node position
 */
export interface Position {
	x: number;
	y: number;
}

/**
 * Graph node data
 */
export interface GraphNodeData {
	label: string;
	icon?: string;
	color?: string;
	intent?: string;
	capabilities?: unknown[];
	config?: Record<string, unknown>;
}

/**
 * Graph node
 */
export interface GraphNode {
	id: string;
	type: GraphNodeType;
	position: Position;
	data: GraphNodeData;
}

/**
 * Edge condition
 */
export interface EdgeCondition {
	type: 'capability_result' | 'policy_check' | 'feature_flag' | 'custom';
	expression: string;
}

/**
 * Graph edge data
 */
export interface GraphEdgeData {
	label?: string;
	condition?: EdgeCondition;
}

/**
 * Graph edge
 */
export interface GraphEdge {
	id: string;
	source: string;
	target: string;
	sourceHandle?: string;
	targetHandle?: string;
	type: GraphEdgeType;
	data?: GraphEdgeData;
}

/**
 * Graph metadata
 */
export interface GraphMetadata {
	createdAt: string;
	updatedAt: string;
	createdBy?: string;
}

/**
 * Graph definition for flow
 */
export interface GraphDefinition {
	id: string;
	flowVersion: string;
	name: string;
	description: string;
	profileId: ProfileId;
	nodes: GraphNode[];
	edges: GraphEdge[];
	metadata: GraphMetadata;
}

/**
 * Flow entity
 */
export interface Flow {
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
}

/**
 * Flow list response
 */
export interface FlowsListResponse {
	flows: Flow[];
	pagination: {
		page: number;
		limit: number;
		total: number;
		total_pages: number;
	};
}

/**
 * Flow detail response
 */
export interface FlowDetailResponse {
	flow: Flow;
}

/**
 * Create flow request
 */
export interface CreateFlowRequest {
	name: string;
	description?: string;
	profile_id: ProfileId;
	client_id?: string | null;
	graph_definition: GraphDefinition;
	version?: string;
	is_active?: boolean;
}

/**
 * Update flow request
 */
export interface UpdateFlowRequest {
	name?: string;
	description?: string;
	graph_definition?: GraphDefinition;
	version?: string;
	is_active?: boolean;
}

/**
 * Copy flow request
 */
export interface CopyFlowRequest {
	name?: string;
	client_id?: string | null;
	profile_id?: ProfileId;
}

/**
 * Validation result
 */
export interface ValidationResult {
	valid: boolean;
	errors: string[];
}

/**
 * Node type metadata
 */
export interface NodeTypeMetadata {
	type: GraphNodeType;
	label: string;
	description: string;
	category: 'control' | 'input' | 'auth' | 'consent';
	color: string;
	icon: string;
	maxConnections: { inputs: number; outputs: number };
	hasErrorOutput: boolean;
}

/**
 * Edge type metadata
 */
export interface EdgeTypeMetadata {
	type: GraphEdgeType;
	label: string;
	color: string;
}

/**
 * Node types response
 */
export interface NodeTypesResponse {
	node_types: NodeTypeMetadata[];
	categories: { id: string; label: string; icon: string }[];
	edge_types: EdgeTypeMetadata[];
}

// =============================================================================
// List filter options
// =============================================================================

export interface FlowListFilters {
	profile_id?: ProfileId;
	client_id?: string;
	is_active?: boolean;
	search?: string;
	page?: number;
	limit?: number;
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Get profile display name
 */
export function getProfileDisplayName(profileId: ProfileId): string {
	const names: Record<ProfileId, string> = {
		'human-basic': 'Human (Basic)',
		'human-org': 'Human (Organization)',
		'ai-agent': 'AI Agent',
		'iot-device': 'IoT Device'
	};
	return names[profileId] || profileId;
}

/**
 * Get profile badge style
 */
export function getProfileBadgeStyle(profileId: ProfileId): string {
	const styles: Record<ProfileId, string> = {
		'human-basic': 'background-color: #dbeafe; color: #1e40af;',
		'human-org': 'background-color: #e0e7ff; color: #3730a3;',
		'ai-agent': 'background-color: #d1fae5; color: #065f46;',
		'iot-device': 'background-color: #fef3c7; color: #92400e;'
	};
	return styles[profileId] || 'background-color: #f3f4f6; color: #374151;';
}

export function getProfileBadgeClass(profileId: ProfileId): string {
	const classes: Record<ProfileId, string> = {
		'human-basic': 'badge badge-info',
		'human-org': 'badge badge-info',
		'ai-agent': 'badge badge-success',
		'iot-device': 'badge badge-warning'
	};
	return classes[profileId] || 'badge badge-neutral';
}

/**
 * Check if flow can be edited
 */
export function canEditFlow(flow: Flow): boolean {
	return !flow.is_builtin;
}

/**
 * Check if flow can be deleted
 */
export function canDeleteFlow(flow: Flow): boolean {
	return !flow.is_builtin;
}

/**
 * Create an empty graph definition
 */
export function createEmptyGraphDefinition(name: string, profileId: ProfileId): GraphDefinition {
	const now = new Date().toISOString();
	return {
		id: crypto.randomUUID(),
		flowVersion: '1.0.0',
		name,
		description: '',
		profileId,
		nodes: [
			{
				id: 'start-1',
				type: 'start',
				position: { x: 100, y: 200 },
				data: { label: 'Start' }
			},
			{
				id: 'end-1',
				type: 'end',
				position: { x: 500, y: 200 },
				data: { label: 'End' }
			}
		],
		edges: [],
		metadata: {
			createdAt: now,
			updatedAt: now
		}
	};
}

// =============================================================================
// API Client
// =============================================================================

export const adminFlowsAPI = {
	/**
	 * List flows with optional filters
	 */
	async list(filters: FlowListFilters = {}): Promise<FlowsListResponse> {
		const params = new URLSearchParams();

		if (filters.profile_id) {
			params.set('profile_id', filters.profile_id);
		}
		if (filters.client_id !== undefined) {
			params.set('client_id', filters.client_id);
		}
		if (filters.is_active !== undefined) {
			params.set('is_active', String(filters.is_active));
		}
		if (filters.search) {
			params.set('search', filters.search);
		}
		if (filters.page) {
			params.set('page', String(filters.page));
		}
		if (filters.limit) {
			params.set('limit', String(filters.limit));
		}

		const url = `${API_BASE_URL}/api/admin/flows${params.toString() ? '?' + params.toString() : ''}`;

		const response = await fetch(url, {
			credentials: 'include'
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || error.message || 'Failed to fetch flows');
		}

		return response.json();
	},

	/**
	 * Get flow by ID
	 */
	async get(id: string): Promise<FlowDetailResponse> {
		const response = await fetch(`${API_BASE_URL}/api/admin/flows/${encodeURIComponent(id)}`, {
			credentials: 'include'
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || error.message || 'Failed to fetch flow');
		}

		return response.json();
	},

	/**
	 * Create a new flow
	 */
	async create(data: CreateFlowRequest): Promise<{ success: boolean; flow_id: string }> {
		const response = await fetch(`${API_BASE_URL}/api/admin/flows`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			credentials: 'include',
			body: JSON.stringify(data)
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || error.message || 'Failed to create flow');
		}

		return response.json();
	},

	/**
	 * Update an existing flow
	 */
	async update(id: string, data: UpdateFlowRequest): Promise<{ success: boolean }> {
		const response = await fetch(`${API_BASE_URL}/api/admin/flows/${encodeURIComponent(id)}`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			credentials: 'include',
			body: JSON.stringify(data)
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || error.message || 'Failed to update flow');
		}

		return response.json();
	},

	/**
	 * Delete a flow
	 */
	async delete(id: string): Promise<{ success: boolean }> {
		const response = await fetch(`${API_BASE_URL}/api/admin/flows/${encodeURIComponent(id)}`, {
			method: 'DELETE',
			credentials: 'include'
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || error.message || 'Failed to delete flow');
		}

		return response.json();
	},

	/**
	 * Copy (duplicate) a flow
	 */
	async copy(
		id: string,
		data: CopyFlowRequest = {}
	): Promise<{ success: boolean; flow_id: string }> {
		const response = await fetch(`${API_BASE_URL}/api/admin/flows/${encodeURIComponent(id)}/copy`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			credentials: 'include',
			body: JSON.stringify(data)
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || error.message || 'Failed to copy flow');
		}

		return response.json();
	},

	/**
	 * Validate a flow definition
	 */
	async validate(id: string, graphDefinition: GraphDefinition): Promise<ValidationResult> {
		const response = await fetch(
			`${API_BASE_URL}/api/admin/flows/${encodeURIComponent(id)}/validate`,
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				credentials: 'include',
				body: JSON.stringify({ graph_definition: graphDefinition })
			}
		);

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || error.message || 'Failed to validate flow');
		}

		return response.json();
	},

	/**
	 * Compile a flow definition to CompiledPlan
	 */
	async compile(id: string): Promise<{ success: boolean; compiled_plan: Record<string, unknown> }> {
		const response = await fetch(
			`${API_BASE_URL}/api/admin/flows/${encodeURIComponent(id)}/compile`,
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				credentials: 'include'
			}
		);

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || error.message || 'Failed to compile flow');
		}

		return response.json();
	},

	/**
	 * Get node type metadata for Flow Designer
	 */
	async getNodeTypes(): Promise<NodeTypesResponse> {
		const response = await fetch(`${API_BASE_URL}/api/admin/flows/node-types`, {
			credentials: 'include'
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || error.message || 'Failed to fetch node types');
		}

		return response.json();
	}
};
