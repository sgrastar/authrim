import { API_BASE_URL, adminFetch } from '$lib/api/admin-request';

export type ApprovalRequestStatus =
	| 'pending'
	| 'partially_approved'
	| 'approved'
	| 'denied'
	| 'expired'
	| 'cancelled';

export type ApprovalDecisionStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'cancelled';

export type ApprovalTransportMethod =
	| 'ciba'
	| 'passkey'
	| 'portal_confirm'
	| 'email_otp'
	| 'sms_otp'
	| 'reauth';

export interface StructuredReference {
	system: string;
	id: string;
	url?: string | null;
}

export interface ElevationGrantRecord {
	id: string;
	public_grant_id: string;
	approval_request_id: string;
	tenant_id: string;
	status: 'active' | 'expired' | 'revoked';
	target_audience: string;
	resource_class: string;
	redaction_level: 'summary_only' | 'masked' | 'raw';
	scope_canonical: string;
	scope_json: Record<string, unknown>;
	authorization_details_json?: Record<string, unknown> | null;
	requester_subject_type: string;
	requester_subject_id: string;
	actor_subject_type: string;
	actor_subject_id: string;
	issued_at: number;
	expires_at: number;
	revoked_at?: number | null;
	revoke_reason?: string | null;
	created_at: number;
	updated_at: number;
}

export interface ApprovalRequestApproval {
	id: string;
	approval_request_id: string;
	step_key: string;
	side: 'admin_operator' | 'customer_data_owner' | 'guardian_delegate';
	subject_type: 'admin_user' | 'end_user' | 'customer_delegate' | 'service_principal';
	subject_id?: string | null;
	relation_type?: string | null;
	relation_source?: string | null;
	status: ApprovalDecisionStatus;
	method?: ApprovalTransportMethod | null;
	transport_channel?: string | null;
	reason_code?: string | null;
	reason_note?: string | null;
	last_notification_action?: 'initial' | 'resend' | 'remind' | null;
	last_notified_at?: number | null;
	notification_count: number;
	decided_at?: number | null;
	expires_at: number;
	created_at: number;
	updated_at: number;
}

export interface ApprovalRequestStepInput {
	step_key: string;
	side: 'admin_operator' | 'customer_data_owner' | 'guardian_delegate';
	subject_type: 'admin_user' | 'end_user' | 'customer_delegate' | 'service_principal';
	subject_id?: string;
	relation_type?: string;
	relation_source?: string;
	method?: ApprovalTransportMethod;
	transport_channel?: string;
	expires_at?: number;
}

export interface ApprovalResolvedPolicy {
	preset: string;
	request_ttl_seconds: number | null;
	notification_cooldown_seconds?: {
		remind: number;
		resend: number;
	};
}

export interface ApprovalRequestRecord {
	id: string;
	public_request_id: string;
	tenant_id: string;
	investigation_id: string;
	requester_subject_type: string;
	requester_subject_id: string;
	target_subject_type: string;
	target_subject_id: string;
	request_surface: string;
	requested_action: string;
	redaction_level: 'summary_only' | 'masked' | 'raw';
	status: ApprovalRequestStatus;
	scope_json: Record<string, unknown>;
	scope_canonical: string;
	reason_code: string;
	reason_note?: string | null;
	reference?: StructuredReference | null;
	ticket_reference?: StructuredReference | null;
	reuse_scope: 'request' | 'case';
	policy_preset: string;
	partial_access_allowed: boolean;
	has_detail?: boolean;
	expires_at: number;
	decided_at?: number | null;
	created_at: number;
	updated_at: number;
	approvals: ApprovalRequestApproval[];
	grants: ElevationGrantRecord[];
	resolved_policy?: ApprovalResolvedPolicy;
	notification_results?: ApprovalNotificationResult[];
}

export interface ApprovalNotificationResult {
	approval_id: string;
	step_key: string;
	action: 'initial' | 'resend' | 'remind';
	method: ApprovalTransportMethod;
	transport_channel?: string | null;
	completion_artifact?: {
		artifact_id: string;
		path: string;
		expires_at: number;
	} | null;
	success: boolean;
	delivery_status?: string | null;
	target?: string | null;
	transport_request_id?: string | null;
	error?: string | null;
	retryable?: boolean;
}

