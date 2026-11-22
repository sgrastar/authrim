import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '#lib/api/api-error.js';
import type { KeyringFactorClient } from '#lib/api/keyring-factor.js';
import { POLL_INTERVAL_MS } from './presentation-flow.svelte';
import { SecondFactorCancelled, SecondFactorPromptState } from './second-factor-prompt.svelte';

function client(status: 'verified' | 'pending' = 'verified'): KeyringFactorClient {
	return {
		startStepUp: vi.fn(async () => ({
			requestId: 'req-1',
			qr: 'openid4vp://?x',
			matchCode: '42',
			expiresAt: Date.now() + 300_000
		})),
		stepUpProgress: vi.fn(async () => ({ status })),
		startEnroll: vi.fn(),
		enrollProgress: vi.fn(),
		startStepUpInBrowser: vi.fn(async () => ({
			requestId: 'req-b',
			expiresAt: Date.now() + 300_000,
			dcRequest: { protocol: 'openid4vp-v1-signed', data: { request: 'h.p.s' } }
		})),
		submitStepUp: vi.fn(async () => ({ status })),
		startEnrollInBrowser: vi.fn(),
		submitEnroll: vi.fn(),
		startRecovery: vi.fn(),
		startRecoveryInBrowser: vi.fn()
	};
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe('SecondFactorPromptState', () => {
	it('answers security_key when the admin picks the security key', async () => {
		const prompt = new SecondFactorPromptState();
		const answer = prompt.ask({ hasSecurityKey: true, client: client() });
		expect(prompt.open).toBe(true);
		expect(prompt.flow).toBeNull();
		prompt.chooseSecurityKey();
		await expect(answer).resolves.toBe('security_key');
		expect(prompt.open).toBe(false);
	});

	it('answers keyring_verified once the Keyring presentation is verified', async () => {
		const prompt = new SecondFactorPromptState();
		const keyring = client();
		const answer = prompt.ask({ hasSecurityKey: true, client: keyring });
		prompt.chooseKeyring();
		await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
		await expect(answer).resolves.toBe('keyring_verified');
		expect(keyring.startStepUp).toHaveBeenCalledTimes(1);
		expect(prompt.open).toBe(false);
		expect(prompt.flow).toBeNull();
	});

	it('goes straight to Keyring when it is the only second factor', async () => {
		const prompt = new SecondFactorPromptState();
		const keyring = client('pending');
		void prompt.ask({ hasSecurityKey: false, client: keyring }).catch(() => undefined);
		expect(prompt.flow).not.toBeNull();
		await vi.advanceTimersByTimeAsync(0);
		expect(keyring.startStepUp).toHaveBeenCalledTimes(1);
		prompt.cancel();
	});

	it('rejects like a cancelled ceremony when closed', async () => {
		const prompt = new SecondFactorPromptState();
		const answer = prompt.ask({ hasSecurityKey: true, client: client('pending') });
		prompt.chooseKeyring();
		prompt.cancel();
		await expect(answer).rejects.toBeInstanceOf(SecondFactorCancelled);
		await expect(answer).rejects.toMatchObject({ name: 'NotAllowedError' });
		expect(prompt.open).toBe(false);
		expect(prompt.flow).toBeNull();
	});

	it('cancels an earlier question when asked again', async () => {
		const prompt = new SecondFactorPromptState();
		const first = prompt.ask({ hasSecurityKey: true, client: client() });
		const second = prompt.ask({ hasSecurityKey: true, client: client() });
		await expect(first).rejects.toBeInstanceOf(SecondFactorCancelled);
		prompt.chooseSecurityKey();
		await expect(second).resolves.toBe('security_key');
	});

	it('goes back from Keyring to the choice', () => {
		const prompt = new SecondFactorPromptState();
		void prompt.ask({ hasSecurityKey: true, client: client('pending') }).catch(() => undefined);
		prompt.chooseKeyring();
		prompt.back();
		expect(prompt.flow).toBeNull();
		expect(prompt.open).toBe(true);
		prompt.cancel();
	});

	it('presents through the browser when the platform allows it and the browser can', async () => {
		const get = vi.fn(async () => ({ data: { response: 'jwe' } }));
		vi.stubGlobal('DigitalCredential', class {});
		vi.stubGlobal('navigator', { credentials: { get } });
		const prompt = new SecondFactorPromptState();
		const keyring = client();
		const answer = prompt.ask({ hasSecurityKey: false, client: keyring, dcApi: true });
		await vi.advanceTimersByTimeAsync(0);
		// Prepared, then opened by the admin's click (the dialog needs a fresh user action).
		expect(prompt.flow?.phase).toBe('ready');
		expect(get).not.toHaveBeenCalled();
		void prompt.flow?.openBrowser();
		await expect(answer).resolves.toBe('keyring_verified');
		expect(keyring.startStepUp).not.toHaveBeenCalled();
		expect(get).toHaveBeenCalledWith({
			mediation: 'required',
			digital: { requests: [{ protocol: 'openid4vp-v1-signed', data: { request: 'h.p.s' } }] }
		});
		expect(keyring.submitStepUp).toHaveBeenCalledWith('req-b', { response: 'jwe' });
	});

	it('falls back to the QR code when the browser cannot, or the switch is off', async () => {
		const prompt = new SecondFactorPromptState();
		const keyring = client('pending');
		// No DigitalCredential in this browser.
		void prompt.ask({ hasSecurityKey: false, client: keyring, dcApi: true }).catch(() => undefined);
		await vi.advanceTimersByTimeAsync(0);
		expect(keyring.startStepUp).toHaveBeenCalledTimes(1);
		expect(keyring.startStepUpInBrowser).not.toHaveBeenCalled();
		prompt.cancel();
	});

	it('switches to the QR code after the browser dialog was cancelled', async () => {
		vi.stubGlobal('DigitalCredential', class {});
		vi.stubGlobal('navigator', {
			credentials: {
				get: vi.fn(async () => {
					throw Object.assign(new Error('cancelled'), { name: 'NotAllowedError' });
				})
			}
		});
		const prompt = new SecondFactorPromptState();
		const keyring = client('pending');
		void prompt.ask({ hasSecurityKey: false, client: keyring, dcApi: true }).catch(() => undefined);
		await vi.advanceTimersByTimeAsync(0);
		void prompt.flow?.openBrowser();
		await vi.advanceTimersByTimeAsync(0);
		expect(prompt.flow?.phase).toBe('error');
		prompt.useQr();
		await vi.advanceTimersByTimeAsync(0);
		expect(prompt.flow?.phase).toBe('waiting');
		expect(keyring.startStepUp).toHaveBeenCalledTimes(1);
		prompt.cancel();
	});
});

describe('SecondFactorPromptState with an authenticator app', () => {
	const totpOnly = (verifyTotp: (code: string) => Promise<void>) => ({
		hasSecurityKey: false,
		hasKeyring: false,
		hasTotp: true,
		client: client(),
		verifyTotp
	});

	it('asks for the code right away when it is the only way, and answers once it is accepted', async () => {
		const verify = vi.fn(async () => undefined);
		const prompt = new SecondFactorPromptState();
		const answer = prompt.ask(totpOnly(verify));

		expect(prompt.open).toBe(true);
		expect(prompt.totpStep).toBe(true);
		expect(prompt.flow).toBeNull();
		await prompt.submitTotp(' 123 456 ');

		await expect(answer).resolves.toBe('totp_verified');
		// Spaces the app shows between the digits are dropped.
		expect(verify).toHaveBeenCalledWith('123456');
		expect(prompt.open).toBe(false);
		expect(prompt.totpStep).toBe(false);
	});

	it('keeps the prompt open on a refused code, naming why, and accepts a retyped one', async () => {
		const verify = vi
			.fn<(code: string) => Promise<void>>()
			.mockRejectedValueOnce(new ApiError(400, 'verification_failed', 'x'))
			.mockResolvedValueOnce(undefined);
		const prompt = new SecondFactorPromptState();
		const answer = prompt.ask(totpOnly(verify));

		await prompt.submitTotp('000000');
		expect(prompt.open).toBe(true);
		expect(prompt.totpFailure).toBe('invalid');
		expect(prompt.totpBusy).toBe(false);

		await prompt.submitTotp('123456');
		await expect(answer).resolves.toBe('totp_verified');
		expect(prompt.totpFailure).toBeNull();
	});

	it.each([
		[new ApiError(429, 'rate_limited', 'x'), 'rate_limited'],
		[new ApiError(403, 'second_factor_kind_not_allowed', 'x'), 'not_allowed'],
		[new ApiError(400, 'no_second_factor', 'x'), 'unavailable'],
		[new Error('offline'), 'unavailable']
	])('names a failure that is not a wrong code (%#)', async (error, failure) => {
		const prompt = new SecondFactorPromptState();
		void prompt.ask(totpOnly(vi.fn(async () => Promise.reject(error)))).catch(() => undefined);

		await prompt.submitTotp('123456');

		expect(prompt.totpFailure).toBe(failure);
		expect(prompt.open).toBe(true);
		prompt.cancel();
	});

	it('does not run two checks at once', async () => {
		let release: () => void = () => undefined;
		const verify = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
		const prompt = new SecondFactorPromptState();
		const answer = prompt.ask(totpOnly(verify));

		const first = prompt.submitTotp('123456');
		await prompt.submitTotp('123456');
		expect(verify).toHaveBeenCalledTimes(1);
		release();
		await first;
		await expect(answer).resolves.toBe('totp_verified');
	});

	it('shows the choice when there is more than one way, and goes back to it', () => {
		const prompt = new SecondFactorPromptState();
		void prompt.ask({ ...totpOnly(vi.fn()), hasSecurityKey: true }).catch(() => undefined);
		expect(prompt.totpStep).toBe(false);
		expect(prompt.canGoBack).toBe(true);

		prompt.chooseTotp();
		expect(prompt.totpStep).toBe(true);
		prompt.back();
		expect(prompt.totpStep).toBe(false);
		expect(prompt.open).toBe(true);
		prompt.cancel();
	});

	it('offers the authenticator app only when there is a way to check the code', () => {
		const prompt = new SecondFactorPromptState();
		void prompt
			.ask({ hasSecurityKey: true, hasKeyring: false, hasTotp: true, client: client() })
			.catch(() => undefined);
		expect(prompt.hasTotp).toBe(false);
		prompt.chooseTotp();
		expect(prompt.totpStep).toBe(false);
		prompt.cancel();
	});

	it('rejects like a cancelled ceremony when closed on the code step, forgetting the failure', async () => {
		const prompt = new SecondFactorPromptState();
		const answer = prompt.ask(
			totpOnly(vi.fn(async () => Promise.reject(new ApiError(400, 'verification_failed', 'x'))))
		);
		await prompt.submitTotp('000000');
		prompt.cancel();

		await expect(answer).rejects.toBeInstanceOf(SecondFactorCancelled);
		expect(prompt.totpFailure).toBeNull();
		expect(prompt.totpStep).toBe(false);
	});

	it('ignores a code answer that arrives after its prompt was closed and another one opened', async () => {
		let release: () => void = () => undefined;
		const slow = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
		const prompt = new SecondFactorPromptState();
		const first = prompt.ask(totpOnly(slow));
		const submitted = prompt.submitTotp('123456');
		prompt.cancel();
		await expect(first).rejects.toBeInstanceOf(SecondFactorCancelled);

		// A second question opens before the first answer comes back.
		const second = prompt.ask(totpOnly(vi.fn(async () => undefined)));
		let settled = false;
		void second.then(() => (settled = true));
		release();
		await submitted;
		await Promise.resolve();

		// The late answer did not answer the new question or touch its state.
		expect(settled).toBe(false);
		expect(prompt.open).toBe(true);
		expect(prompt.totpBusy).toBe(false);
		await prompt.submitTotp('654321');
		await expect(second).resolves.toBe('totp_verified');
	});

	it('ignores a refusal that arrives after its prompt was closed and another one opened', async () => {
		let fail: (error: Error) => void = () => undefined;
		const slow = vi.fn(() => new Promise<void>((_, reject) => (fail = reject)));
		const prompt = new SecondFactorPromptState();
		void prompt.ask(totpOnly(slow)).catch(() => undefined);
		const submitted = prompt.submitTotp('123456');
		prompt.cancel();
		void prompt.ask(totpOnly(vi.fn(async () => undefined))).catch(() => undefined);

		fail(new ApiError(400, 'verification_failed', 'x'));
		await submitted;

		expect(prompt.totpFailure).toBeNull();
		prompt.cancel();
	});

	it('keeps Keyring as the default when hasKeyring is not given', () => {
		const prompt = new SecondFactorPromptState();
		void prompt.ask({ hasSecurityKey: true, client: client('pending') }).catch(() => undefined);
		expect(prompt.hasKeyring).toBe(true);
		expect(prompt.hasTotp).toBe(false);
		prompt.cancel();
	});
});
