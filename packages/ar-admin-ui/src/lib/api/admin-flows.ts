import { API_BASE_URL, adminFetch } from '$lib/api/admin-request';

export type AdminFlowKind = 'login' | 'registration' | 'approve' | 'account' | `custom:${string}`;
export type AdminFlowStatus = 'draft' | 'published' | 'disabled';
export type AdminFlowAssignmentTargetType = 'tenant' | 'oidc_client' | 'saml_sp';

export interface FlowEditorPosition {
	x: number;
	y: number;
}

export interface FlowEditorNode {
	id: string;
	type: string;
	title?: string;
	position?: FlowEditorPosition;
	config?: Record<string, unknown>;
	data?: Record<string, unknown>;
}

export interface FlowEditorEdge {
	id: string;
	source: string;
	target: string;
	source_handle?: string;
	target_handle?: string;
	label?: string;
	data?: Record<string, unknown>;
}

export interface FlowEditorState {
	nodes: FlowEditorNode[];
	edges: FlowEditorEdge[];
	viewport?: {
		x: number;
		y: number;
		zoom: number;
	};
}

export interface FlowRuntimeContract {
	flow_kind: AdminFlowKind;
	flow_id?: string;
	flow_version_id?: string;
	ui: {
		steps: Array<Record<string, unknown>>;
	};
	capabilities?: Record<string, unknown>[];
	runtime_bindings?: Record<string, unknown>;
	protocol_context?: Record<string, unknown>;
	[key: string]: unknown;
}

export interface FlowRuntimeContractPackage {
	schema_version: 'authrim.login_ui.contract.v1';
	mode: 'draft' | 'preview' | 'runtime' | 'export';
	runtime: FlowRuntimeContract;
	preview?: Record<string, unknown>;
	editor?: FlowEditorState;
}

export interface FlowValidationIssue {
	level: 'error' | 'warning';
	code: string;
	message: string;
	path?: string;
	node_id?: string | null;
	edge_id?: string | null;
	ref?: Record<string, unknown>;
}

export interface FlowValidationResult {
	valid: boolean;
	errors: FlowValidationIssue[];
	warnings: FlowValidationIssue[];
	issues: FlowValidationIssue[];
}

export interface AdminFlow {
	id: string;
	tenant_id: string;
	slug: string;
	name: string;
	display_name: string;
	description: string | null;
	template_id: string | null;
	kind: AdminFlowKind;
	status: AdminFlowStatus;
	editor: FlowEditorState | null;
	runtime: FlowRuntimeContract | null;
	published_version_id: string | null;
	is_active: boolean;
	is_builtin: boolean;
	created_by: string | null;
	created_at: number;
	updated_by: string | null;
	updated_at: number;
}

export interface FlowAssignment {
	id: string;
	tenant_id: string;
	target_type: AdminFlowAssignmentTargetType;
	target_id: string | null;
	flow_kind: AdminFlowKind;
	flow_id: string;
	enabled: boolean;
	created_at: number;
	updated_at: number;
}

export interface FlowVersion {
	id: string;
	tenant_id: string;
	flow_id: string;
	version_number: number;
	schema_version: string;
	runtime_snapshot: FlowRuntimeContract | null;
	editor_snapshot: FlowEditorState | null;
	validation_result: Record<string, unknown>;
	published_by: string | null;
	published_at: number;
	created_at: number;
}

export interface FlowListResponse {
	flows: AdminFlow[];
	pagination: {
		page: number;
		limit: number;
		total: number;
		total_pages: number;
	};
}

async function parseResponse<T>(response: Response): Promise<T> {
	if (!response.ok) {
		const errorPayload = (await response
			.json()
			.catch(() => ({ error: 'unknown_error' }))) as unknown;
		throw new Error(readErrorMessage(errorPayload));
	}
	return response.json() as Promise<T>;
}

function readErrorMessage(payload: unknown): string {
	if (!payload || typeof payload !== 'object') return 'Request failed';
	const record = payload as Record<string, unknown>;
	for (const key of ['error_description', 'message', 'error']) {
		const value = record[key];
		if (typeof value === 'string' && value.trim()) return value;
	}
	return 'Request failed';
}

function jsonRequest<T>(path: string, method: string, body?: unknown): Promise<T> {
	return adminFetch(`${API_BASE_URL}${path}`, {
		method,
		includeJsonContentType: body !== undefined,
		body: body === undefined ? undefined : JSON.stringify(body)
	}).then(parseResponse<T>);
}

