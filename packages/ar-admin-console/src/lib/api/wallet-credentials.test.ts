import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	FRESH_AUTH_REQUIRED,
	NOT_ELIGIBLE,
	WalletCredentialError,
	httpWalletCredentials,
	walletCredentialErrorKey
} from './wallet-credentials';

afterEach(() => vi.unstubAllGlobals());

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
