import { describe, expect, it } from 'vitest';
import type { AuthenticationMethods } from '$lib/api/authentication-methods';
import { resolveReauthMethods } from './reauth-methods';

function methods(overrides: {
	passkey?: Record<string, unknown>;
	emailCode?: Record<string, unknown>;
	totp?: Record<string, unknown>;
	humanVerification?: Record<string, unknown>;
}): AuthenticationMethods {
	return {
		passkey: { enabled: false, capabilities: [], ...overrides.passkey },
		emailCode: { enabled: false, steps: [], ...overrides.emailCode },
		totp: { enabled: false, preset: 'compatible', ...overrides.totp },
		humanVerification: {
			enabled: false,
			provider: 'turnstile',
			siteKey: null,
			loginEnabled: false,
			signupEnabled: false,
			reauthEnabled: false,
			...overrides.humanVerification
		}
	} as unknown as AuthenticationMethods;
}

describe('the methods the re-authentication screen offers', () => {
	it('offers a TOTP allowed for re-authentication only', () => {
		const result = resolveReauthMethods(
			methods({ totp: { enabled: true, loginEnabled: false, reauthEnabled: true } })
		);
		expect(result.totp).toBe(true);
	});

	it.each(['passkey', 'emailCode', 'totp'] as const)(
		'does not offer %s allowed for sign-in only',
		(method) => {
			const result = resolveReauthMethods(
				methods({ [method]: { enabled: true, loginEnabled: true, reauthEnabled: false } })
			);
			expect(result[method]).toBe(false);
		}
	);

	it('follows each switch on its own', () => {
		const result = resolveReauthMethods(
			methods({
				passkey: { enabled: true, loginEnabled: false, reauthEnabled: true },
				emailCode: { enabled: true, loginEnabled: true, reauthEnabled: false },
				totp: { enabled: true, loginEnabled: true, reauthEnabled: true }
			})
		);
		expect(result).toMatchObject({ passkey: true, emailCode: false, totp: true });
	});

	it('falls back to enabled when the settings have no separate switch', () => {
		const result = resolveReauthMethods(
			methods({ passkey: { enabled: true }, totp: { enabled: false } })
		);
		expect(result).toMatchObject({ passkey: true, totp: false });
	});

	it('asks for human verification by the switch for re-authentication, not for sign-in', () => {
		expect(
			resolveReauthMethods(
				methods({ humanVerification: { enabled: true, loginEnabled: true, reauthEnabled: false } })
			).humanVerification
		).toBe(false);
		expect(
			resolveReauthMethods(
				methods({ humanVerification: { enabled: true, loginEnabled: false, reauthEnabled: true } })
			).humanVerification
		).toBe(true);
	});
});
