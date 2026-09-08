import { adminFetch, API_BASE_URL } from './admin-request';
export interface GuestRetentionPreview {
	preview_token: string;
	expires_at: number;
	policy_version: string;
	deletion_after_days: number | null;
	count: number;
	due_now: number;
	next_cursor: string | null;
	items: Array<{
		user_id: string;
		created_at: number;
		previous_due_at: number | null;
		new_due_at: number | null;
	}>;
}
export interface GuestRetentionResult {
	applied: number;
	unchanged: number;
	skipped: number;
	total: number;
}
async function request<T>(action: string, tenantId: string, body: unknown): Promise<T> {
	const response = await adminFetch(
		`${API_BASE_URL}/api/admin/account-lifecycle/guest-retention/${action}`,
		{ method: 'POST', tenantId, includeJsonContentType: true, body: JSON.stringify(body) }
	);
	if (!response.ok)
		throw new Error(
			response.status === 409 ? 'retention_preview_expired' : 'retention_request_failed'
		);
	return response.json() as Promise<T>;
}
export const adminGuestRetentionAPI = {
	preview: (tenantId: string, cursor?: string) =>
		request<GuestRetentionPreview>('preview', tenantId, { limit: 100, ...(cursor && { cursor }) }),
	apply: (tenantId: string, previewToken: string) =>
		request<GuestRetentionResult>('apply', tenantId, { preview_token: previewToken })
};
