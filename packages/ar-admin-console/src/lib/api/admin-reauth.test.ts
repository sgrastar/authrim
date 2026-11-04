import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const browser = vi.hoisted(() => ({
	startAuthentication: vi.fn(),
	cancelCeremony: vi.fn()
}));

vi.mock('@simplewebauthn/browser', () => ({
	startAuthentication: browser.startAuthentication,
	WebAuthnAbortService: { cancelCeremony: browser.cancelCeremony }
}));

import { ApiError } from './api-error';
import { isFreshAuthRequired, reauthenticateWithPasskey, withFreshAuth } from './admin-reauth';

function json(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' }
	});
}

describe('isFreshAuthRequired', () => {
	it.each([
		['a *_fresh_auth_required code', new ApiError(403, 'backup_fresh_auth_required', 'x'), true],
		[
			'a fresh_auth_required flag',
			new ApiError(403, 'forbidden', 'x', { fresh_auth_required: true }),
			true
		],
		['another 403', new ApiError(403, 'forbidden', 'x'), false],
		['a 401 with the code', new ApiError(401, 'fresh_auth_required', 'x'), false],
		['a plain error', new Error('fresh_auth_required'), false]
	])('recognises %s', (_label, error, expected) => {
		expect(isFreshAuthRequired(error)).toBe(expected);
	});
});

describe('withFreshAuth', () => {
	it('re-authenticates once and repeats a refused operation', async () => {
		const operation = vi
			.fn()
			.mockRejectedValueOnce(new ApiError(403, 'wallet_credential_fresh_auth_required', 'x'))
			.mockResolvedValueOnce('done');
		const reauthenticate = vi.fn().mockResolvedValue(undefined);

		await expect(withFreshAuth(operation, reauthenticate)).resolves.toBe('done');
		expect(reauthenticate).toHaveBeenCalledOnce();
		expect(operation).toHaveBeenCalledTimes(2);
	});

	it('passes a second refusal on without asking again', async () => {
		const refusal = new ApiError(403, 'backup_fresh_auth_required', 'x');
		const operation = vi.fn().mockRejectedValue(refusal);
		const reauthenticate = vi.fn().mockResolvedValue(undefined);

		await expect(withFreshAuth(operation, reauthenticate)).rejects.toBe(refusal);
		expect(reauthenticate).toHaveBeenCalledOnce();
	});

	it('leaves other failures alone', async () => {
		const failure = new ApiError(403, 'forbidden', 'x');
		const reauthenticate = vi.fn();

		await expect(withFreshAuth(() => Promise.reject(failure), reauthenticate)).rejects.toBe(
			failure
		);
		expect(reauthenticate).not.toHaveBeenCalled();
	});

	it('does not repeat the operation when re-authentication fails', async () => {
		const operation = vi.fn().mockRejectedValue(new ApiError(403, 'x_fresh_auth_required', 'x'));
		const cancelled = new Error('NotAllowedError');

		await expect(withFreshAuth(operation, () => Promise.reject(cancelled))).rejects.toBe(cancelled);
		expect(operation).toHaveBeenCalledOnce();
	});
});

describe('reauthenticateWithPasskey', () => {
	const fetchMock = vi.fn();

	beforeEach(() => {
		vi.stubGlobal('fetch', fetchMock);
		fetchMock.mockReset();
		browser.startAuthentication.mockReset();
	});

	afterEach(() => vi.unstubAllGlobals());

	it('runs the ceremony for the page RP ID and verifies it', async () => {
		fetchMock
			.mockResolvedValueOnce(json(200, { options: { challenge: 'c' }, challenge_id: 'ch-1' }))
			.mockResolvedValueOnce(json(200, { verified: true, authenticated_at: 123 }));
		browser.startAuthentication.mockResolvedValue({ id: 'credential-1' });

		await expect(reauthenticateWithPasskey()).resolves.toEqual({
			verified: true,
			authenticated_at: 123
		});

		const [optionsUrl, optionsInit] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(optionsUrl).toBe('/api/admin/me/reauth/passkey/options');
		expect(JSON.parse(String(optionsInit.body))).toEqual({ rp_id: window.location.hostname });
		expect(optionsInit.credentials).toBe('include');
		expect(browser.startAuthentication).toHaveBeenCalledWith({
			optionsJSON: { challenge: 'c' }
		});
		const [verifyUrl, verifyInit] = fetchMock.mock.calls[1] as [string, RequestInit];
		expect(verifyUrl).toBe('/api/admin/me/reauth/passkey/verify');
		expect(JSON.parse(String(verifyInit.body))).toEqual({
			challenge_id: 'ch-1',
			credential: { id: 'credential-1' }
		});
	});

	it('reports a refused request as an ApiError with its code', async () => {
		fetchMock.mockResolvedValueOnce(json(400, { error: 'no_reauth_method' }));

		const failure = await reauthenticateWithPasskey().catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(ApiError);
		expect(failure).toMatchObject({ status: 400, code: 'no_reauth_method' });
		expect(browser.startAuthentication).not.toHaveBeenCalled();
	});
});
