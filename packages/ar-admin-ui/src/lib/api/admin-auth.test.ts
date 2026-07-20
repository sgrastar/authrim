import { beforeEach, describe, expect, it, vi } from 'vitest';

const adminFetch = vi.hoisted(() => vi.fn());

vi.mock('$lib/api/admin-request', () => ({ adminFetch }));

import { adminAuthAPI, AuthError } from './admin-auth';

const handoffId = `alh_${'a'.repeat(32)}`;
const code = `ahc_${'b'.repeat(43)}`;

describe('adminAuthAPI.approveAgentLoginHandoff', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('posts same-origin and accepts only the fixed HTTPS consume contract', async () => {
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
			`/api/admin/agent-login-handoffs/${handoffId}/approve`,
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
