import { get } from 'svelte/store';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LL, setLocale } from '$i18n/i18n-svelte';
import { decideCibaRequest, type CibaDecisionApi } from './ciba-decision';

type Current = Awaited<ReturnType<CibaDecisionApi['getData']>>;

function api(
	result: { error?: { error: string; error_code?: string } } = {},
	current: Current = { data: { status: 'pending' } }
): CibaDecisionApi {
	return {
		approve: vi.fn().mockResolvedValue(result),
		reject: vi.fn().mockResolvedValue(result),
		getData: vi.fn().mockResolvedValue(current)
	};
}

describe('CIBA page outcomes', () => {
	beforeEach(() => {
		setLocale('en');
	});

	it.each([
		['approve', 'ciba_approvedSuccess'],
		['reject', 'ciba_rejectedSuccess']
	] as const)('decides the request: %s', async (decision, key) => {
		const client = api();

		const outcome = await decideCibaRequest(client, 'auth-req-1', decision, get(LL));

		expect(outcome).toEqual({ status: 'decided', message: get(LL)[key]() });
		expect(client[decision]).toHaveBeenCalledWith('auth-req-1');
	});

	it('keeps a request made before access was withdrawn listed, so it can still be denied', async () => {
		const outcome = await decideCibaRequest(
			api({ error: { error: 'consent_withdrawn' } }),
			'auth-req-1',
			'approve',
			get(LL)
		);

		expect(outcome).toEqual({
			status: 'error',
			message: get(LL).ciba_errorConsentWithdrawn(),
			dropRequest: false
		});
	});

	it('keeps the request to try again when the consent state is unavailable', async () => {
		const outcome = await decideCibaRequest(
			api({ error: { error: 'temporarily_unavailable' } }),
			'auth-req-1',
			'approve',
			get(LL)
		);

		expect(outcome).toEqual({
			status: 'error',
			message: get(LL).ciba_errorTryAgain(),
			dropRequest: false
		});
	});

	it.each(['AR060004', 'AR130003'])(
		'drops a request that is gone or already decided (%s)',
		async (errorCode) => {
			const outcome = await decideCibaRequest(
				api({ error: { error: 'invalid_request', error_code: errorCode } }),
				'auth-req-1',
				'reject',
				get(LL)
			);

			expect(outcome).toEqual({
				status: 'error',
				message: get(LL).ciba_errorRequestGone(),
				dropRequest: true
			});
		}
	);

	it.each([
		['approve', 'ciba_errorApproveFailed'],
		['reject', 'ciba_errorDenyFailed']
	] as const)('names the failed step for other errors: %s', async (decision, key) => {
		const outcome = await decideCibaRequest(
			api({ error: { error: 'server_error' } }),
			'auth-req-1',
			decision,
			get(LL)
		);

		expect(outcome).toEqual({ status: 'error', message: get(LL)[key](), dropRequest: false });
	});

	describe('when the answer to a decision is lost', () => {
		const lost = { error: { error: 'network_error' } };

		it('checks the request itself, not the capped pending list', async () => {
			const client = api(lost, { data: { status: 'pending' } });

			await decideCibaRequest(client, 'auth-req-1', 'approve', get(LL));

			expect(client.getData).toHaveBeenCalledWith('auth-req-1');
		});

		it('keeps a request that is still waiting, without claiming nothing was saved', async () => {
			// The original request may still be in flight and decide it after this check.
			const outcome = await decideCibaRequest(
				api(lost, { data: { status: 'pending' } }),
				'auth-req-1',
				'reject',
				get(LL)
			);

			expect(outcome).toEqual({
				status: 'error',
				message: get(LL).ciba_errorOutcomeUnknown(),
				dropRequest: false
			});
		});

		it.each([
			['decided', { data: { status: 'approved' } }],
			['gone or expired', { error: { error: 'invalid_request', error_code: 'AR060004' } }]
		] as const)('drops a request that is %s, without claiming it was saved', async (_l, now) => {
			const outcome = await decideCibaRequest(api(lost, now), 'auth-req-1', 'approve', get(LL));

			expect(outcome).toEqual({
				status: 'error',
				message: get(LL).ciba_errorNoLongerWaiting(),
				dropRequest: true
			});
		});

		it('keeps the request when the store cannot be read right now (503)', async () => {
			const outcome = await decideCibaRequest(
				api(lost, { error: { error: 'temporarily_unavailable' } }),
				'auth-req-1',
				'approve',
				get(LL)
			);

			expect(outcome).toEqual({
				status: 'error',
				message: get(LL).ciba_errorOutcomeUnknown(),
				dropRequest: false
			});
		});

		it('says the outcome is unknown when the request cannot be read either', async () => {
			const outcome = await decideCibaRequest(
				api({ error: { error: 'timeout' } }, { error: { error: 'network_error' } }),
				'auth-req-1',
				'approve',
				get(LL)
			);

			expect(outcome).toEqual({
				status: 'error',
				message: get(LL).ciba_errorOutcomeUnknown(),
				dropRequest: false
			});
		});
	});
});
