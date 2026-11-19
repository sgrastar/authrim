// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	canSignalPasskeyRemoval,
	isTenantOfThisHostDeleted,
	rememberPasskeyUserHandle,
	rememberPasskeyUserOfAssertion,
	rememberPasskeyUserOfRegistration,
	rememberedPasskeyUserHandles,
	signalChosenPasskeyRemoved,
	signalRememberedPasskeysRemoved
} from './deleted-tenant';

const STORAGE_KEY = 'authrim:passkey-user-handles';
const HOST = window.location.hostname;

function setPublicKeyCredential(value: unknown) {
	Object.defineProperty(window, 'PublicKeyCredential', {
		value,
		configurable: true,
		writable: true
	});
}

function setCredentials(value: unknown) {
	Object.defineProperty(navigator, 'credentials', { value, configurable: true, writable: true });
}

function signalApi() {
	const api = {
		signalAllAcceptedCredentials: vi.fn().mockResolvedValue(undefined),
		signalUnknownCredential: vi.fn().mockResolvedValue(undefined)
	};
	setPublicKeyCredential(api);
	return api;
}

function answer(body: unknown, ok = true): typeof fetch {
	return vi.fn(async () => ({ ok, json: async () => body }) as Response) as unknown as typeof fetch;
}

beforeEach(() => {
	window.localStorage.clear();
});

afterEach(() => {
	vi.restoreAllMocks();
	setPublicKeyCredential(undefined);
	setCredentials(undefined);
});

describe('remembered passkey owners', () => {
	it('keeps each user handle once, newest last', () => {
		rememberPasskeyUserHandle('dXNlci0x');
		rememberPasskeyUserHandle('dXNlci0y');
		rememberPasskeyUserHandle('dXNlci0x');
		expect(rememberedPasskeyUserHandles()).toEqual(['dXNlci0y', 'dXNlci0x']);
	});

	it('keeps at most eight, dropping the oldest', () => {
		for (let index = 0; index < 10; index++) rememberPasskeyUserHandle(`user-${index}`);
		const kept = rememberedPasskeyUserHandles();
		expect(kept).toHaveLength(8);
		expect(kept[0]).toBe('user-2');
		expect(kept[7]).toBe('user-9');
	});

	it.each([undefined, null, '', 'has space', 'a+b/c=', 'x'.repeat(87)])(
		'ignores %j, which is not a base64url user handle',
		(value) => {
			rememberPasskeyUserHandle(value);
			expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
		}
	);

	it.each(['not json', '{"a":1}', '"text"', '[1, null, "ok", "bad value"]'])(
		'reads only well-formed handles out of stored %j',
		(stored) => {
			window.localStorage.setItem(STORAGE_KEY, stored);
			expect(rememberedPasskeyUserHandles()).toEqual(stored.includes('"ok"') ? ['ok'] : []);
		}
	);

	it('takes the owner from an assertion and from creation options', () => {
		rememberPasskeyUserOfAssertion({ response: { userHandle: 'b3duZXItYQ' } });
		rememberPasskeyUserOfRegistration({ user: { id: 'b3duZXItYg' } });
		rememberPasskeyUserOfAssertion({ response: {} });
		rememberPasskeyUserOfAssertion(null);
		rememberPasskeyUserOfRegistration({ user: { id: 7 } });
		expect(rememberedPasskeyUserHandles()).toEqual(['b3duZXItYQ', 'b3duZXItYg']);
	});

	it('does not throw when storage is blocked', () => {
		vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
			throw new Error('blocked');
		});
		vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
			throw new Error('blocked');
		});
		expect(() => rememberPasskeyUserHandle('dXNlci0x')).not.toThrow();
		expect(rememberedPasskeyUserHandles()).toEqual([]);
	});
});

describe('isTenantOfThisHostDeleted', () => {
	it('is true only for a deleted answer about this very host', async () => {
		const fetcher = answer({ status: 'deleted', host: HOST });
		await expect(isTenantOfThisHostDeleted(fetcher)).resolves.toBe(true);
		expect(fetcher).toHaveBeenCalledWith(
			'/api/auth/tenant-status',
			expect.objectContaining({ method: 'GET', cache: 'no-store', credentials: 'omit' })
		);
	});

	it.each([
		['a deleted answer about another host', { status: 'deleted', host: 'gone.example.com' }],
		['a deleted answer naming no host', { status: 'deleted' }],
		['an unavailable answer', { status: 'unavailable' }],
		['an unavailable answer naming this host', { status: 'unavailable', host: HOST }],
		['an unknown status', { status: 'DELETED', host: HOST }],
		['an error body', { error: 'temporarily_unavailable' }],
		['null', null]
	])('is false for %s', async (_name, body) => {
		await expect(isTenantOfThisHostDeleted(answer(body))).resolves.toBe(false);
	});

	it('is false for a failed response, whatever its body says', async () => {
		const fetcher = answer({ status: 'deleted', host: HOST }, false);
		await expect(isTenantOfThisHostDeleted(fetcher)).resolves.toBe(false);
	});

	it('is false when the request or its body fails', async () => {
		const rejected = vi.fn(async () => {
			throw new Error('offline');
		}) as unknown as typeof fetch;
		await expect(isTenantOfThisHostDeleted(rejected)).resolves.toBe(false);
		const notJson = vi.fn(
			async () =>
				({
					ok: true,
					json: async () => {
						throw new SyntaxError('html');
					}
				}) as unknown as Response
		) as unknown as typeof fetch;
		await expect(isTenantOfThisHostDeleted(notJson)).resolves.toBe(false);
	});
});

