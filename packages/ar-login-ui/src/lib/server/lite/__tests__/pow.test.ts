import { describe, expect, it, vi } from 'vitest';
import { createLiteBackendClient } from '../backend-client';
import { fetchLitePowChallenge } from '../pow';

function backend(response: Response) {
	const fetch = vi.fn(async () => response);
	return {
		fetch,
		client: createLiteBackendClient({
			fetcher: { fetch },
			publicOrigin: 'https://id.example',
			backendBaseUrl: 'https://backend.internal/',
			cookieHeader: null,
			clientIp: null,
			originVerified: false,
			mode: 'page_load'
		})
	};
}

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const good = {
	algorithm: 'SHA-256',
	challenge: 'a'.repeat(64),
	maxnumber: 25000,
	salt: 's?expires=1&',
	signature: 'sig'
};

describe('fetchLitePowChallenge', () => {
	it('reads the challenge and its policy revision (a GET, allowed on a page view)', async () => {
		const { client, fetch } = backend(json({ challenge: good, policy_revision: 'rev-1' }));
		await expect(fetchLitePowChallenge(client, 'login')).resolves.toEqual({
			ok: true,
			challenge: good,
			policyRevision: 'rev-1'
		});
		expect((fetch.mock.calls[0] as unknown as [string])[0]).toBe(
			'https://id.example/api/auth/human-verification/pow-challenge?action=login'
		);
	});

	it('tells a tenant not in lite mode from a failure, and refuses a malformed challenge', async () => {
		await expect(fetchLitePowChallenge(backend(json({}, 404)).client, 'login')).resolves.toEqual({
			ok: false,
			reason: 'not_lite'
		});
		for (const answer of [
			json({ error: 'rate_limit_exceeded' }, 429),
			json({ challenge: { ...good, algorithm: 'MD5' }, policy_revision: 'r' }),
			json({ challenge: { ...good, challenge: 'zz' }, policy_revision: 'r' }),
			json({ challenge: good })
		]) {
			await expect(fetchLitePowChallenge(backend(answer).client, 'login')).resolves.toEqual({
				ok: false,
				reason: 'unavailable'
			});
		}
	});
});
