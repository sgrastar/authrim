import { get } from 'svelte/store';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LL, setLocale } from '$i18n/i18n-svelte';
import {
	createDeviceFlow,
	decideDeviceCode,
	lookUpDeviceCode,
	type DeviceDecisionApi,
	type DeviceFlowState
} from './device-decision';

type LookupResult = Awaited<ReturnType<DeviceDecisionApi['lookup']>>;

const details = (client_name: string) => ({
	client_id: `${client_name}-id`,
	client_name,
	scopes: ['openid'],
	expires_at: 1
});

function api(overrides: Partial<DeviceDecisionApi> = {}): DeviceDecisionApi {
	return {
		lookup: vi.fn().mockResolvedValue({
			data: {
				client_id: 'client-1',
				client_name: 'Acme TV',
				client_uri: 'https://tv.example.com',
				scopes: ['openid', 'profile'],
				expires_at: 1
			}
		}),
		approve: vi.fn().mockResolvedValue({ data: { success: true } }),
		deny: vi.fn().mockResolvedValue({ data: { success: true } }),
		...overrides
	};
}

/** A promise the test resolves itself, to hold a request in flight. */
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => (resolve = done));
	return { promise, resolve };
}

function flowWith(client: DeviceDecisionApi) {
	const states: DeviceFlowState[] = [];
	const onDenied = vi.fn();
	const flow = createDeviceFlow({
		api: client,
		translations: () => get(LL),
		onChange: (state) => states.push(state),
		onDenied
	});
	return { flow, states, onDenied };
}

describe('device page requests', () => {
	beforeEach(() => {
		setLocale('en');
	});

	it('shows the application and scopes a code asks for', async () => {
		const outcome = await lookUpDeviceCode(api(), 'WDJBMJHT', get(LL));

		expect(outcome).toEqual({
			status: 'found',
			details: {
				client_name: 'Acme TV',
				client_uri: 'https://tv.example.com',
				logo_uri: undefined,
				scopes: ['openid', 'profile']
			}
		});
	});

	it('reports an unknown or expired code at lookup', async () => {
		const outcome = await lookUpDeviceCode(
			api({ lookup: vi.fn().mockResolvedValue({ error: { error: 'invalid_code' } }) }),
			'WDJBMJHT',
			get(LL)
		);

		expect(outcome).toMatchObject({
			status: 'error',
			message: get(LL).device_errorInvalidOrExpiredCode()
		});
	});

	it.each(['approve', 'deny'] as const)('decides the code: %s', async (decision) => {
		const client = api();

		const outcome = await decideDeviceCode(client, 'WDJBMJHT', decision, get(LL));

		expect(outcome).toEqual({ status: 'decided' });
		expect(client[decision]).toHaveBeenCalledWith('WDJBMJHT');
	});

	it('sends the person back to the device when access was withdrawn after the code was made', async () => {
		const outcome = await decideDeviceCode(
			api({
				approve: vi.fn().mockResolvedValue({
					error: { error: 'consent_withdrawn', error_description: 'Start again.' }
				})
			}),
			'WDJBMJHT',
			'approve',
			get(LL)
		);

		expect(outcome).toEqual({ status: 'restart', message: get(LL).device_errorConsentWithdrawn() });
	});

	it('keeps the code on screen to try again when the consent state is unavailable', async () => {
		const outcome = await decideDeviceCode(
			api({
				approve: vi.fn().mockResolvedValue({ error: { error: 'temporarily_unavailable' } })
			}),
			'WDJBMJHT',
			'approve',
			get(LL)
		);

		expect(outcome).toEqual({ status: 'error', message: get(LL).device_errorTryAgain() });
	});

	it.each([
		['approve', 'device_errorApproveFailed'],
		['deny', 'device_errorDenyFailed']
	] as const)('names the failed step for other errors: %s', async (decision, key) => {
		const failing = vi.fn().mockResolvedValue({ error: { error: 'server_error' } });

		const outcome = await decideDeviceCode(
			api({ approve: failing, deny: failing }),
			'WDJBMJHT',
			decision,
			get(LL)
		);

		expect(outcome).toEqual({ status: 'error', message: get(LL)[key]() });
	});

	it('does not claim anything when no answer arrived', async () => {
		const outcome = await decideDeviceCode(
			api({ approve: vi.fn().mockResolvedValue({ error: { error: 'network_error' } }) }),
			'WDJBMJHT',
			'approve',
			get(LL)
		);

		expect(outcome).toEqual({ status: 'unknown' });
	});
});

