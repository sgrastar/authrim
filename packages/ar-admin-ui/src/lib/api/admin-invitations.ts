import { adminFetch } from '$lib/api/admin-request';

const API_BASE_URL = import.meta.env.PUBLIC_API_BASE_URL || '';

export interface AdminInvitation {
	id: string;
	tenant_id: string;
	email: string;
	name: string | null;
	status: 'pending' | 'accepted' | 'revoked' | 'expired';
	role: { id: string; name: string; display_name: string | null };
	scope_type: 'global' | 'tenant';
	scope_id: string | null;
	role_expires_at: number | null;
	ip_restriction_enabled: boolean;
	allowed_ip_ranges: string[];
	expires_at: number;
	last_sent_at: number;
	last_delivery_status: 'pending' | 'sent' | 'failed';
	accepted_at: number | null;
	created_by: string;
	created_at: number;
	updated_at: number;
}

export interface CreateAdminInvitationInput {
	email: string;
	name?: string;
	role_id: string;
	scope_type: 'global' | 'tenant';
	scope_id?: string;
	ip_restriction_enabled: boolean;
	allowed_ip_ranges: string[];
}

export class AdminInvitationDeliveryError extends Error {
	constructor(
		message: string,
		public invitationId: string
	) {
		super(message);
		this.name = 'AdminInvitationDeliveryError';
	}
}

async function readError(response: Response, fallback: string): Promise<Error> {
	const body = await response.json().catch(() => ({}));
	if (
		body.error === 'email_delivery_failed' &&
		typeof body.invitation_id === 'string' &&
		body.invitation_id
	) {
		return new AdminInvitationDeliveryError(body.error_description || fallback, body.invitation_id);
	}
	return new Error(body.error_description || body.error || fallback);
}

export const adminInvitationsAPI = {
	async list(): Promise<{ items: AdminInvitation[]; total: number }> {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/admin-invitations`, {
			credentials: 'include'
		});
		if (!response.ok) throw await readError(response, 'Failed to load Admin invitations');
		return response.json();
	},

	async create(input: CreateAdminInvitationInput): Promise<{ id: string; expires_at: number }> {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/admin-invitations`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			credentials: 'include',
			body: JSON.stringify(input)
		});
		if (!response.ok) throw await readError(response, 'Failed to invite Admin');
		return response.json();
	},

	async resend(id: string): Promise<{ success: true; expires_at: number }> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/admin-invitations/${encodeURIComponent(id)}/resend`,
			{ method: 'POST', credentials: 'include' }
		);
		if (!response.ok) throw await readError(response, 'Failed to resend Admin invitation');
		return response.json();
	},

	async revoke(id: string): Promise<{ success: true }> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/admin-invitations/${encodeURIComponent(id)}`,
			{ method: 'DELETE', credentials: 'include' }
		);
		if (!response.ok) throw await readError(response, 'Failed to revoke Admin invitation');
		return response.json();
	}
};
