// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$app/env', () => ({ browser: true }));

const startAuthentication = vi.fn();
vi.mock('@simplewebauthn/browser', () => ({
	startAuthentication: (...args: unknown[]) => startAuthentication(...args)
}));

import { adminFetch } from './admin-request';
import { readStepUpDecision, runWithStepUp } from './admin-step-up';

const json = (body: unknown, status = 200) => Response.json(body, { status });

describe('readStepUpDecision', () => {
	it('recognises fresh-auth and step-up refusals and ignores others', async () => {
		expect(await readStepUpDecision(json({ error: 'admin_fresh_auth_required' }, 403))).toEqual({
			kind: 'fresh_auth'
		});
		expect(
			await readStepUpDecision(
				json({ error: 'step_up_required', step_up_id: 's1', missing: ['passkey', 'x'] }, 403)
			)
		).toEqual({ kind: 'step_up', stepUpId: 's1', missing: ['passkey'] });
		expect(await readStepUpDecision(json({ error: 'forbidden' }, 403))).toBeNull();
		expect(await readStepUpDecision(json({ error: 'admin_fresh_auth_required' }, 401))).toBeNull();
	});
});

describe('runWithStepUp', () => {
	const steps = () => ({
		reauthenticate: vi.fn().mockResolvedValue(undefined),
		verifySecondFactor: vi.fn().mockResolvedValue(undefined),
		issueReceipt: vi.fn().mockResolvedValue('rcpt')
	});

	it('passes success and unrelated errors through without prompting', async () => {
		const s = steps();
		const send = vi.fn().mockResolvedValue(json({ error: 'forbidden' }, 403));
		const res = await runWithStepUp(send, s);
		expect(res.status).toBe(403);
		expect(send).toHaveBeenCalledTimes(1);
		expect(s.reauthenticate).not.toHaveBeenCalled();
	});

	it('re-authenticates then repeats once for L1', async () => {
		const s = steps();
		const send = vi
			.fn()
			.mockResolvedValueOnce(json({ error: 'admin_fresh_auth_required' }, 403))
			.mockResolvedValueOnce(json({ ok: true }));
		const res = await runWithStepUp(send, s);
		expect(res.status).toBe(200);
		expect(s.reauthenticate).toHaveBeenCalledOnce();
		expect(s.issueReceipt).not.toHaveBeenCalled();
		expect(send).toHaveBeenNthCalledWith(2, undefined);
	});

	it('verifies the missing factors, issues a receipt and repeats for L2', async () => {
		const s = steps();
		const send = vi
			.fn()
			.mockResolvedValueOnce(
				json(
					{ error: 'step_up_required', step_up_id: 'su', missing: ['passkey', 'second_factor'] },
					403
				)
			)
			.mockResolvedValueOnce(json({ ok: true }));
		await runWithStepUp(send, s);
		expect(s.reauthenticate).toHaveBeenCalledOnce();
		expect(s.verifySecondFactor).toHaveBeenCalledOnce();
		expect(s.issueReceipt).toHaveBeenCalledWith('su');
		expect(send).toHaveBeenNthCalledWith(2, 'rcpt');
	});

	it('returns the original refusal when a step is cancelled', async () => {
		const s = steps();
		s.reauthenticate.mockRejectedValue(new Error('NotAllowedError'));
		const send = vi.fn().mockResolvedValue(json({ error: 'admin_fresh_auth_required' }, 403));
		const res = await runWithStepUp(send, s);
		expect(res.status).toBe(403);
		expect(await res.json()).toEqual({ error: 'admin_fresh_auth_required' });
		expect(send).toHaveBeenCalledTimes(1);
	});

	it('does not loop when the repeat is refused again', async () => {
		const s = steps();
		const send = vi.fn().mockResolvedValue(json({ error: 'admin_fresh_auth_required' }, 403));
		await runWithStepUp(send, s);
		expect(send).toHaveBeenCalledTimes(2);
	});
});

