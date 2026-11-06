import { afterEach, describe, expect, it, vi } from 'vitest';

const steps = vi.hoisted(() => ({
	reauthenticate: vi.fn(async () => {}),
	verifySecondFactor: vi.fn(async () => {}),
	issueReceipt: vi.fn(async (_stepUpId: string) => 'asp_receipt')
}));
vi.mock('#lib/api/admin-step-up.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('#lib/api/admin-step-up.js')>();
	return {
		...actual,
		withStepUp: <T>(operation: (receipt?: string) => Promise<T>) =>
			actual.withStepUp(operation, steps)
	};
});
import {
	FRESH_AUTH_REQUIRED,
	NOT_ELIGIBLE,
	WalletCredentialError,
	httpWalletCredentials,
	revokeErrorKey,
	walletCredentialErrorKey
} from './wallet-credentials';

afterEach(() => {
	vi.unstubAllGlobals();
	vi.clearAllMocks();
});

const json = (status: number, body: unknown) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' }
	});

function stubFetch(response: Response) {
	const fetchMock = vi.fn(async () => response);
	vi.stubGlobal('fetch', fetchMock);
	return fetchMock;
}

const OFFER = {
	offerId: 'off_1',
	credentialOffer: 'openid-credential-offer://?credential_offer_uri=https%3A%2F%2Fx',
	transactionCode: '123456',
	expiresAt: 1_800_000_000_000
};

describe('createOffer', () => {
	it('POSTs without a body and returns the offer', async () => {
		const fetchMock = stubFetch(json(201, OFFER));
		await expect(httpWalletCredentials.createOffer()).resolves.toEqual(OFFER);
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe('/api/admin/me/wallet-credentials/offers');
		expect(init.method).toBe('POST');
		expect(init.body).toBeUndefined();
	});

	it('keeps the API error code', async () => {
		stubFetch(json(403, { error: FRESH_AUTH_REQUIRED }));
		await expect(httpWalletCredentials.createOffer()).rejects.toMatchObject({
			name: 'WalletCredentialError',
			code: FRESH_AUTH_REQUIRED,
			status: 403
		});
	});

	it('names a 503 without a body as VC being unavailable', async () => {
		stubFetch(new Response('', { status: 503 }));
		await expect(httpWalletCredentials.createOffer()).rejects.toMatchObject({
			code: 'vc_unavailable'
		});
	});

	it('falls back to the status for an unexplained failure', async () => {
		stubFetch(new Response('boom', { status: 500 }));
		await expect(httpWalletCredentials.createOffer()).rejects.toMatchObject({ code: 'http_500' });
	});

	it('rejects a malformed success body', async () => {
		stubFetch(json(201, { offerId: 'off_1' }));
		await expect(httpWalletCredentials.createOffer()).rejects.toMatchObject({
			code: 'invalid_response'
		});
	});
});

describe('getOfferStatus', () => {
	it('returns the state and the thumbprint when issued', async () => {
		const fetchMock = stubFetch(
			json(200, { offerId: 'off/1', state: 'issued', expiresAt: 5, holderKeyThumbprint: 'abc' })
		);
		await expect(httpWalletCredentials.getOfferStatus('off/1')).resolves.toEqual({
			offerId: 'off/1',
			state: 'issued',
			expiresAt: 5,
			holderKeyThumbprint: 'abc'
		});
		expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe(
			'/api/admin/me/wallet-credentials/offers/off%2F1'
		);
	});

	it('maps an unknown offer to not_found', async () => {
		stubFetch(new Response('', { status: 404 }));
		await expect(httpWalletCredentials.getOfferStatus('x')).rejects.toMatchObject({
			code: 'not_found',
			status: 404
		});
	});

	it('rejects a state it does not know', async () => {
		stubFetch(json(200, { offerId: 'x', state: 'weird', expiresAt: 1 }));
		await expect(httpWalletCredentials.getOfferStatus('x')).rejects.toBeInstanceOf(
			WalletCredentialError
		);
	});
});

describe('walletCredentialErrorKey', () => {
	it('maps the known codes and falls back to the generic message', () => {
		expect(walletCredentialErrorKey(new WalletCredentialError(FRESH_AUTH_REQUIRED, 403))).toBe(
			'keyring.error.freshAuth'
		);
		expect(walletCredentialErrorKey(new WalletCredentialError(NOT_ELIGIBLE, 403))).toBe(
			'keyring.error.notEligible'
		);
		expect(walletCredentialErrorKey(new WalletCredentialError('vc_unavailable', 503))).toBe(
			'keyring.error.unavailable'
		);
		expect(walletCredentialErrorKey(new WalletCredentialError('http_409', 409))).toBe(
			'keyring.error.generic'
		);
		expect(walletCredentialErrorKey(new Error('x'))).toBe('keyring.error.generic');
	});
});