describe('device page flow', () => {
	beforeEach(() => {
		setLocale('en');
	});

	it('approves exactly the code whose details were shown', async () => {
		const client = api();
		const { flow } = flowWith(client);

		flow.setUserCode('wdjbmjht');
		await flow.verify();
		await flow.decide('approve');

		expect(client.lookup).toHaveBeenCalledWith('WDJBMJHT');
		expect(client.approve).toHaveBeenCalledWith('WDJBMJHT');
		expect(flow.state.success).toBe(get(LL).device_success());
	});

	it('ignores the answer for a code that was edited while its lookup was in flight', async () => {
		const first = deferred<LookupResult>();
		const lookup = vi
			.fn()
			.mockImplementationOnce(() => first.promise)
			.mockResolvedValueOnce({ data: details('Code B App') });
		const client = api({ lookup });
		const { flow } = flowWith(client);

		flow.setUserCode('AAAA-AAAA');
		const pendingA = flow.verify();
		flow.setUserCode('BBBB-BBBB');
		expect(flow.state.verifying).toBe(false);

		// A's answer arrives after the edit: it must not be shown, and nothing can be approved.
		first.resolve({ data: details('Code A App') });
		await pendingA;
		expect(flow.state.step).toBe('input');
		expect(flow.state.deviceInfo).toBeNull();
		await flow.decide('approve');
		expect(client.approve).not.toHaveBeenCalled();

		// B needs its own lookup, and approval then uses B.
		await flow.verify();
		expect(flow.state.deviceInfo?.client_name).toBe('Code B App');
		await flow.decide('approve');
		expect(client.approve).toHaveBeenCalledExactlyOnceWith('BBBBBBBB');
	});

	it('discards shown details when the code is edited, and requires a new lookup', async () => {
		const client = api();
		const { flow } = flowWith(client);

		flow.setUserCode('AAAA-AAAA');
		await flow.verify();
		expect(flow.state.step).toBe('verified');
		flow.setUserCode('BBBB-BBBB');

		expect(flow.state).toMatchObject({ step: 'input', deviceInfo: null });
		await flow.decide('deny');
		expect(client.deny).not.toHaveBeenCalled();
	});

	it('returns to code entry when access was withdrawn after the code was made', async () => {
		const { flow } = flowWith(
			api({ approve: vi.fn().mockResolvedValue({ error: { error: 'consent_withdrawn' } }) })
		);

		flow.setUserCode('WDJB-MJHT');
		await flow.verify();
		await flow.decide('approve');

		expect(flow.state).toMatchObject({
			step: 'input',
			userCode: '',
			deviceInfo: null,
			error: get(LL).device_errorConsentWithdrawn()
		});
	});

	it('denies and leaves the page', async () => {
		const { flow, onDenied } = flowWith(api());

		flow.setUserCode('WDJB-MJHT');
		await flow.verify();
		await flow.decide('deny');

		expect(onDenied).toHaveBeenCalledOnce();
	});

	describe('when the answer to a decision is lost', () => {
		const lost = () => vi.fn().mockResolvedValue({ error: { error: 'network_error' } });

		function lookupThen(after: LookupResult) {
			return vi
				.fn()
				.mockResolvedValueOnce({ data: details('Acme TV') })
				.mockResolvedValueOnce(after);
		}

		it('reports success when the server attributes the approval to the signed-in user', async () => {
			const client = api({
				approve: lost(),
				lookup: lookupThen({
					error: { error: 'invalid_code', code_status: 'approved', decided_by_self: true }
				})
			});
			const { flow } = flowWith(client);

			flow.setUserCode('WDJB-MJHT');
			await flow.verify();
			await flow.decide('approve');

			expect(client.lookup).toHaveBeenLastCalledWith('WDJBMJHT');
			expect(flow.state).toMatchObject({ success: get(LL).device_success(), error: '' });
		});

		it('does not claim an approval someone else made', async () => {
			const { flow } = flowWith(
				api({
					approve: lost(),
					lookup: lookupThen({
						error: { error: 'invalid_code', code_status: 'approved', decided_by_self: false }
					})
				})
			);

			flow.setUserCode('WDJB-MJHT');
			await flow.verify();
			await flow.decide('approve');

			expect(flow.state).toMatchObject({
				step: 'input',
				success: '',
				error: get(LL).device_errorOutcomeUnknown()
			});
		});

		it('does not claim a denial, which records no user', async () => {
			const { flow, onDenied } = flowWith(
				api({
					deny: lost(),
					lookup: lookupThen({ error: { error: 'invalid_code', code_status: 'denied' } })
				})
			);

			flow.setUserCode('WDJB-MJHT');
			await flow.verify();
			await flow.decide('deny');

			expect(onDenied).not.toHaveBeenCalled();
			expect(flow.state.error).toBe(get(LL).device_errorOutcomeUnknown());
		});

		it('does not claim nothing changed when the code is still waiting', async () => {
			// The original request may still be in flight and approve the code after this check.
			const { flow } = flowWith(
				api({ approve: lost(), lookup: lookupThen({ data: details('Acme TV') }) })
			);

			flow.setUserCode('WDJB-MJHT');
			await flow.verify();
			await flow.decide('approve');

			expect(flow.state).toMatchObject({
				step: 'verified',
				success: '',
				error: get(LL).device_errorOutcomeUnknown()
			});
			expect(flow.state.error).not.toBe(get(LL).device_errorTryAgain());
		});

		it('returns to code entry when the code expired meanwhile', async () => {
			const { flow } = flowWith(
				api({
					approve: lost(),
					lookup: lookupThen({ error: { error: 'invalid_code', code_status: 'expired' } })
				})
			);

			flow.setUserCode('WDJB-MJHT');
			await flow.verify();
			await flow.decide('approve');

			expect(flow.state).toMatchObject({
				step: 'input',
				error: get(LL).device_errorInvalidOrExpiredCode()
			});
		});

		it('says the outcome is unknown when the code is gone', async () => {
			const { flow } = flowWith(
				api({ approve: lost(), lookup: lookupThen({ error: { error: 'invalid_code' } }) })
			);

			flow.setUserCode('WDJB-MJHT');
			await flow.verify();
			await flow.decide('approve');

			expect(flow.state).toMatchObject({
				step: 'input',
				success: '',
				error: get(LL).device_errorOutcomeUnknown()
			});
		});

		it('says the outcome is unknown when the check fails too', async () => {
			const { flow } = flowWith(
				api({ approve: lost(), lookup: lookupThen({ error: { error: 'network_error' } }) })
			);

			flow.setUserCode('WDJB-MJHT');
			await flow.verify();
			await flow.decide('approve');

			expect(flow.state).toMatchObject({
				success: '',
				error: get(LL).device_errorOutcomeUnknown()
			});
		});
	});
});
