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
							aaguid: '08987058-cadc-4b81-b6e1-30de50dcbe96',
							provider: {
								aaguid: '08987058-cadc-4b81-b6e1-30de50dcbe96',
								name: 'Windows Hello',
								icon_dark: null,
								icon_light: 'data:image/svg+xml;base64,light',
								known: true
							},
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
				aaguid: '08987058-cadc-4b81-b6e1-30de50dcbe96',
				provider: {
					aaguid: '08987058-cadc-4b81-b6e1-30de50dcbe96',
					name: 'Windows Hello',
					icon_dark: null,
					icon_light: 'data:image/svg+xml;base64,light',
					known: true
				},
				created_at: 3,
				last_used_at: null
			}
		]);
		expect(user.totp_credentials).toEqual([]);
	});

	it('normalizes user detail TOTP credentials from the admin API response', async () => {
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
					totp_credentials: [
						{
							id: 'totp_1',
							label: 'Work phone',
							algorithm: 'SHA256',
							digits: 8,
							period: 30,
							window: 1,
							status: 'active',
							created_at: 3,
							activated_at: 4,
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

		expect(user.totp_credentials).toEqual([
			{
				id: 'totp_1',
				label: 'Work phone',
				algorithm: 'SHA256',
				digits: 8,
				period: 30,
				window: 1,
				status: 'active',
				created_at: 3,
				activated_at: 4,
				last_used_at: null
			}
		]);
	});

	it('resets a user TOTP credential set through the admin API', async () => {
		const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(JSON.stringify({ ok: true, deleted: 2 }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' }
			})
		);

		await expect(adminUsersAPI.resetTotp('user/slash')).resolves.toEqual({
			ok: true,
			deleted: 2
		});

		expect(fetchMock).toHaveBeenCalledWith(
			expect.stringContaining('/api/admin/users/user%2Fslash/totp/reset'),
			expect.objectContaining({
				method: 'POST',
				body: '{}'
			})
		);
	});
});
