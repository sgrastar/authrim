import { afterEach, describe, expect, it, vi } from 'vitest';

const prompt = vi.hoisted(() => ({ ask: vi.fn() }));
const webauthn = vi.hoisted(() => ({ startAuthentication: vi.fn() }));

vi.mock('#lib/keyring/second-factor-prompt.svelte.js', () => ({ secondFactorPrompt: prompt }));
vi.mock('@simplewebauthn/browser', () => ({
	startAuthentication: webauthn.startAuthentication,
	WebAuthnAbortService: { cancelCeremony: vi.fn() }
}));

import { verifySecondFactor, verifyTotpCode } from './admin-step-up';
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

	it('asks for a browser request and submits the answer the browser gave', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				json(201, {
					request_id: 'r1',
					dc_request: { protocol: 'openid4vp-v1-signed', data: { request: 'h.p.s' } },
					expires_at: 1
				})
			)
			.mockResolvedValueOnce(json(200, { status: 'verified', verified_at: 2 }));
		vi.stubGlobal('fetch', fetchMock);
		await expect(httpKeyringFactor.startStepUpInBrowser()).resolves.toEqual({
			requestId: 'r1',
			expiresAt: 1,
			dcRequest: { protocol: 'openid4vp-v1-signed', data: { request: 'h.p.s' } }
		});
		expect(JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body))).toEqual({
			mode: 'dc_api'
		});
		await expect(httpKeyringFactor.submitStepUp('r1', { response: 'jwe' })).resolves.toEqual({
			status: 'verified'
		});
		const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
		expect(url).toBe('/api/admin/me/keyring/step-up/r1/response');
		expect(JSON.parse(String(init.body))).toEqual({ response: { response: 'jwe' } });
	});

	it('sends the step-up receipt with an enrolment', async () => {
		const fetchMock = vi.fn().mockResolvedValueOnce(json(201, START));
		vi.stubGlobal('fetch', fetchMock);
		await httpKeyringFactor.startEnroll('asp_receipt');
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe('/api/admin/me/keyring/enroll');
		expect(new Headers(init.headers).get('authrim-step-up-receipt')).toBe('asp_receipt');
	});

	it('starts a recovery as an enrolment with the recovery purpose and no receipt', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(json(201, START))
			.mockResolvedValueOnce(
				json(201, {
					request_id: 'r1',
					dc_request: { protocol: 'openid4vp-v1-signed', data: { request: 'h.p.s' } },
					expires_at: 1
				})
			);
		vi.stubGlobal('fetch', fetchMock);
		await httpKeyringFactor.startRecovery();
		await httpKeyringFactor.startRecoveryInBrowser();
		const bodies = (fetchMock.mock.calls as Array<[string, RequestInit]>).map(([url, init]) => {
			expect(url).toBe('/api/admin/me/keyring/enroll');
			expect(new Headers(init.headers).has('authrim-step-up-receipt')).toBe(false);
			return JSON.parse(String(init.body)) as unknown;
		});
		expect(bodies).toEqual([{ purpose: 'recovery' }, { mode: 'dc_api', purpose: 'recovery' }]);
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

describe('verifySecondFactor with an authenticator app', () => {
	function state(kinds: string[], totpAllowed: boolean) {
		return json(200, {
			second_factors: kinds.map((kind, i) => ({ id: `f${i}`, kind, revoked_at: null })),
			totp: { allowed: totpAllowed }
		});
	}

	it('asks for the code, with a way to check it, when only an authenticator app is registered', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(state(['totp'], true)));
		prompt.ask.mockResolvedValue('totp_verified');

		await verifySecondFactor();

		expect(prompt.ask).toHaveBeenCalledWith(
			expect.objectContaining({
				hasSecurityKey: false,
				hasKeyring: false,
				hasTotp: true,
				verifyTotp: verifyTotpCode
			})
		);
		expect(webauthn.startAuthentication).not.toHaveBeenCalled();
	});

	it('offers it beside a security key, and runs the key when that is picked', async () => {
		vi.stubGlobal(
			'fetch',
			vi
				.fn()
				.mockResolvedValueOnce(state(['webauthn_credential', 'totp'], true))
				.mockResolvedValueOnce(json(200, { allowed_second_factor_kinds: ['hardware', 'totp'] }))
				.mockResolvedValueOnce(json(200, { options: { challenge: 'c' }, challenge_id: 'ch' }))
				.mockResolvedValueOnce(json(200, { verified: true }))
		);
		prompt.ask.mockResolvedValue('security_key');
		webauthn.startAuthentication.mockResolvedValue({ id: 'cred' });

		await verifySecondFactor();

		expect(prompt.ask).toHaveBeenCalledWith(
			expect.objectContaining({ hasSecurityKey: true, hasKeyring: false, hasTotp: true })
		);
		expect(webauthn.startAuthentication).toHaveBeenCalledTimes(1);
	});

	it('judges the selected tenant, not the session tenant, when the requirements say', async () => {
		// The session tenant allows it, but the tenant being acted on lists hardware only.
		vi.stubGlobal(
			'fetch',
			vi
				.fn()
				.mockResolvedValueOnce(state(['webauthn_credential', 'totp'], true))
				.mockResolvedValueOnce(json(200, { allowed_second_factor_kinds: ['hardware'] }))
				.mockResolvedValueOnce(json(200, { options: { challenge: 'c' }, challenge_id: 'ch' }))
				.mockResolvedValueOnce(json(200, { verified: true }))
		);
		webauthn.startAuthentication.mockResolvedValue({ id: 'cred' });

		await verifySecondFactor();
		expect(prompt.ask).not.toHaveBeenCalled();

		// And the other way round: allowed where the operation acts, though not at home.
		prompt.ask.mockResolvedValue('totp_verified');
		vi.stubGlobal(
			'fetch',
			vi
				.fn()
				.mockResolvedValueOnce(state(['totp'], false))
				.mockResolvedValueOnce(json(200, { allowed_second_factor_kinds: ['hardware', 'totp'] }))
		);
		await verifySecondFactor();
		expect(prompt.ask).toHaveBeenCalledWith(expect.objectContaining({ hasTotp: true }));
	});

	it('does not offer it where the tenant does not allow authenticator apps', async () => {
		vi.stubGlobal(
			'fetch',
			vi
				.fn()
				.mockResolvedValueOnce(state(['webauthn_credential', 'totp'], false))
				.mockResolvedValueOnce(json(200, { allowed_second_factor_kinds: ['hardware'] }))
				.mockResolvedValueOnce(json(200, { options: { challenge: 'c' }, challenge_id: 'ch' }))
				.mockResolvedValueOnce(json(200, { verified: true }))
		);
		webauthn.startAuthentication.mockResolvedValue({ id: 'cred' });

		await verifySecondFactor();

		expect(prompt.ask).not.toHaveBeenCalled();
		expect(webauthn.startAuthentication).toHaveBeenCalledTimes(1);
	});

	it('also offers it beside Keyring, and stops once the code was accepted', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValueOnce(state(['keyring_holder_key', 'totp'], true))
		);
		prompt.ask.mockResolvedValue('totp_verified');

		await verifySecondFactor();

		expect(prompt.ask).toHaveBeenCalledWith(
			expect.objectContaining({ hasKeyring: true, hasTotp: true })
		);
		expect(webauthn.startAuthentication).not.toHaveBeenCalled();
	});

	it('posts the code to the Admin API, and passes a refusal on with its code', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(json(200, { verified: true, verified_at: 1 }))
			.mockResolvedValueOnce(json(400, { error: 'verification_failed' }));
		vi.stubGlobal('fetch', fetchMock);

		await verifyTotpCode('123456');
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toMatch(/\/api\/admin\/me\/second-factors\/totp\/verify$/u);
		expect(init.method).toBe('POST');
		expect(JSON.parse(String(init.body))).toEqual({ code: '123456' });

		await expect(verifyTotpCode('000000')).rejects.toMatchObject({
			status: 400,
			code: 'verification_failed'
		});
	});
});
