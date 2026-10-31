import { adminFetch, API_BASE_URL } from './admin-request';
export interface GuestLifecycleItem {
	user_id: string;
	phase: 'active' | 'upgrading' | 'registered' | 'deleting' | 'deleted';
	created_at: number;
	deletion_due_at: number | null;
	upgrade_hold_until: number | null;
	upgraded_at: number | null;
	deleted_at: number | null;
	updated_at: number;
	overdue_seconds: number;
	maintenance: {
		state: 'processing' | 'pending' | 'completed' | 'retrying';
		attempted_at: number;
	} | null;
}
export interface GuestLifecyclePage {
	items: GuestLifecycleItem[];
	next_cursor: string | null;
	observed_at: number;
}
export async function listGuestLifecycle(
	tenantId: string,
	cursor?: string
): Promise<GuestLifecyclePage> {
	const query = new URLSearchParams({ limit: '100', ...(cursor ? { cursor } : {}) });
	const response = await adminFetch(`${API_BASE_URL}/api/admin/account-lifecycle/guests?${query}`, {
		tenantId
	});
	if (!response.ok) throw new Error('lifecycle_inspection_unavailable');
	return response.json();
}
