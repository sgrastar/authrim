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

	it('sends the opaque cursor without exposing shard details', async () => {
		const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(
				JSON.stringify({
					users: [],
					pagination: { mode: 'cursor', limit: 20, nextCursor: null, hasNext: false }
				}),
				{ status: 200, headers: { 'Content-Type': 'application/json' } }
			)
		);

		await adminUsersAPI.list({ limit: 20, cursor: 'signed.cursor/value' });

		expect(fetchMock.mock.calls[0][0]).toContain('cursor=signed.cursor%2Fvalue');
	});

	it('restarts once without a stale shard-set cursor', async () => {
		const fetchMock = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ error: 'cursor_stale' }), {
					status: 409,
					headers: { 'Content-Type': 'application/json' }
				})
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						users: [],
						pagination: { mode: 'cursor', limit: 20, nextCursor: null, hasNext: false }
					}),
					{ status: 200, headers: { 'Content-Type': 'application/json' } }
				)
			);

		await expect(adminUsersAPI.list({ cursor: 'stale-cursor' })).resolves.toMatchObject({
			pagination: { mode: 'cursor', cursorReset: true }
		});
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(fetchMock.mock.calls[0][0]).toContain('cursor=stale-cursor');
		expect(fetchMock.mock.calls[1][0]).not.toContain('cursor=');
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

	it('keeps an explicit idempotency key on account creation', async () => {
		const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(JSON.stringify({ user: { id: 'user_1' } }), {
				status: 201,
				headers: { 'Content-Type': 'application/json' }
			})
		);

		await expect(
			adminUsersAPI.create(
				{ email: 'person@example.com' },
				{ idempotencyKey: 'account-create-form-1' }
			)
		).resolves.toEqual({ status: 'created', user: { id: 'user_1' } });

		const request = fetchMock.mock.calls[0][1];
		expect(new Headers(request?.headers).get('Idempotency-Key')).toBe('account-create-form-1');
	});

	it('reads and resumes a scoped identifier replacement without exposing it in a query', async () => {
		const fetchMock = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						operations: [
							{
								operation_id: 'identifier-replacement:operation-a',
								authority: 'self_service',
								state: 'blocked_forward_repair',
								attention_required: true,
								error_code: 'identifier_replacement_forward_repair',
								created_at: 1,
								updated_at: 2,
								completed_at: null
							}
						]
					}),
					{ status: 200, headers: { 'Content-Type': 'application/json' } }
				)
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						operation_id: 'identifier-replacement:operation/a',
						state: 'authoritative_switched',
						attention_required: false
					}),
					{ status: 200, headers: { 'Content-Type': 'application/json' } }
				)
			);

		await expect(adminUsersAPI.listIdentifierReplacements('user/a')).resolves.toHaveLength(1);
		await adminUsersAPI.resumeIdentifierReplacement('user/a', 'identifier-replacement:operation/a');

		expect(fetchMock.mock.calls[0][0]).toContain(
			'/api/admin/users/user%2Fa/identifier-replacements'
		);
		expect(fetchMock.mock.calls[1][0]).toContain(
			'/identifier-replacements/identifier-replacement%3Aoperation%2Fa/resume'
		);
		expect(fetchMock.mock.calls[1][1]).toEqual(expect.objectContaining({ method: 'POST' }));
	});

	it('rejects an identifier resume response for another operation', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(
				JSON.stringify({
					operation_id: 'identifier-replacement:other',
					state: 'authoritative_switched',
					attention_required: false
				}),
				{ status: 200, headers: { 'Content-Type': 'application/json' } }
			)
		);

		await expect(
			adminUsersAPI.resumeIdentifierReplacement('user-a', 'identifier-replacement:expected')
		).rejects.toThrow('Invalid identifier operation response');
	});

	it('returns the durable operation when account publication is pending', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(
				JSON.stringify({
					status: 'pending',
					state: 'directory_pending',
					operation_id: 'operation-1',
					status_url: '/api/admin/users/operations/operation-1'
				}),
				{
					status: 202,
					headers: { 'Content-Type': 'application/json' }
				}
			)
		);

		await expect(adminUsersAPI.create({ email: 'person@example.com' })).resolves.toEqual({
			status: 'pending',
			state: 'directory_pending',
			operation_id: 'operation-1',
			status_url: '/api/admin/users/operations/operation-1'
		});
	});

	it('reads an account creation operation status', async () => {
		const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(
				JSON.stringify({
					operation_id: 'operation/slash',
					state: 'succeeded',
					user_id: 'user-1'
				}),
				{ status: 200, headers: { 'Content-Type': 'application/json' } }
			)
		);

		await expect(adminUsersAPI.getCreationOperation('operation/slash')).resolves.toEqual({
			operation_id: 'operation/slash',
			state: 'succeeded',
			user_id: 'user-1'
		});
		expect(fetchMock.mock.calls[0][0]).toContain('/api/admin/users/operations/operation%2Fslash');
	});
});
