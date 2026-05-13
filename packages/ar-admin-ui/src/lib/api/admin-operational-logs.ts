import { API_BASE_URL, adminFetch } from '$lib/api/admin-request';

export interface OperationalLogSummary {
	id: string;
	tenant_id: string;
	subject_type: string;
	subject_id: string;
	actor_id: string;
	action: string;
	request_id?: string | null;
	created_at: number;
	expires_at: number;
	has_detail: boolean;
}

export interface OperationalLogDetail extends Omit<OperationalLogSummary, 'has_detail'> {
	reason_detail: string;
	detail_object_catalog_id?: string | null;
	encryption_key_version: number;
}

async function parseResponse<T>(response: Response, fallbackMessage: string): Promise<T> {
	if (!response.ok) {
		const error = await response.json().catch(() => ({}));
		throw new Error(error.error_description || error.message || error.error || fallbackMessage);
	}
	return response.json() as Promise<T>;
}

export const adminOperationalLogsAPI = {
	async list(params?: {
		subjectType?: string;
		subjectId?: string;
		action?: string;
		actorId?: string;
		limit?: number;
	}) {
		const searchParams = new URLSearchParams();
		if (params?.subjectType) searchParams.set('subject_type', params.subjectType);
		if (params?.subjectId) searchParams.set('subject_id', params.subjectId);
		if (params?.action) searchParams.set('action', params.action);
		if (params?.actorId) searchParams.set('actor_id', params.actorId);
		if (params?.limit) searchParams.set('limit', String(params.limit));

		const query = searchParams.toString();
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/operational-logs${query ? `?${query}` : ''}`
		);
		return parseResponse<{ items: OperationalLogSummary[]; total: number }>(
			response,
			'Failed to load operational logs'
		);
	},

	async get(id: string) {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/operational-logs/${encodeURIComponent(id)}`
		);
		return parseResponse<OperationalLogDetail>(response, 'Failed to load operational log detail');
	}
};