describe('listCredentials', () => {
	it('GETs the list and returns the credentials', async () => {
		const fetchMock = stubFetch(
			json(200, {
				items: [
					{ id: 'c2', status: 'active', issuedAt: 2, expiresAt: 9, holderKeyThumbprint: 'abc' },
					{ id: 'c1', status: 'revoked', issuedAt: 1, expiresAt: null }
				]
			})
		);
		await expect(httpWalletCredentials.listCredentials()).resolves.toEqual([
			{ id: 'c2', status: 'active', issuedAt: 2, expiresAt: 9, holderKeyThumbprint: 'abc' },
			{ id: 'c1', status: 'revoked', issuedAt: 1, expiresAt: null }
		]);
		expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe(
			'/api/admin/me/wallet-credentials'
		);
	});

	it('rejects a malformed list or an unknown status', async () => {
		stubFetch(json(200, { items: [{ id: 'c', status: 'weird', issuedAt: 1, expiresAt: null }] }));
		await expect(httpWalletCredentials.listCredentials()).rejects.toMatchObject({
			code: 'invalid_response'
		});
		stubFetch(json(200, {}));
		await expect(httpWalletCredentials.listCredentials()).rejects.toMatchObject({
			code: 'invalid_response'
		});
	});

	it('keeps the API error code', async () => {
		stubFetch(json(403, { error: 'wallet_credential_home_session_required' }));
		await expect(httpWalletCredentials.listCredentials()).rejects.toMatchObject({
			code: 'wallet_credential_home_session_required',
			status: 403
		});
	});
});

describe('revokeCredential', () => {
	it('POSTs to the revoke path of the encoded id', async () => {
		const fetchMock = stubFetch(json(200, { id: 'c/1', status: 'revoked' }));
		await expect(httpWalletCredentials.revokeCredential('c/1')).resolves.toBeUndefined();
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe('/api/admin/me/wallet-credentials/c%2F1/revoke');
		expect(init.method).toBe('POST');
	});

	it('re-authenticates and repeats the request after a fresh sign-in refusal', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(json(403, { error: FRESH_AUTH_REQUIRED }))
			.mockResolvedValueOnce(json(200, { id: 'c', status: 'revoked' }));
		vi.stubGlobal('fetch', fetchMock);
		await expect(httpWalletCredentials.revokeCredential('c')).resolves.toBeUndefined();
		expect(steps.reauthenticate).toHaveBeenCalledTimes(1);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it('runs the L2 step-up and repeats the request with the receipt', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				json(403, { error: 'step_up_required', step_up_id: 'asr_1', missing: ['second_factor'] })
			)
			.mockResolvedValueOnce(json(200, { id: 'c', status: 'revoked' }));
		vi.stubGlobal('fetch', fetchMock);
		await expect(httpWalletCredentials.revokeCredential('c')).resolves.toBeUndefined();
		expect(steps.verifySecondFactor).toHaveBeenCalledTimes(1);
		expect(steps.issueReceipt).toHaveBeenCalledWith('asr_1');
		const [, init] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
		expect(new Headers(init.headers).get('authrim-step-up-receipt')).toBe('asp_receipt');
	});

	it('keeps the wallet error code for other refusals', async () => {
		stubFetch(json(409, { error: 'wallet_credential_not_revocable' }));
		await expect(httpWalletCredentials.revokeCredential('c')).rejects.toMatchObject({
			code: 'wallet_credential_not_revocable',
			status: 409
		});
		stubFetch(json(404, { error: 'not_found' }));
		await expect(httpWalletCredentials.revokeCredential('c')).rejects.toMatchObject({
			status: 404
		});
	});
});

describe('revokeErrorKey', () => {
	it('maps a fresh sign-in refusal, a concurrent change and anything else', () => {
		expect(revokeErrorKey(new WalletCredentialError(FRESH_AUTH_REQUIRED, 403))).toBe(
			'keyring.error.freshAuth'
		);
		expect(revokeErrorKey(new WalletCredentialError('wallet_credential_unavailable', 503))).toBe(
			'keyring.credentials.error.busy'
		);
		expect(revokeErrorKey(new WalletCredentialError('not_found', 404))).toBe(
			'keyring.error.generic'
		);
		expect(revokeErrorKey(new Error('x'))).toBe('keyring.error.generic');
	});
});
