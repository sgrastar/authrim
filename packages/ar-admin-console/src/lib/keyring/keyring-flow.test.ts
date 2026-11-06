import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	FRESH_AUTH_REQUIRED,
	WalletCredentialError,
	type WalletCredentialsClient,
	type WalletOfferStatus
} from '#lib/api/wallet-credentials.js';
import {
	ISSUANCE_GRACE_MS,
	KeyringFlow,
	MAX_POLL_FAILURES,
	POLL_INTERVAL_MS
} from './keyring-flow.svelte';

const T0 = 1_800_000_000_000;
const OFFER = {
	offerId: 'off_1',
	credentialOffer: 'openid-credential-offer://?credential_offer_uri=https%3A%2F%2Fx',
	transactionCode: '123456',
	expiresAt: T0 + 5 * 60_000
};

function setup(statuses: Array<WalletOfferStatus['state'] | Error> = []) {
	const queue = [...statuses];
	const client: WalletCredentialsClient = {
		createOffer: vi.fn(async () => OFFER),
		getOfferStatus: vi.fn(async (offerId: string) => {
			const next = queue.length > 1 ? queue.shift()! : (queue[0] ?? 'pending');
			if (next instanceof Error) throw next;
			return {
				offerId,
				state: next,
				expiresAt: OFFER.expiresAt,
				...(next === 'issued' ? { holderKeyThumbprint: 'Zm9vYmFy' } : {})
			};
		})
	};
	const flow = new KeyringFlow({ client, now: () => Date.now() });
	return { client, flow };
}

const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(T0);
});
afterEach(() => vi.useRealTimers());

