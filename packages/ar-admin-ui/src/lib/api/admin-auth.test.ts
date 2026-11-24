import { beforeEach, describe, expect, it, vi } from 'vitest';

const adminFetch = vi.hoisted(() => vi.fn());

vi.mock('#lib/api/admin-request.js', () => ({ adminFetch }));

import { adminAuthAPI, AuthError } from './admin-auth';

const handoffId = `alh_${'a'.repeat(32)}`;
const code = `ahc_${'b'.repeat(43)}`;
const apiBaseUrl = import.meta.env.PUBLIC_API_BASE_URL || '';

describe('adminAuthAPI.approveAgentLoginHandoff', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('posts to the configured Admin API and accepts only the fixed HTTPS consume contract', async () => {
		adminFetch.mockResolvedValue(
			new Response(
				JSON.stringify({
					consume_url: `https://tenant.example.com/oauth/admin-agent/login-handoff/consume?code=${code}`
				}),
				{ status: 200, headers: { 'Content-Type': 'application/json' } }
			)
		);

		await expect(adminAuthAPI.approveAgentLoginHandoff(handoffId)).resolves.toBe(
			`https://tenant.example.com/oauth/admin-agent/login-handoff/consume?code=${code}`
		);
		expect(adminFetch).toHaveBeenCalledWith(
			`${apiBaseUrl}/api/admin/agent-login-handoffs/${handoffId}/approve`,
			expect.objectContaining({ method: 'POST', skipTenantHeader: true, credentials: 'include' })
		);
	});

	it.each([
		`http://tenant.example.com/oauth/admin-agent/login-handoff/consume?code=${code}`,
		`https://user@tenant.example.com/oauth/admin-agent/login-handoff/consume?code=${code}`,
		`https://tenant.example.com/oauth/admin-agent/login-handoff/consume?code=${code}&next=evil`,
		`https://tenant.example.com/oauth/admin-agent/login-handoff/consume?code=invalid`,
		`https://tenant.example.com/other?code=${code}`
	])('rejects an untrusted consume URL: %s', async (consumeUrl) => {
		adminFetch.mockResolvedValue(
			new Response(JSON.stringify({ consume_url: consumeUrl }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' }
			})
		);

		await expect(adminAuthAPI.approveAgentLoginHandoff(handoffId)).rejects.toMatchObject({
			code: 'invalid_response'
		});
	});

	it('rejects an invalid identifier before making a request', async () => {
		await expect(adminAuthAPI.approveAgentLoginHandoff('alh_short')).rejects.toBeInstanceOf(
			AuthError
		);
		expect(adminFetch).not.toHaveBeenCalled();
	});
});

describe('adminAuthAPI wallet login', () => {
	const requestId = 'g1:apac:3:vp_6f1c2a10-9a47-4d1b-8f7e-0c4d5a6b7c8d';

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('starts a login with the cookie-bearing credentials mode and maps the response', async () => {
		adminFetch.mockResolvedValue(
			new Response(
				JSON.stringify({ request_id: requestId, expires_at: 1_700_000_000, qr: 'openid4vp://x' }),
				{ status: 200, headers: { 'Content-Type': 'application/json' } }
			)
		);

		await expect(adminAuthAPI.startWalletLogin('cross_device')).resolves.toEqual({
			requestId,
			expiresAt: 1_700_000_000,
			qr: 'openid4vp://x'
		});
		expect(adminFetch).toHaveBeenCalledWith(
			`${apiBaseUrl}/api/admin/auth/wallet-login/start`,
			expect.objectContaining({
				method: 'POST',
				credentials: 'include',
				body: JSON.stringify({ flow: 'cross_device' })
			})
		);
	});

	it('rejects a start response with a malformed request id', async () => {
		adminFetch.mockResolvedValue(
			new Response(JSON.stringify({ request_id: '../x', expires_at: 1 }), { status: 200 })
		);
		await expect(adminAuthAPI.startWalletLogin('same_device')).rejects.toMatchObject({
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
