import { beforeEach, describe, expect, it, vi } from 'vitest';

const adminFetch = vi.hoisted(() => vi.fn());

vi.mock('#lib/api/admin-request.js', () => ({ adminFetch }));

import { adminAuthAPI, authErrorKey } from './admin-auth';

const apiBaseUrl = import.meta.env.PUBLIC_API_BASE_URL || '';

describe('adminAuthAPI wallet login', () => {
	const requestId = 'g1:apac:3:vp_6f1c2a10-9a47-4d1b-8f7e-0c4d5a6b7c8d';

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('starts a login with the cookie-bearing credentials mode and maps the response', async () => {
		adminFetch.mockResolvedValue(
			new Response(
				JSON.stringify({
					request_id: requestId,
					expires_at: 1_700_000_000,
					deep_link: 'haip-vp://x'
				}),
				{ status: 200, headers: { 'Content-Type': 'application/json' } }
			)
		);

		await expect(adminAuthAPI.startWalletLogin()).resolves.toEqual({
			requestId,
			expiresAt: 1_700_000_000,
			deepLink: 'haip-vp://x'
		});
		expect(adminFetch).toHaveBeenCalledWith(
			`${apiBaseUrl}/api/admin/auth/wallet-login/start`,
			expect.objectContaining({
				method: 'POST',
				credentials: 'include',
				body: JSON.stringify({ flow: 'same_device' })
			})
		);
	});

	it('rejects a start response with a malformed request id', async () => {
		adminFetch.mockResolvedValue(
			new Response(JSON.stringify({ request_id: '../x', expires_at: 1 }), { status: 200 })
		);
		await expect(adminAuthAPI.startWalletLogin()).rejects.toMatchObject({
			code: 'wallet_login_failed'
		});
	});

	it('surfaces the server error code on completion', async () => {
		adminFetch.mockResolvedValue(
			new Response(JSON.stringify({ error: 'wallet_login_not_allowed' }), { status: 403 })
		);
		await expect(adminAuthAPI.completeWalletLogin(requestId, 'code')).rejects.toMatchObject({
			code: 'wallet_login_not_allowed'
		});
		expect(adminFetch).toHaveBeenCalledWith(
			`${apiBaseUrl}/api/admin/auth/wallet-login/complete`,
			expect.objectContaining({
				body: JSON.stringify({ request_id: requestId, response_code: 'code' })
			})
		);
	});

	it('reads the progress with an encoded request id', async () => {
		adminFetch.mockResolvedValue(
			new Response(JSON.stringify({ status: 'processing' }), { status: 200 })
		);
		await expect(adminAuthAPI.getWalletLoginStatus(requestId)).resolves.toBe('processing');
		expect(adminFetch.mock.calls[0][0]).toBe(
			`${apiBaseUrl}/api/admin/auth/wallet-login/status?request_id=${encodeURIComponent(requestId)}`
		);
	});
});

describe('authErrorKey for wallet login', () => {
	it('maps the server codes to their own messages', async () => {
		adminFetch.mockResolvedValue(
			new Response(JSON.stringify({ error: 'wallet_login_not_allowed' }), { status: 403 })
		);
		const error = await adminAuthAPI
			.completeWalletLogin('g1:apac:3:vp_x'.padEnd(20, 'x'))
			.catch((e) => e);
		expect(authErrorKey(error)).toBe('login.error.walletNotAllowed');
	});
});