export interface ApprovalTransportEvidenceEvent {
	id: string;
	kind:
		| 'request_created'
		| 'step_initial'
		| 'step_artifact_issued'
		| 'step_receipt_issued'
		| 'grant_subject_token_issued'
		| 'grant_revoked'
		| 'step_approved'
		| 'step_denied'
		| 'step_remind'
		| 'step_resend'
		| 'request_cancelled';
	at: number;
	actor_subject_type?: string | null;
	actor_subject_id?: string | null;
	request_status: ApprovalRequestStatus;
	approval_step?: {
		id: string;
		step_key: string;
		side: ApprovalRequestApproval['side'];
		subject_type: ApprovalRequestApproval['subject_type'];
		subject_id?: string | null;
		relation_type?: string | null;
		relation_source?: string | null;
		status: ApprovalDecisionStatus;
	} | null;
	method?: ApprovalTransportMethod | null;
	transport_channel?: string | null;
	reason_code?: string | null;
	reason_note?: string | null;
	notification_action?: 'initial' | 'remind' | 'resend' | null;
	notification_count?: number | null;
	transport_summary?: {
		provider?: string | null;
		delivery_status?: string | null;
		target?: string | null;
		correlation_id?: string | null;
		transport_request_id?: string | null;
	} | null;
	transport_detail?: {
		request?: Record<string, unknown> | null;
		response?: Record<string, unknown> | null;
		metadata?: Record<string, unknown> | null;
	} | null;
}

export interface ApprovalTransportEvidence {
	version: 1;
	request: {
		public_request_id: string;
		investigation_id: string;
		request_surface: string;
		requested_action: string;
		target_subject_type: ApprovalRequestRecord['target_subject_type'];
		target_subject_id: string;
		redaction_level: ApprovalRequestRecord['redaction_level'];
		status: ApprovalRequestStatus;
		reason_code: string;
		reason_note?: string | null;
		reference?: StructuredReference | null;
		ticket_reference?: StructuredReference | null;
		policy_preset: string;
		reuse_scope: 'request' | 'case';
		partial_access_allowed: boolean;
		scope_json: Record<string, unknown>;
		requested_at: number;
		expires_at: number;
		decided_at?: number | null;
	};
	events: ApprovalTransportEvidenceEvent[];
}

export interface ApprovalDecisionReceiptRecord {
	event_id: string;
	event_at: number;
	receipt_id: string;
	path?: string | null;
	portal_path?: string | null;
	decision?: string | null;
	request_status?: string | null;
	expires_at?: number | null;
	grant_ids: string[];
	receipt?: {
		receipt_id: string;
		artifact_id: string;
		request_id: string;
		approval_id: string;
		step_key: string;
		investigation_id: string;
		request_surface: string;
		requested_action: string;
		method: ApprovalTransportMethod;
		transport_channel?: string | null;
		decision: ApprovalDecisionStatus;
		request_status: ApprovalRequestStatus;
		grant_ids: string[];
		completed_at: number;
		expires_at: number;
	} | null;
}

export interface ApprovalGrantSubjectTokenResult {
	grant_id: string;
	request_id: string;
	investigation_id: string;
	subject_token: string;
	subject_token_type: string;
	expires_in: number;
	authorization_details: Record<string, unknown>[];
	token_exchange_hint: {
		grant_type: string;
		subject_token_type: string;
		requested_token_type: string;
		client_id: string;
	};
	integration_hint: {
		token_endpoint: string;
		introspection_endpoint: string;
		target_audience?: string | null;
		resource_class: string;
		resource_ids: string[];
		detail_classes: string[];
		requires_online_check: boolean;
		fail_closed: boolean;
		subject_token_client_id: string;
		authorization_defaults: {
			expected_audience: string | null;
			required_resource_class: string;
			required_resource_ids: string[];
			required_detail_classes: string[];
			require_full_access: boolean;
		};
		service_sdk: {
			exchange_helper: string;
			resource_fetch_helper: string;
			projection_helper: string;
			introspection_mode: 'if_required' | 'always';
			authorizer_factory: string;
			middleware: string;
			protected_resource_middleware: string;
		};
		product_route?: {
			service_package: string;
			path_template: string;
			default_audience: string;
		} | null;
	};
}

