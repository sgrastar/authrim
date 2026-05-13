import { adminFetch, API_BASE_URL } from '$lib/api/admin-request';

export type SupportOpsFieldType = 'boolean' | 'datetime' | 'enum' | 'number' | 'string';
export type SupportOpsSelectorOperator =
	| 'eq'
	| 'ne'
	| 'in'
	| 'lt'
	| 'lte'
	| 'gt'
	| 'gte'
	| 'exists'
	| 'not_exists';

export interface SupportOpsFieldDescriptor {
	type: SupportOpsFieldType;
	filterable: boolean;
	aggregatable: boolean;
	sensitive: boolean;
	operators: SupportOpsSelectorOperator[];
	values?: Array<string | number | boolean>;
}

export interface SupportOpsResourceDescriptor {
	resource: 'User';
	displayName: string;
	minCount: number;
	maxSnapshotCount: number;
	fields: Record<string, SupportOpsFieldDescriptor>;
	actions: Record<
		string,
		{ destructive: boolean; approvalRequired: boolean; implemented: boolean }
	>;
}

export interface SupportOpsSelectorCondition {
	field: string;
	op: SupportOpsSelectorOperator;
	value?: string | number | boolean | Array<string | number | boolean>;
}

export interface SupportOpsSelectorGroup {
	all?: SupportOpsSelector[];
	any?: SupportOpsSelector[];
}

export type SupportOpsSelector = SupportOpsSelectorCondition | SupportOpsSelectorGroup;

export interface SupportOpsRegistryResponse {
	resources: SupportOpsResourceDescriptor[];
}

export interface SupportOpsAggregateResponse {
	resource: string;
	groups: Array<{ key: Record<string, unknown>; count: number }>;
	suppressed_groups: number;
	privacy: {
		min_count: number;
		count_precision: number;
		count_exact: boolean;
		low_count_suppressed: boolean;
		complementary_suppression: boolean;
	};
}

export interface SupportOpsCohortPreviewResponse {
	resource: string;
	matched_count: number | null;
	actionable_count: number | null;
	blocked_count: number | null;
	blocked_reasons: string[];
	risk: {
		min_count: number;
		matched_count: number | null;
		low_count_suppressed: boolean;
		uses_sensitive_field: boolean;
		risk_level: 'low' | 'medium' | 'high';
		approval_required: boolean;
	};
	selector_hash: string;
}

export interface SupportOpsCohortCreateResponse {
	cohort_id: string;
	resource: string;
	intended_action: string;
	matched_count: number | null;
	actionable_count: number | null;
	blocked_count: number | null;
	blocked_reasons: string[];
	blocked_reasons_suppressed: boolean;
	privacy: {
		min_count: number;
		low_count_suppressed: boolean;
	};
	snapshot_status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
	snapshot_job_id: string | null;
	expires_at: number;
	selector_hash: string;
	risk: Record<string, unknown>;
}

export interface SupportOpsCohortResponse extends SupportOpsCohortCreateResponse {
	snapshot_error: string | null;
	blocked_summary?: Record<string, unknown>;
	support_case_id: string | null;
	created_at: number;
}

export interface SupportOpsActionCreateResponse {
	action_id: string;
	status: string;
	approval_request_id: string;
	approval_url: string;
	summary: {
		resource: string;
		action: string;
		matched_count: number | null;
		actionable_count: number | null;
		blocked_count: number | null;
		blocked_reasons_suppressed: boolean;
		privacy: {
			min_count: number;
			low_count_suppressed: boolean;
		};
	};
}

export interface SupportOpsActionResponse {
	action_id: string;
	cohort_id: string;
	resource: string;
	action: string;
	status: string;
	reason: string;
	support_case_id: string | null;
	approval_request_id: string | null;
	result_summary: Record<string, unknown>;
	created_at: number;
	updated_at: number;
}

async function handleAPIError(response: Response, fallbackMessage: string): Promise<Error> {
	try {
		const errorBody = await response.json();
		return new Error(errorBody.error_description || errorBody.error || fallbackMessage);
	} catch {
		return new Error(fallbackMessage);
	}
}

async function parseJson<T>(response: Response, fallbackMessage: string): Promise<T> {
	if (!response.ok) {
		throw await handleAPIError(response, fallbackMessage);
	}
	return response.json();
}

export const adminSupportOpsAPI = {
	async getRegistry(): Promise<SupportOpsRegistryResponse> {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/support-ops/registry`);
		return parseJson(response, 'Failed to load support operation registry');
	},

	async aggregate(input: {
		resource: string;
		selector?: SupportOpsSelector;
		group_by: string[];
	}): Promise<SupportOpsAggregateResponse> {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/support-ops/aggregate`, {
			method: 'POST',
			includeJsonContentType: true,
			body: JSON.stringify(input)
		});
		return parseJson(response, 'Failed to run support aggregate');
	},

	async previewCohort(input: {
		resource: string;
		selector?: SupportOpsSelector;
		intent?: { action?: string; reason?: string; support_case_id?: string };
	}): Promise<SupportOpsCohortPreviewResponse> {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/support-ops/cohorts/preview`, {
			method: 'POST',
			includeJsonContentType: true,
			body: JSON.stringify(input)
		});
		return parseJson(response, 'Failed to preview support cohort');
	},

	async createCohort(input: {
		resource: string;
		selector?: SupportOpsSelector;
		intent?: { action?: string; reason?: string; support_case_id?: string };
	}): Promise<SupportOpsCohortCreateResponse> {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/support-ops/cohorts`, {
			method: 'POST',
			includeJsonContentType: true,
			body: JSON.stringify(input)
		});
		return parseJson(response, 'Failed to create support cohort');
	},

	async getCohort(cohortId: string): Promise<SupportOpsCohortResponse> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/support-ops/cohorts/${encodeURIComponent(cohortId)}`
		);
		return parseJson(response, 'Failed to load support cohort');
	},

	async requestAction(input: {
		cohort_id: string;
		action: string;
		reason: string;
		support_case_id?: string;
	}): Promise<SupportOpsActionCreateResponse> {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/support-ops/actions`, {
			method: 'POST',
			includeJsonContentType: true,
			body: JSON.stringify(input)
		});
		return parseJson(response, 'Failed to request support action');
	},

	async approveAction(actionId: string): Promise<{ action_id: string; status: string }> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/support-ops/actions/${actionId}/approve`,
			{ method: 'POST' }
		);
		return parseJson(response, 'Failed to approve support action');
	},

	async executeAction(actionId: string): Promise<Record<string, unknown>> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/support-ops/actions/${actionId}/execute`,
			{ method: 'POST' }
		);
		return parseJson(response, 'Failed to execute support action');
	},

	async getAction(actionId: string): Promise<SupportOpsActionResponse> {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/support-ops/actions/${actionId}`);
		return parseJson(response, 'Failed to load support action');
	}
};
