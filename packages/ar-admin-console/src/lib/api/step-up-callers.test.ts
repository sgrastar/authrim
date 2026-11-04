import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@simplewebauthn/browser', () => ({
	startAuthentication: vi.fn(async () => ({ id: 'cred' })),
	startRegistration: vi.fn(),
	WebAuthnAbortService: { cancelCeremony: vi.fn() }
}));

import { httpCompliance } from './compliance';
import { myPasskeysAPI, PasskeyError } from './my-passkeys';
import { httpNoticeDelivery } from './notice-delivery';
import { httpSettings } from './settings';

afterEach(() => vi.unstubAllGlobals());

const ok = (body: unknown, status = 200) => Response.json(body, { status });

/**
 * A fetch that refuses the protected call with step-up the first time and accepts it once the
 * receipt is attached. Returns the protected calls seen.
 */
function stubStepUp(protectedPath: string, success: unknown) {
	const protectedCalls: RequestInit[] = [];
	vi.stubGlobal(
		'fetch',
		vi.fn(async (url: string, init: RequestInit = {}) => {
			if (url.endsWith(protectedPath)) {
				protectedCalls.push(init);
				const receipt = new Headers(init.headers).get('authrim-step-up-receipt');
				return receipt
					? ok(success)
					: ok({ error: 'step_up_required', step_up_id: 'su1', missing: ['passkey'] }, 403);
			}
			if (url.endsWith('/options')) return ok({ options: { challenge: 'c' }, challenge_id: 'ch' });
			if (url.endsWith('/receipts')) return ok({ step_up_receipt: 'rcpt-1', expires_at: 1 });
			return ok({ verified: true, authenticated_at: 1 });
		})
	);
	return protectedCalls;
}

const receiptOf = (init: RequestInit) => new Headers(init.headers).get('authrim-step-up-receipt');

describe('protected calls meet step-up and repeat once with the receipt', () => {
	it('settings PATCH', async () => {
		const calls = stubStepUp('/settings/audit', { applied: [] });
		await httpSettings.patch({ level: 'platform' }, 'audit' as never, { changes: [] } as never);
		expect(calls).toHaveLength(2);
		expect(receiptOf(calls[0])).toBeNull();
		expect(receiptOf(calls[1])).toBe('rcpt-1');
		expect(calls[1].body).toBe(calls[0].body);
	});

	it('notice channel create', async () => {
		const calls = stubStepUp('/api/admin/notice-channels', { channel: { id: 'c1' } });
		await httpNoticeDelivery.createChannel({
			kind: 'slack',
			name: 'ops',
			webhook_url: 'https://hooks.slack.com/services/T000/B000/abcdWXYZ'
		} as never);
		expect(calls.map(receiptOf)).toEqual([null, 'rcpt-1']);
	});

	it('notice channel webhook-url replace', async () => {
		const calls = stubStepUp('/webhook-url', { channel: { id: 'c1' } });
		await httpNoticeDelivery.replaceWebhookUrl('c1', 'https://hooks.slack.com/services/T/B/x');
		expect(calls.map(receiptOf)).toEqual([null, 'rcpt-1']);
	});

	it('data-retention PUT', async () => {
		const calls = stubStepUp('/data-retention/categories/lookup_directory', {});
		await httpCompliance.setLookupRetention('t1', { days: 30 } as never);
		expect(calls.map(receiptOf)).toEqual([null, 'rcpt-1']);
	});

	it('passkey registration options', async () => {
		const calls = stubStepUp('/api/admin/me/passkeys/options', {
			options: {},
			challenge_id: 'ch'
		});
		await myPasskeysAPI.getRegistrationOptions('example.com');
		expect(calls.map(receiptOf)).toEqual([null, 'rcpt-1']);
	});

	it('passkey errors stay PasskeyErrors', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => ok({ error: 'forbidden', error_description: 'no' }, 403))
		);
		await expect(myPasskeysAPI.delete('p1')).rejects.toBeInstanceOf(PasskeyError);
	});
});
