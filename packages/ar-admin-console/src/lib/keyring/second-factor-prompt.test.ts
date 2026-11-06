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
		enrollProgress: vi.fn()
	};
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

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
});
