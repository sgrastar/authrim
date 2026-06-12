import { afterEach, describe, expect, it, vi } from 'vitest';
import { adminUsersAPI } from './admin-users';

describe('adminUsersAPI', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('normalizes user detail passkeys from the admin API response', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(
				JSON.stringify({
					user: {
						id: 'user_1',
						tenant_id: 'first',
						email: 'user@example.com',
						name: 'User One',
						given_name: null,
						family_name: null,
						nickname: null,
						preferred_username: null,
						picture: null,
						phone_number: null,
						email_verified: false,
						phone_number_verified: false,
						user_type: 'end_user',
						is_active: true,
						pii_partition: 'default',
						pii_status: 'active',
						created_at: 1,
						updated_at: 2,
						last_login_at: null,
						status: 'active',
						suspended_at: null,
						suspended_until: null,
						locked_at: null,
						locked_until: null
					},
					passkeys: [
						{
							id: 'passkey_1',
							device_name: 'Chrome on macOS',
							created_at: 3,
							last_used_at: null
						}
					]
				}),
				{
					status: 200,
					headers: { 'Content-Type': 'application/json' }
				}
			)
		);

		const user = await adminUsersAPI.get('user_1');

		expect(user.passkeys).toEqual([
			{
				id: 'passkey_1',
				device_name: 'Chrome on macOS',
				created_at: 3,
				last_used_at: null
			}
		]);
	});
});