export const adminFlowsAPI = {
	async list(
		params: {
			kind?: AdminFlowKind;
			status?: AdminFlowStatus;
			search?: string;
			page?: number;
			limit?: number;
		} = {}
	) {
		const search = new URLSearchParams();
		if (params.kind) search.set('kind', params.kind);
		if (params.status) search.set('status', params.status);
		if (params.search) search.set('search', params.search);
		if (params.page) search.set('page', String(params.page));
		if (params.limit) search.set('limit', String(params.limit));
		const query = search.toString();
		const response = await adminFetch(`${API_BASE_URL}/api/admin/flows${query ? `?${query}` : ''}`);
		return parseResponse<FlowListResponse>(response);
	},

	async create(body: {
		slug?: string;
		display_name: string;
		description?: string | null;
		template_id?: string | null;
		kind?: AdminFlowKind;
		editor?: FlowEditorState;
	}) {
		return jsonRequest<{ flow: AdminFlow; validation: FlowValidationResult }>(
			'/api/admin/flows',
			'POST',
			body
		);
	},

	async get(id: string) {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/flows/${encodeURIComponent(id)}`);
		return parseResponse<{ flow: AdminFlow; assignments: FlowAssignment[] }>(response);
	},

	async update(
		id: string,
		body: Partial<Pick<AdminFlow, 'display_name' | 'description' | 'template_id' | 'status'>> & {
			slug?: string;
			kind?: AdminFlowKind;
			editor?: FlowEditorState;
			runtime?: FlowRuntimeContract;
		}
	) {
		return jsonRequest<{ flow: AdminFlow }>(
			`/api/admin/flows/${encodeURIComponent(id)}`,
			'PATCH',
			body
		);
	},

	async delete(id: string) {
		return jsonRequest<{ success: true }>(`/api/admin/flows/${encodeURIComponent(id)}`, 'DELETE');
	},

	async validate(
		id: string,
		body?: { editor?: FlowEditorState; contract?: FlowRuntimeContractPackage }
	) {
		return jsonRequest<FlowValidationResult>(
			`/api/admin/flows/${encodeURIComponent(id)}/validate`,
			'POST',
			body ?? {}
		);
	},

	async publish(id: string) {
		return jsonRequest<{
			version: {
				id: string;
				version_number: number;
				flow_id: string;
				schema_version: string;
				published_at: number;
			};
			validation: FlowValidationResult;
		}>(`/api/admin/flows/${encodeURIComponent(id)}/publish`, 'POST');
	},

	async versions(id: string) {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/flows/${encodeURIComponent(id)}/versions`
		);
		return parseResponse<{ versions: FlowVersion[] }>(response);
	},

	async export(id: string) {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/flows/${encodeURIComponent(id)}/export`
		);
		return parseResponse<FlowRuntimeContractPackage>(response);
	},

	async import(body: FlowRuntimeContractPackage) {
		return jsonRequest<{ flow_id: string; validation: FlowValidationResult }>(
			'/api/admin/flows/import',
			'POST',
			body
		);
	},

	async listAssignments(
		params: {
			flow_id?: string;
			target_type?: AdminFlowAssignmentTargetType;
			target_id?: string;
		} = {}
	) {
		const search = new URLSearchParams();
		if (params.flow_id) search.set('flow_id', params.flow_id);
		if (params.target_type) search.set('target_type', params.target_type);
		if (params.target_id) search.set('target_id', params.target_id);
		const query = search.toString();
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/flow-assignments${query ? `?${query}` : ''}`
		);
		return parseResponse<{ assignments: FlowAssignment[] }>(response);
	},

	async upsertAssignment(body: {
		target_type: AdminFlowAssignmentTargetType;
		target_id?: string | null;
		flow_kind: AdminFlowKind;
		flow_id: string;
		enabled?: boolean;
	}) {
		return jsonRequest<{ success: true }>('/api/admin/flow-assignments', 'PUT', body);
	},

	async deleteAssignment(body: {
		target_type: AdminFlowAssignmentTargetType;
		target_id?: string | null;
		flow_kind: AdminFlowKind;
	}) {
		return jsonRequest<{ success: true }>('/api/admin/flow-assignments', 'DELETE', body);
	}
};