describe('adminFetch step-up', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		startAuthentication.mockReset();
		startAuthentication.mockResolvedValue({ id: 'cred' });
	});

	it('runs the passkey, security key and receipt flow and repeats the same request', async () => {
		const calls: { url: string; init: RequestInit }[] = [];
		const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
			calls.push({ url, init });
			if (url === '/api/admin/tenants' && calls.filter((c) => c.url === url).length === 1) {
				return json(
					{ error: 'step_up_required', step_up_id: 'su', missing: ['passkey', 'second_factor'] },
					403
				);
			}
			if (url.endsWith('/options'))
				return json({ options: { challenge: 'c' }, challenge_id: 'ch' });
			if (url.endsWith('/receipts')) return json({ step_up_receipt: 'rcpt' });
			return json({ ok: true });
		});
		vi.stubGlobal('fetch', fetchMock);

		const body = new Response('{"name":"t"}').body!;
		const res = await adminFetch('/api/admin/tenants', {
			method: 'POST',
			body,
			headers: { 'Content-Type': 'application/json' }
		});

		expect(res.status).toBe(200);
		expect(startAuthentication).toHaveBeenCalledTimes(2);
		const protectedCalls = calls.filter((c) => c.url === '/api/admin/tenants');
		expect(protectedCalls).toHaveLength(2);
		const first = new Headers(protectedCalls[0].init.headers);
		const second = new Headers(protectedCalls[1].init.headers);
		expect(first.get('authrim-step-up-receipt')).toBeNull();
		expect(second.get('authrim-step-up-receipt')).toBe('rcpt');
		expect(second.get('Idempotency-Key')).not.toBe(first.get('Idempotency-Key'));
		// The stream was buffered, so both attempts carry the full body.
		for (const c of protectedCalls) {
			expect(new TextDecoder().decode(c.init.body as ArrayBuffer)).toBe('{"name":"t"}');
		}
	});

	it('sends a new idempotency key on an L1 repeat, even when the caller chose one', async () => {
		const calls: { url: string; init: RequestInit }[] = [];
		const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
			calls.push({ url, init });
			if (
				url === '/api/admin/clients/c1/regenerate-secret' &&
				calls.filter((c) => c.url === url).length === 1
			) {
				return json({ error: 'admin_fresh_auth_required', fresh_auth_required: true }, 403);
			}
			if (url.endsWith('/options'))
				return json({ options: { challenge: 'c' }, challenge_id: 'ch' });
			return json({ ok: true });
		});
		vi.stubGlobal('fetch', fetchMock);

		const res = await adminFetch('/api/admin/clients/c1/regenerate-secret', {
			method: 'POST',
			headers: { 'Idempotency-Key': 'caller-key' }
		});

		expect(res.status).toBe(200);
		const attempts = calls
			.filter((c) => c.url === '/api/admin/clients/c1/regenerate-secret')
			.map((c) => new Headers(c.init.headers).get('Idempotency-Key'));
		expect(attempts).toHaveLength(2);
		expect(attempts[0]).toBe('caller-key');
		// The stored refusal of the first attempt is not replayed.
		expect(attempts[1]).not.toBe('caller-key');
	});

	it('surfaces the original error when the WebAuthn prompt is cancelled', async () => {
		startAuthentication.mockRejectedValue(new DOMException('cancelled', 'NotAllowedError'));
		const fetchMock = vi.fn(async (url: string) => {
			if (url.endsWith('/options')) return json({ options: {}, challenge_id: 'ch' });
			return json({ error: 'admin_fresh_auth_required' }, 403);
		});
		vi.stubGlobal('fetch', fetchMock);
		const res = await adminFetch('/api/admin/signing-keys', { method: 'POST', body: '{}' });
		expect(res.status).toBe(403);
		expect((await res.json()).error).toBe('admin_fresh_auth_required');
	});
});