export interface ApprovalCompletionArtifact {
	artifact_id: string;
	tenant_id: string;
	request_id: string;
	approval_id: string;
	step_key: string;
	investigation_id: string;
	request_surface: string;
	requested_action: string;
	target_subject_type: 'user' | 'artifact' | 'service_resource' | 'tenant_resource';
	target_subject_id: string;
	requester_subject_type: string;
	requester_subject_id: string;
	approver_side: 'admin_operator' | 'customer_data_owner' | 'guardian_delegate';
	approver_subject_type: 'admin_user' | 'end_user' | 'customer_delegate' | 'service_principal';
	approver_subject_id?: string | null;
	relation_type?: string | null;
	relation_source?: string | null;
	method: ApprovalTransportMethod;
	transport_channel?: string | null;
	redaction_level: 'summary_only' | 'masked' | 'raw';
	policy_preset: string;
	reuse_scope: 'request' | 'case';
	partial_access_allowed: boolean;
	reference?: StructuredReference | null;
	ticket_reference?: StructuredReference | null;
	expires_at: number;
	created_at: number;
	consumed: boolean;
}

export interface ApprovalCompletionRequirements {
	mode: 'artifact_only' | 'step_up_required';
	method: ApprovalTransportMethod;
	acceptable_methods: ApprovalTransportMethod[];
	artifact_path: string;
	portal_path: string;
	assertion_endpoints?: {
		options?: string;
		verify?: string;
		assert?: string;
		start?: string;
		status?: string;
		device?: string;
	} | null;
	transport_channel?: string | null;
	guidance_title: string;
	guidance_body: string;
	fallback_note?: string | null;
	approver_binding: {
		subject_type: ApprovalRequestApproval['subject_type'];
		subject_id?: string | null;
		relation_type?: string | null;
		relation_source?: string | null;
	};
}

export interface ApprovalCompletionArtifactIssueResult {
	artifact: ApprovalCompletionArtifact;
	completion_path: string;
	completion_requirements: ApprovalCompletionRequirements;
	request: ApprovalRequestRecord;
}

export interface ApprovalStepGuideResult {
	request_id: string;
	approval_id: string;
	step_key: string;
	status: ApprovalDecisionStatus;
	expires_at: number;
	selection_source?: string | null;
	resolution_error?: string | null;
	guide: {
		mode: 'artifact_only' | 'step_up_required';
		method: ApprovalTransportMethod;
		transport_channel?: string | null;
		acceptable_methods: ApprovalTransportMethod[];
		guidance_title: string;
		guidance_body: string;
		fallback_note?: string | null;
	} | null;
}

export interface ApprovalListResponse {
	items: ApprovalRequestRecord[];
	total: number;
}

export interface ApprovalDecisionInput {
	method?: ApprovalTransportMethod;
	transport_channel?: string;
	reason_code?: string;
	reason_note?: string;
	transport_summary?: {
		provider?: string;
		delivery_status?: string;
		target?: string;
		correlation_id?: string;
		transport_request_id?: string;
	};
	transport_detail?: {
		request?: Record<string, unknown> | null;
		response?: Record<string, unknown> | null;
		metadata?: Record<string, unknown> | null;
	};
}

export interface ApprovalRequestCreateInput {
	investigation_id?: string;
	requester_subject_type?: 'admin_user' | 'end_user' | 'customer_delegate' | 'service_principal';
	requester_subject_id?: string;
	target_subject_type: 'user' | 'artifact' | 'service_resource' | 'tenant_resource';
	target_subject_id: string;
	request_surface: string;
	requested_action: string;
	resource_class: string;
	resource_ids?: string[];
	detail_classes?: string[];
	dataset?: string;
	audience?: string;
	redaction_level?: 'summary_only' | 'masked' | 'raw';
	attributes?: Record<string, unknown>;
	reason_code: string;
	reason_note?: string;
	reference_id?: string;
	reference?: StructuredReference;
	ticket_reference?: StructuredReference;
	policy_preset:
		| 'support_case_default'
		| 'technical_debug_default'
		| 'security_investigation_default'
		| 'guardian_support_default'
		| 'compliance_review_default';
	reuse_scope?: 'request' | 'case';
	partial_access_allowed?: boolean;
	expires_at?: number;
	approvals: ApprovalRequestStepInput[];
}

