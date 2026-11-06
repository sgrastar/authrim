import { afterEach, describe, expect, it, vi } from 'vitest';

const prompt = vi.hoisted(() => ({ ask: vi.fn() }));
const webauthn = vi.hoisted(() => ({ startAuthentication: vi.fn() }));

vi.mock('#lib/keyring/second-factor-prompt.svelte.js', () => ({ secondFactorPrompt: prompt }));
vi.mock('@simplewebauthn/browser', () => ({
	startAuthentication: webauthn.startAuthentication,
	WebAuthnAbortService: { cancelCeremony: vi.fn() }
}));

import { verifySecondFactor } from './admin-step-up';
import { ApiError } from './api-error';
import { httpKeyringFactor } from './keyring-factor';

const json = (status: number, body: unknown) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' }
	});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.clearAllMocks();
});

const START = {
	request_id: 'g1:apac:0:vp_1',
	qr: 'openid4vp://?client_id=x&request_uri=y',
	match_code: '42',
	expires_at: 1_800_000_000_000
};

describe('httpKeyringFactor', () => {
	it('starts a step-up presentation and reads its progress', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(json(201, START))
			.mockResolvedValueOnce(json(200, { status: 'processing', expires_at: 1 }));
		vi.stubGlobal('fetch', fetchMock);

		await expect(httpKeyringFactor.startStepUp()).resolves.toEqual({
			requestId: 'g1:apac:0:vp_1',
			qr: START.qr,
			matchCode: '42',
			expiresAt: START.expires_at
		});
		await expect(httpKeyringFactor.stepUpProgress('g1:apac:0:vp_1')).resolves.toEqual({
			status: 'processing'
		});
		const [startUrl, startInit] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(startUrl).toBe('/api/admin/me/keyring/step-up');
		expect(startInit.method).toBe('POST');
		expect(fetchMock.mock.calls[1][0]).toBe('/api/admin/me/keyring/step-up/g1%3Aapac%3A0%3Avp_1');
	});

	it('sends the step-up receipt with an enrolment', async () => {
		const fetchMock = vi.fn().mockResolvedValueOnce(json(201, START));
		vi.stubGlobal('fetch', fetchMock);
		await httpKeyringFactor.startEnroll('asp_receipt');
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe('/api/admin/me/keyring/enroll');
		expect(new Headers(init.headers).get('authrim-step-up-receipt')).toBe('asp_receipt');
	});

	it('turns a refused start into an ApiError for withStepUp', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () =>
				json(403, { error: 'step_up_required', step_up_id: 'asr_1', missing: ['second_factor'] })
			)
		);
		const error: unknown = await httpKeyringFactor.startEnroll().catch((e) => e);
		expect(error).toBeInstanceOf(ApiError);
		expect(error).toMatchObject({ status: 403, code: 'step_up_required' });
	});

	it('reads a refused final step of an enrolment as a failed progress', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => json(409, { status: 'failed', error: 'credential_in_use' }))
		);
		await expect(httpKeyringFactor.enrollProgress('id')).resolves.toEqual({
			status: 'failed',
			error: 'credential_in_use'
		});
	});

	it('refuses a response that is not a Keyring presentation', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => json(201, { ...START, qr: 'https://evil' }))
		);
		await expect(httpKeyringFactor.startStepUp()).rejects.toThrow();
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => json(201, { ...START, match_code: '123' }))
		);
		await expect(httpKeyringFactor.startStepUp()).rejects.toThrow();
	});
});

describe('verifySecondFactor', () => {
	function factors(kinds: string[]) {
		return json(200, {
			second_factors: kinds.map((kind, i) => ({ id: `f${i}`, kind, revoked_at: null }))
		});
	}

	it('asks a security key directly when the admin has no Keyring factor', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(factors(['webauthn_credential']))
			.mockResolvedValueOnce(json(200, { options: { challenge: 'c' }, challenge_id: 'ch' }))
			.mockResolvedValueOnce(json(200, { verified: true }));
		vi.stubGlobal('fetch', fetchMock);
		webauthn.startAuthentication.mockResolvedValue({ id: 'cred' });
		await verifySecondFactor();
		expect(prompt.ask).not.toHaveBeenCalled();
		expect(webauthn.startAuthentication).toHaveBeenCalledTimes(1);
	});

	it('lets the admin choose when Keyring is registered, and stops once Keyring verified', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValueOnce(factors(['webauthn_credential', 'keyring_holder_key']))
		);
		prompt.ask.mockResolvedValue('keyring_verified');
		await verifySecondFactor();
		expect(prompt.ask).toHaveBeenCalledWith(expect.objectContaining({ hasSecurityKey: true }));
		expect(webauthn.startAuthentication).not.toHaveBeenCalled();
	});

	it('runs the security key ceremony when the admin picks it', async () => {
		vi.stubGlobal(
			'fetch',
			vi
				.fn()
				.mockResolvedValueOnce(factors(['webauthn_credential', 'keyring_holder_key']))
				.mockResolvedValueOnce(json(200, { options: { challenge: 'c' }, challenge_id: 'ch' }))
				.mockResolvedValueOnce(json(200, { verified: true }))
		);
		prompt.ask.mockResolvedValue('security_key');
		webauthn.startAuthentication.mockResolvedValue({ id: 'cred' });
		await verifySecondFactor();
		expect(webauthn.startAuthentication).toHaveBeenCalledTimes(1);
	});

	it('passes a cancelled prompt on', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(factors(['keyring_holder_key'])));
		const cancelled = Object.assign(new Error('x'), { name: 'NotAllowedError' });
		prompt.ask.mockRejectedValue(cancelled);
		await expect(verifySecondFactor()).rejects.toBe(cancelled);
		expect(prompt.ask).toHaveBeenCalledWith(expect.objectContaining({ hasSecurityKey: false }));
	});
});
