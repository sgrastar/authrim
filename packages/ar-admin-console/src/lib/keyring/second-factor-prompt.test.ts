import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