export interface ApprovalPreviewResolvedStep {
	step_key: string;
	side: ApprovalRequestStepInput['side'];
	subject_type: ApprovalRequestStepInput['subject_type'];
	subject_id?: string | null;
	relation_type?: string | null;
	relation_source?: string | null;
	expires_at: number;
	method: ApprovalTransportMethod | null;
	transport_channel?: string | null;
	acceptable_methods: ApprovalTransportMethod[];
	selection_source: 'explicit_override' | 'approval_step' | 'policy_default';
	guidance_title?: string | null;
	guidance_body?: string | null;
	fallback_note?: string | null;
	transport_resolution_error?: string;
}

export interface ApprovalRequestPreviewResult {
	request: {
		investigation_id: string;
		tenant_id: string;
		requester_subject_type: string;
		requester_subject_id: string;
		target_subject_type: string;
		target_subject_id: string;
		request_surface: string;
		requested_action: string;
		redaction_level: 'summary_only' | 'masked' | 'raw';
		reason_code: string;
		reason_note?: string | null;
		reference?: StructuredReference | null;
		ticket_reference?: StructuredReference | null;
		policy_preset: ApprovalRequestCreateInput['policy_preset'];
		reuse_scope: 'request' | 'case';
		partial_access_allowed: boolean;
		expires_at: number;
		scope_json: Record<string, unknown>;
		scope_canonical: string;
		resolved_policy: ApprovalResolvedPolicy;
	};
	steps: ApprovalPreviewResolvedStep[];
}

async function parseResponse<T>(response: Response, fallbackMessage: string): Promise<T> {
	if (!response.ok) {
		const error = await response.json().catch(() => ({}));
		throw new Error(error.error_description || error.message || error.error || fallbackMessage);
	}

	return response.json() as Promise<T>;
}

