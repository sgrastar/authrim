import { afterEach, describe, expect, it, vi } from 'vitest';
import { adminInvitationsAPI, AdminInvitationDeliveryError } from './admin-invitations';

describe('adminInvitationsAPI', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('preserves the created invitation ID when email delivery fails', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(
				JSON.stringify({
					error: 'email_delivery_failed',
					error_description: 'Email delivery provider failed',
					invitation_id: 'invitation-1'
				}),
				{ status: 502, headers: { 'Content-Type': 'application/json' } }
			)
		);

		const error = await adminInvitationsAPI
			.create({
				email: 'admin@example.com',
				role_id: 'role-admin',
				scope_type: 'tenant',
				ip_restriction_enabled: false,
				allowed_ip_ranges: []
			})
			.catch((cause: unknown) => cause);

		expect(error).toBeInstanceOf(AdminInvitationDeliveryError);
		expect(error).toMatchObject({
			message: 'Email delivery provider failed',
			invitationId: 'invitation-1'
		});
	});
});
