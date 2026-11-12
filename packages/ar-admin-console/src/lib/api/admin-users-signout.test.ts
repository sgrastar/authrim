import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@simplewebauthn/browser', () => ({
	startAuthentication: vi.fn(async () => ({ id: 'cred' })),
	startRegistration: vi.fn(),
	WebAuthnAbortService: { cancelCeremony: vi.fn() }
}));

import { httpAdminUsers } from './admin-users';

afterEach(() => vi.unstubAllGlobals());

const ok = (body: unknown, status = 200) => Response.json(body, { status });
const receiptOf = (init: RequestInit) => new Headers(init.headers).get('authrim-step-up-receipt');

describe('signing a user out everywhere', () => {
	it('meets the step-up refusal and repeats once with the receipt', async () => {
		const calls: RequestInit[] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string, init: RequestInit = {}) => {
				if (url.endsWith('/users/u1/sessions')) {
					calls.push(init);
					return receiptOf(init)
						? ok({ success: true, revokedCount: 3 })
						: ok(
								{
									error: 'step_up_required',
									step_up_id: 'su1',
									missing: ['passkey'],
									required_level: 'L1'
								},
								403
							);
				}
				if (url.endsWith('/options'))
					return ok({ options: { challenge: 'c' }, challenge_id: 'ch' });
				if (url.endsWith('/receipts')) return ok({ step_up_receipt: 'rcpt-1', expires_at: 1 });
				if (url.includes('/step-up/requirements')) return ok({}, 404);
				return ok({ verified: true, authenticated_at: 1 });
			})
		);
		await expect(httpAdminUsers.revokeSessions('u1')).resolves.toBe(3);
		expect(calls.map((init) => init.method)).toEqual(['DELETE', 'DELETE']);
		expect(calls.map(receiptOf)).toEqual([null, 'rcpt-1']);
	});

	it('passes on a refusal that is not a step-up', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => ok({ error: 'forbidden' }, 403))
		);
		await expect(httpAdminUsers.revokeSessions('u1')).rejects.toMatchObject({ status: 403 });
	});
});