export const adminApprovalsAPI = {
	async list(params?: {
		status?: ApprovalRequestStatus;
		investigationId?: string;
		limit?: number;
	}) {
		const searchParams = new URLSearchParams();
		if (params?.status) searchParams.set('status', params.status);
		if (params?.investigationId) searchParams.set('investigation_id', params.investigationId);
		if (params?.limit) searchParams.set('limit', String(params.limit));

		const query = searchParams.toString();
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/approvals${query ? `?${query}` : ''}`
		);
		return parseResponse<ApprovalListResponse>(response, 'Failed to load approval requests');
	},

	async get(requestId: string) {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/approvals/${encodeURIComponent(requestId)}`
		);
		return parseResponse<ApprovalRequestRecord>(response, 'Failed to load approval request');
	},

	async getEvidence(requestId: string) {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/approvals/${encodeURIComponent(requestId)}/evidence`
		);
		return parseResponse<ApprovalTransportEvidence>(
			response,
			'Failed to load approval transport evidence'
		);
	},

	async getReceipts(requestId: string) {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/approvals/${encodeURIComponent(requestId)}/receipts`
		);
		return parseResponse<{
			request_id: string;
			investigation_id: string;
			items: ApprovalDecisionReceiptRecord[];
		}>(response, 'Failed to load approval decision receipts');
	},

	async getStepGuide(requestId: string, approvalId: string) {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/approvals/${encodeURIComponent(requestId)}/steps/${encodeURIComponent(approvalId)}/guide`
		);
		return parseResponse<ApprovalStepGuideResult>(response, 'Failed to load approval step guide');
	},

	async create(body: ApprovalRequestCreateInput) {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/approvals`, {
			method: 'POST',
			includeJsonContentType: true,
			body: JSON.stringify(body)
		});
		return parseResponse<ApprovalRequestRecord>(response, 'Failed to create approval request');
	},

	async preview(body: ApprovalRequestCreateInput) {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/approvals/preview`, {
			method: 'POST',
			includeJsonContentType: true,
			body: JSON.stringify(body)
		});
		return parseResponse<ApprovalRequestPreviewResult>(
			response,
			'Failed to preview approval request resolution'
		);
	},

	async approve(requestId: string, approvalId: string, body: ApprovalDecisionInput = {}) {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/approvals/${encodeURIComponent(requestId)}/steps/${encodeURIComponent(approvalId)}/approve`,
			{
				method: 'POST',
				includeJsonContentType: true,
				body: JSON.stringify(body)
			}
		);
		return parseResponse<ApprovalRequestRecord>(response, 'Failed to approve request step');
	},

	async deny(requestId: string, approvalId: string, body: ApprovalDecisionInput = {}) {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/approvals/${encodeURIComponent(requestId)}/steps/${encodeURIComponent(approvalId)}/deny`,
			{
				method: 'POST',
				includeJsonContentType: true,
				body: JSON.stringify(body)
			}
		);
		return parseResponse<ApprovalRequestRecord>(response, 'Failed to deny request step');
	},

	async remind(requestId: string, approvalId: string, body: ApprovalDecisionInput = {}) {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/approvals/${encodeURIComponent(requestId)}/steps/${encodeURIComponent(approvalId)}/remind`,
			{
				method: 'POST',
				includeJsonContentType: true,
				body: JSON.stringify(body)
			}
		);
		return parseResponse<ApprovalRequestRecord>(response, 'Failed to remind approval step');
	},

	async resend(requestId: string, approvalId: string, body: ApprovalDecisionInput = {}) {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/approvals/${encodeURIComponent(requestId)}/steps/${encodeURIComponent(approvalId)}/resend`,
			{
				method: 'POST',
				includeJsonContentType: true,
				body: JSON.stringify(body)
			}
		);
		return parseResponse<ApprovalRequestRecord>(response, 'Failed to resend approval step');
	},

	async cancel(
		requestId: string,
		body: Pick<ApprovalDecisionInput, 'reason_code' | 'reason_note'> = {}
	) {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/approvals/${encodeURIComponent(requestId)}/cancel`,
			{
				method: 'POST',
				includeJsonContentType: true,
				body: JSON.stringify(body)
			}
		);
		return parseResponse<ApprovalRequestRecord>(response, 'Failed to cancel approval request');
	},

	async issueSubjectToken(
		requestId: string,
		grantId: string,
		body: { client_id: string; expires_in?: number }
	) {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/approvals/${encodeURIComponent(requestId)}/grants/${encodeURIComponent(grantId)}/subject-token`,
			{
				method: 'POST',
				includeJsonContentType: true,
				body: JSON.stringify(body)
			}
		);
		return parseResponse<ApprovalGrantSubjectTokenResult>(
			response,
			'Failed to issue downstream subject token'
		);
	},

	async revokeGrant(
		requestId: string,
		grantId: string,
		body: {
			reason_code?: string;
			reason_note?: string;
		} = {}
	) {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/approvals/${encodeURIComponent(requestId)}/grants/${encodeURIComponent(grantId)}/revoke`,
			{
				method: 'POST',
				includeJsonContentType: true,
				body: JSON.stringify(body)
			}
		);
		return parseResponse<ApprovalRequestRecord>(response, 'Failed to revoke elevation grant');
	},

	async issueCompletionArtifact(
		requestId: string,
		approvalId: string,
		body: {
			method?: ApprovalTransportMethod;
			transport_channel?: string;
			expires_in_seconds?: number;
		} = {}
	) {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/approvals/${encodeURIComponent(requestId)}/steps/${encodeURIComponent(approvalId)}/artifacts`,
			{
				method: 'POST',
				includeJsonContentType: true,
				body: JSON.stringify(body)
			}
		);
		return parseResponse<ApprovalCompletionArtifactIssueResult>(
			response,
			'Failed to issue approval completion artifact'
		);
	}
};