describe('signalRememberedPasskeysRemoved', () => {
	it('reports every remembered owner as having no accepted passkey', async () => {
		const api = signalApi();
		rememberPasskeyUserHandle('dXNlci0x');
		rememberPasskeyUserHandle('dXNlci0y');

		await expect(signalRememberedPasskeysRemoved()).resolves.toBe(2);

		expect(api.signalAllAcceptedCredentials.mock.calls.map(([options]) => options)).toEqual([
			{ rpId: HOST, userId: 'dXNlci0x', allAcceptedCredentialIds: [] },
			{ rpId: HOST, userId: 'dXNlci0y', allAcceptedCredentialIds: [] }
		]);
	});

	it('keeps the owners, and reports them again on a later visit', async () => {
		// A resolved call only means the request was handed over; a provider may have dropped it.
		const api = signalApi();
		rememberPasskeyUserHandle('dXNlci0x');

		await signalRememberedPasskeysRemoved();
		expect(rememberedPasskeyUserHandles()).toEqual(['dXNlci0x']);
		await expect(signalRememberedPasskeysRemoved()).resolves.toBe(1);
		expect(api.signalAllAcceptedCredentials).toHaveBeenCalledTimes(2);
	});

	it('does nothing when nobody is remembered', async () => {
		const api = signalApi();
		await expect(signalRememberedPasskeysRemoved()).resolves.toBe(0);
		expect(api.signalAllAcceptedCredentials).not.toHaveBeenCalled();
	});

	it('keeps the owners when the browser cannot report', async () => {
		rememberPasskeyUserHandle('dXNlci0x');
		await expect(signalRememberedPasskeysRemoved()).resolves.toBe(0);
		expect(rememberedPasskeyUserHandles()).toEqual(['dXNlci0x']);
	});

	it('counts only the reports that were handed over', async () => {
		const api = signalApi();
		api.signalAllAcceptedCredentials
			.mockResolvedValueOnce(undefined)
			.mockRejectedValueOnce(new Error('provider refused'));
		rememberPasskeyUserHandle('dXNlci0x');
		rememberPasskeyUserHandle('dXNlci0y');

		await expect(signalRememberedPasskeysRemoved()).resolves.toBe(1);
		expect(rememberedPasskeyUserHandles()).toEqual(['dXNlci0x', 'dXNlci0y']);
	});
});

describe('signalChosenPasskeyRemoved', () => {
	const chosen = (userHandle: ArrayBuffer | null) => ({
		type: 'public-key',
		id: 'Y3JlZGVudGlhbC0x',
		response: { userHandle }
	});

	it('is unsupported without the Signal API or without credential access', async () => {
		await expect(signalChosenPasskeyRemoved()).resolves.toBe('unsupported');
		signalApi();
		await expect(signalChosenPasskeyRemoved()).resolves.toBe('unsupported');
		expect(canSignalPasskeyRemoval()).toBe(true);
	});

	it('reports the picked passkey and the rest of its owner, for this host only', async () => {
		const api = signalApi();
		const get = vi.fn().mockResolvedValue(chosen(new TextEncoder().encode('user-1').buffer));
		setCredentials({ get });

		await expect(signalChosenPasskeyRemoved()).resolves.toBe('signalled');

		const request = get.mock.calls[0][0].publicKey;
		expect(request.rpId).toBe(HOST);
		expect(request.allowCredentials).toEqual([]);
		expect(request.userVerification).toBe('discouraged');
		expect(request.challenge).toHaveLength(32);
		expect(api.signalUnknownCredential).toHaveBeenCalledWith({
			rpId: HOST,
			credentialId: 'Y3JlZGVudGlhbC0x'
		});
		expect(api.signalAllAcceptedCredentials).toHaveBeenCalledWith({
			rpId: HOST,
			userId: 'dXNlci0x',
			allAcceptedCredentialIds: []
		});
	});

	it('reports only the picked passkey when it names no owner', async () => {
		const api = signalApi();
		setCredentials({ get: vi.fn().mockResolvedValue(chosen(null)) });

		await expect(signalChosenPasskeyRemoved()).resolves.toBe('signalled');
		expect(api.signalUnknownCredential).toHaveBeenCalledTimes(1);
		expect(api.signalAllAcceptedCredentials).not.toHaveBeenCalled();
	});

	it('reports nothing when the person cancels', async () => {
		const api = signalApi();
		setCredentials({
			get: vi.fn().mockRejectedValue(new DOMException('cancelled', 'NotAllowedError'))
		});

		await expect(signalChosenPasskeyRemoved()).resolves.toBe('cancelled');
		expect(api.signalUnknownCredential).not.toHaveBeenCalled();
		expect(api.signalAllAcceptedCredentials).not.toHaveBeenCalled();
	});

	it('reports nothing for a credential that is not a passkey', async () => {
		const api = signalApi();
		setCredentials({ get: vi.fn().mockResolvedValue({ type: 'password', id: 'x' }) });

		await expect(signalChosenPasskeyRemoved()).resolves.toBe('cancelled');
		expect(api.signalUnknownCredential).not.toHaveBeenCalled();
	});
});