describe('KeyringFlow', () => {
	it('shows only the QR first, and keeps the transaction code hidden', async () => {
		const { flow } = setup(['pending']);
		await flow.start();
		expect(flow.phase).toBe('qr');
		expect(flow.credentialOffer).toBe(OFFER.credentialOffer);
		expect(flow.transactionCode).toBe('');
		await advance(POLL_INTERVAL_MS * 3);
		expect(flow.phase).toBe('qr');
		expect(flow.transactionCode).toBe('');
		flow.destroy();
	});

	it.each(['fetched', 'token_issued'] as const)(
		'swaps the QR for the code when the state is %s',
		async (state) => {
			const { flow } = setup([state]);
			await flow.start();
			await advance(10);
			expect(flow.phase).toBe('code');
			expect(flow.credentialOffer).toBe('');
			expect(flow.transactionCode).toBe('123456');
			flow.destroy();
		}
	);

	it('polls about every two seconds and stops once issued, with the confirmation code', async () => {
		const { client, flow } = setup(['pending', 'fetched', 'issued']);
		await flow.start();
		await advance(10);
		expect(client.getOfferStatus).toHaveBeenCalledTimes(1);
		await advance(POLL_INTERVAL_MS);
		expect(flow.phase).toBe('code');
		await advance(POLL_INTERVAL_MS);
		expect(flow.phase).toBe('issued');
		expect(flow.confirmationCode).toBe('MZXW-6YTB');
		expect(flow.transactionCode).toBe('');
		const calls = vi.mocked(client.getOfferStatus).mock.calls.length;
		await advance(POLL_INTERVAL_MS * 5);
		expect(client.getOfferStatus).toHaveBeenCalledTimes(calls);
	});

	it.each(['failed', 'expired', 'locked'] as const)(
		'ends on %s and drops the secrets',
		async (state) => {
			const { flow } = setup([state]);
			await flow.start();
			await advance(10);
			expect(flow.phase).toBe('ended');
			expect(flow.endReason).toBe(state);
			expect(flow.credentialOffer).toBe('');
			expect(flow.transactionCode).toBe('');
		}
	);

	it('expires locally when the countdown reaches zero and stops polling', async () => {
		const { client, flow } = setup(['pending']);
		await flow.start();
		await advance(5 * 60_000 + 1000);
		expect(flow.phase).toBe('ended');
		expect(flow.endReason).toBe('expired');
		const calls = vi.mocked(client.getOfferStatus).mock.calls.length;
		await advance(10_000);
		expect(client.getOfferStatus).toHaveBeenCalledTimes(calls);
	});

	it('counts down', async () => {
		const { flow } = setup(['pending']);
		await flow.start();
		expect(flow.remainingMs).toBe(5 * 60_000);
		await advance(3000);
		expect(flow.remainingMs).toBe(5 * 60_000 - 3000);
		flow.destroy();
	});

	it('does not poll while hidden and resumes immediately when visible again', async () => {
		const { client, flow } = setup(['pending']);
		await flow.start();
		await advance(10);
		flow.setVisible(false);
		const calls = vi.mocked(client.getOfferStatus).mock.calls.length;
		await advance(POLL_INTERVAL_MS * 5);
		expect(client.getOfferStatus).toHaveBeenCalledTimes(calls);
		flow.setVisible(true);
		await advance(10);
		expect(vi.mocked(client.getOfferStatus).mock.calls.length).toBe(calls + 1);
		flow.destroy();
	});

	it('expires on return when the offer ran out while hidden', async () => {
		const { flow } = setup(['pending']);
		await flow.start();
		flow.setVisible(false);
		vi.setSystemTime(T0 + 6 * 60_000);
		flow.setVisible(true);
		// One last status check decides: still pending, so the code has expired.
		await advance(0);
		expect(flow.phase).toBe('ended');
		expect(flow.endReason).toBe('expired');
	});

	it('stops polling on destroy', async () => {
		const { client, flow } = setup(['pending']);
		await flow.start();
		await advance(10);
		flow.destroy();
		const calls = vi.mocked(client.getOfferStatus).mock.calls.length;
		await advance(POLL_INTERVAL_MS * 5);
		expect(client.getOfferStatus).toHaveBeenCalledTimes(calls);
		expect(flow.credentialOffer).toBe('');
	});

	it('treats an unknown offer as expired', async () => {
		const { flow } = setup([new WalletCredentialError('not_found', 404)]);
		await flow.start();
		await advance(10);
		expect(flow.phase).toBe('ended');
		expect(flow.endReason).toBe('expired');
	});

	it('survives a few failed checks but gives up after too many', async () => {
		const failure = new WalletCredentialError('http_500', 500);
		const { flow } = setup([failure]);
		await flow.start();
		await advance(POLL_INTERVAL_MS * (MAX_POLL_FAILURES - 2));
		expect(flow.phase).toBe('qr');
		await advance(POLL_INTERVAL_MS * 3);
		expect(flow.phase).toBe('ended');
		expect(flow.endReason).toBe('failed');
	});

	it('reports a refused request and can start over', async () => {
		const { client, flow } = setup(['pending']);
		vi.mocked(client.createOffer).mockRejectedValueOnce(
			new WalletCredentialError(FRESH_AUTH_REQUIRED, 403)
		);
		await flow.start();
		expect(flow.phase).toBe('error');
		expect(flow.needsFreshAuth).toBe(true);
		await flow.start();
		expect(flow.phase).toBe('qr');
		expect(flow.error).toBeNull();
		flow.destroy();
	});

	it('starts over with a new offer after the flow ended', async () => {
		const { client, flow } = setup(['locked']);
		await flow.start();
		await advance(10);
		expect(flow.phase).toBe('ended');
		await flow.start();
		expect(client.createOffer).toHaveBeenCalledTimes(2);
		expect(flow.phase).toBe('qr');
		flow.destroy();
	});

	it('follows the server deadline after the token exchange and still shows an issuance', async () => {
		let issued = false;
		const client: WalletCredentialsClient = {
			createOffer: vi.fn(async () => OFFER),
			getOfferStatus: vi.fn(async (offerId: string) =>
				issued
					? {
							offerId,
							state: 'issued' as const,
							expiresAt: OFFER.expiresAt + 60_000,
							holderKeyThumbprint: 'Zm9vYmFy'
						}
					: { offerId, state: 'token_issued' as const, expiresAt: OFFER.expiresAt + 60_000 }
			)
		};
		const flow = new KeyringFlow({ client, now: () => Date.now() });
		await flow.start();
		await advance(OFFER.expiresAt - T0 + 10_000);
		expect(flow.phase).toBe('code');
		issued = true;
		await advance(POLL_INTERVAL_MS * 2);
		expect(flow.phase).toBe('issued');
		expect(flow.confirmationCode).toBe('MZXW-6YTB');
		flow.destroy();
	});

	it('shows an issuance that completed while the tab was hidden past the local deadline', async () => {
		let state: WalletOfferStatus['state'] = 'pending';
		const client: WalletCredentialsClient = {
			createOffer: vi.fn(async () => OFFER),
			getOfferStatus: vi.fn(async (offerId: string) => ({
				offerId,
				state,
				expiresAt: OFFER.expiresAt,
				...(state === 'issued' ? { holderKeyThumbprint: 'Zm9vYmFy' } : {})
			}))
		};
		const flow = new KeyringFlow({ client, now: () => Date.now() });
		await flow.start();
		flow.setVisible(false);
		state = 'issued';
		await advance(OFFER.expiresAt - T0 + 30_000);
		flow.setVisible(true);
		await advance(0);
		expect(flow.phase).toBe('issued');
		expect(flow.confirmationCode).toBe('MZXW-6YTB');
		flow.destroy();
	});

	it('follows an issuance under way past both deadlines until the server ends it', async () => {
		let state: WalletOfferStatus['state'] = 'token_issued';
		const client: WalletCredentialsClient = {
			createOffer: vi.fn(async () => OFFER),
			getOfferStatus: vi.fn(async (offerId: string) => ({
				offerId,
				state,
				expiresAt: OFFER.expiresAt,
				...(state === 'issued' ? { holderKeyThumbprint: 'Zm9vYmFy' } : {})
			}))
		};
		const flow = new KeyringFlow({ client, now: () => Date.now() });
		await flow.start();
		await advance(OFFER.expiresAt - T0 + 20_000);
		expect(flow.phase).toBe('code');
		state = 'issued';
		await advance(POLL_INTERVAL_MS * 2);
		expect(flow.phase).toBe('issued');
		expect(flow.confirmationCode).toBe('MZXW-6YTB');
		flow.destroy();
	});

	it('gives up on an issuance that stays under way beyond the grace period', async () => {
		const { flow } = setup(['token_issued']);
		await flow.start();
		await advance(OFFER.expiresAt - T0 + ISSUANCE_GRACE_MS + POLL_INTERVAL_MS * 2);
		expect(flow.phase).toBe('ended');
		expect(flow.endReason).toBe('expired');
	});

	it('neither decides while hidden nor treats a failed check as expiry', async () => {
		let failing = true;
		const client: WalletCredentialsClient = {
			createOffer: vi.fn(async () => OFFER),
			getOfferStatus: vi.fn(async (offerId: string) => {
				if (failing) throw new Error('network');
				return {
					offerId,
					state: 'issued' as const,
					expiresAt: OFFER.expiresAt,
					holderKeyThumbprint: 'Zm9vYmFy'
				};
			})
		};
		const flow = new KeyringFlow({ client, now: () => Date.now() });
		await flow.start();
		flow.setVisible(false);
		await advance(OFFER.expiresAt - T0 + 30_000);
		// Nothing was decided in the background.
		expect(flow.phase).toBe('qr');
		flow.setVisible(true);
		await advance(POLL_INTERVAL_MS * 2);
		expect(flow.phase).toBe('qr');
		failing = false;
		await advance(POLL_INTERVAL_MS * 2);
		expect(flow.phase).toBe('issued');
		expect(flow.confirmationCode).toBe('MZXW-6YTB');
		flow.destroy();
	});

	it('keeps the final check going when an ordinary poll answers late', async () => {
		let state: WalletOfferStatus['state'] = 'pending';
		let release: (() => void) | undefined;
		let delayNext = false;
		const client: WalletCredentialsClient = {
			createOffer: vi.fn(async () => OFFER),
			getOfferStatus: vi.fn(async (offerId: string) => {
				if (delayNext) {
					delayNext = false;
					await new Promise<void>((resolve) => (release = resolve));
				}
				return {
					offerId,
					state,
					expiresAt: OFFER.expiresAt,
					...(state === 'issued' ? { holderKeyThumbprint: 'Zm9vYmFy' } : {})
				};
			})
		};
		const flow = new KeyringFlow({ client, now: () => Date.now() });
		await flow.start();
		state = 'token_issued';
		await advance(OFFER.expiresAt - T0 - POLL_INTERVAL_MS - 500);
		// An ordinary poll is in flight when the deadline passes.
		delayNext = true;
		await advance(POLL_INTERVAL_MS + 1_000);
		await advance(POLL_INTERVAL_MS);
		release?.();
		await advance(0);
		state = 'issued';
		await advance(POLL_INTERVAL_MS * 2);
		expect(flow.phase).toBe('issued');
		flow.destroy();
	});

	it('runs the issuance grace from a deadline the server extended while hidden', async () => {
		let state: WalletOfferStatus['state'] = 'token_issued';
		const extended = OFFER.expiresAt + 59_000;
		const client: WalletCredentialsClient = {
			createOffer: vi.fn(async () => OFFER),
			getOfferStatus: vi.fn(async (offerId: string) => ({
				offerId,
				state,
				expiresAt: extended,
				...(state === 'issued' ? { holderKeyThumbprint: 'Zm9vYmFy' } : {})
			}))
		};
		const flow = new KeyringFlow({ client, now: () => Date.now() });
		await flow.start();
		flow.setVisible(false);
		// Back after the extended deadline but within its grace, issuance still under way.
		vi.setSystemTime(extended + 41_000);
		flow.setVisible(true);
		await advance(0);
		expect(flow.phase).not.toBe('ended');
		state = 'issued';
		await advance(POLL_INTERVAL_MS * 2);
		expect(flow.phase).toBe('issued');
		flow.destroy();
	});
});
