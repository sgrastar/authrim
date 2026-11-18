/**
 * The signed-in admin's first-steps checklist progress (`/api/admin/me/onboarding`): which items
 * are finished, for the selected tenant. Only the progress is on the server; the items are
 * defined in the console (`#lib/onboarding/checklist`).
 */
import { API_BASE_URL, adminFetch } from './admin-request';
import { errorFromResponse } from './api-error';

export interface OnboardingClient {
	/**
	 * The ids of the finished items. `tenantId` names the tenant the call is for; left out, it is
	 * the selected one.
	 */
	list(tenantId?: string): Promise<string[]>;
	complete(itemId: string, tenantId?: string): Promise<string[]>;
	reopen(itemId: string, tenantId?: string): Promise<string[]>;
}

/** The finished item ids of an answer; anything else in it is left out. */
export function completedFromBody(body: unknown): string[] {
	const completed =
		body !== null && typeof body === 'object' ? (body as { completed?: unknown }).completed : null;
	if (!Array.isArray(completed)) return [];
	return completed
		.map((entry) =>
			entry !== null && typeof entry === 'object' ? (entry as { item_id?: unknown }).item_id : null
		)
		.filter((id): id is string => typeof id === 'string');
}

const BASE = `${API_BASE_URL}/api/admin/me/onboarding`;

async function request(path: string, init: RequestInit & { tenantId?: string }): Promise<string[]> {
	const response = await adminFetch(`${BASE}${path}`, init);
	if (!response.ok) throw await errorFromResponse(response);
	return completedFromBody(await response.json());
}

export const httpOnboarding: OnboardingClient = {
	list: (tenantId) => request('', { tenantId }),
	complete: (itemId, tenantId) =>
		request(`/${encodeURIComponent(itemId)}`, { method: 'PUT', tenantId }),
	reopen: (itemId, tenantId) =>
		request(`/${encodeURIComponent(itemId)}`, { method: 'DELETE', tenantId })
};
