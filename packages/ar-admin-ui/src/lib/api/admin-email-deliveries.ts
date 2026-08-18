import { API_BASE_URL, adminFetch } from '$lib/api/admin-request';

export type EmailDeliveryStatus =
	| 'requested'
	| 'retrying'
	| 'provider_accepted'
	| 'delivered'
	| 'deferred'
	| 'bounced'
	| 'failed'
	| 'rejected'
	| 'complained'
	| 'unknown'
	| 'expired'
	| 'canceled';

export interface EmailDeliveryRecord {
	intent_id: string;
	account_id: string | null;
	notification_kind: string;
	recipient: string | null;
	recipient_visibility: 'full' | 'masked' | 'none';
	api_status: 'recorded';
	provider_installation_id: string;
	provider_message_id: string | null;
	status: EmailDeliveryStatus;
	final_delivery_tracked: boolean;
	attempts: number;
	last_error_code: string | null;
	requested_at: number | null;
	provider_accepted_at: number | null;
	status_updated_at: number | null;
}

export interface EmailDeliveryListResponse {
	items: EmailDeliveryRecord[];
	recipient_visibility: 'full' | 'masked' | 'none';
}

async function list(path: string): Promise<EmailDeliveryListResponse> {
	const response = await adminFetch(`${API_BASE_URL}${path}`);
	if (!response.ok) {
		const error = await response.json().catch(() => ({}));
		throw new Error(error.error_description || 'Failed to load email delivery status');
	}
	return response.json();
}

export const adminEmailDeliveriesAPI = {
	list(status?: string): Promise<EmailDeliveryListResponse> {
		const query = status ? `?status=${encodeURIComponent(status)}` : '';
		return list(`/api/admin/email-deliveries${query}`);
	},
	listForUser(accountId: string): Promise<EmailDeliveryListResponse> {
		return list(`/api/admin/users/${encodeURIComponent(accountId)}/email-deliveries`);
	}
};
