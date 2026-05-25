// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import { authrimFetch, resolveAuthrimRequestUrl } from './fetch';
import {
	assertNoBrowserTokenMaterial,
	hasBrowserTokenMaterial,
	LOGIN_UI_SESSION_PROFILE
} from './session-profile';

describe('Authrim LoginUI fetch profile', () => {
	it('resolves relative requests against the configured API base URL', () => {
		expect(resolveAuthrimRequestUrl('/api/auth/login-methods', 'https://auth.example.com')).toBe(
			'https://auth.example.com/api/auth/login-methods'
		);
		expect(resolveAuthrimRequestUrl('api/auth/login-methods', 'https://auth.example.com/')).toBe(
			'https://auth.example.com/api/auth/login-methods'
		);
		expect(
			resolveAuthrimRequestUrl('https://issuer.example.com/userinfo', 'https://auth.example.com')
		).toBe('https://issuer.example.com/userinfo');
	});

	it('defaults the built-in LoginUI to managed browser session cookies', async () => {
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}'));

		await authrimFetch('/api/sessions/status', {
			baseUrl: 'https://auth.example.com',
			fetchImpl: fetchMock,
			headers: { Accept: 'application/json' }
		});

		expect(fetchMock).toHaveBeenCalledWith(
			'https://auth.example.com/api/sessions/status',
			expect.objectContaining({
				credentials: 'include'
			})
		);
		expect(LOGIN_UI_SESSION_PROFILE).toBe('managed_browser_session');
	});

	it('does not force cookie credentials for token session requests', async () => {
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}'));

		await authrimFetch('/userinfo', {
			baseUrl: 'https://auth.example.com',
			fetchImpl: fetchMock,
			sessionProfile: 'token_session',
			headers: { Authorization: 'DPoP token' }
		});

		expect(fetchMock).toHaveBeenCalledWith(
			'https://auth.example.com/userinfo',
			expect.objectContaining({
				credentials: undefined
			})
		);
	});

	it('detects token material in browser-facing LoginUI responses', () => {
		expect(hasBrowserTokenMaterial({ session: { id: 'sess' } })).toBe(false);
		expect(hasBrowserTokenMaterial({ access_token: 'token' })).toBe(true);
		expect(() =>
			assertNoBrowserTokenMaterial({ refresh_token: 'refresh' }, 'handoff finalize')
		).toThrow(/token material/);
	});
});
