import { get } from 'svelte/store';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$app/environment', () => ({
	browser: true,
	dev: false,
	building: false,
	version: 'test'
}));

vi.mock('$lib/api/client', () => ({
	buildDiagnosticHeaders: vi.fn(() => new Headers())
}));

const localStorageMock = {
	getItem: vi.fn(),
	setItem: vi.fn(),
	removeItem: vi.fn(),
	clear: vi.fn()
};

async function loadAuthStore() {
	vi.resetModules();
	return import('./auth');
}

describe('auth store storage policy', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		Object.defineProperty(globalThis, 'localStorage', {
			value: localStorageMock,
			configurable: true
		});
		Object.defineProperty(globalThis, 'fetch', {
			value: vi.fn().mockResolvedValue(new Response(null, { status: 204 })),
			configurable: true
		});
	});

	it('keeps login state in memory without localStorage persistence', async () => {
		const { auth } = await loadAuthStore();

		auth.login('session-123', {
			userId: 'user-123',
			email: 'user@example.com',
			name: 'Example User'
		});

		expect(get(auth)).toEqual({
			isAuthenticated: true,
			sessionId: 'session-123',
			user: {
				userId: 'user-123',
				email: 'user@example.com',
				name: 'Example User'
			}
		});
		expect(localStorageMock.getItem).not.toHaveBeenCalled();
		expect(localStorageMock.setItem).not.toHaveBeenCalled();
	});

	it('ends the server session before clearing memory state on logout', async () => {
		const { auth } = await loadAuthStore();
		auth.login('session-123', {
			userId: 'user-123',
			email: 'user@example.com'
		});

		await auth.logout();

		expect(get(auth)).toEqual({
			isAuthenticated: false,
			sessionId: null,
			user: null
		});
		expect(fetch).toHaveBeenCalledWith(
			'/api/v1/auth/direct/logout',
			expect.objectContaining({
				method: 'POST',
				credentials: 'include',
				body: '{}'
			})
		);
		const request = vi.mocked(fetch).mock.calls[0]?.[1];
		expect(new Headers(request?.headers).get('Content-Type')).toBe('application/json');
		expect(localStorageMock.removeItem).not.toHaveBeenCalled();
	});

	it('keeps the authenticated state when the server logout request fails', async () => {
		vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 500 }));
		const { auth } = await loadAuthStore();
		auth.login('session-123', {
			userId: 'user-123',
			email: 'user@example.com'
		});

		await expect(auth.logout()).rejects.toThrow('Logout request failed');

		expect(get(auth)).toEqual({
			isAuthenticated: true,
			sessionId: 'session-123',
			user: {
				userId: 'user-123',
				email: 'user@example.com'
			}
		});
	});

	it('refreshes from the session cookie without localStorage persistence', async () => {
		Object.defineProperty(globalThis, 'fetch', {
			value: vi.fn().mockResolvedValue(
				new Response(
					JSON.stringify({
						active: true,
						user_id: 'user-456',
						email: 'cookie-user@example.com',
						name: 'Cookie User'
					}),
					{
						status: 200,
						headers: { 'Content-Type': 'application/json' }
					}
				)
			),
			configurable: true
		});
		const { auth } = await loadAuthStore();

		await auth.refreshFromSession();

		expect(get(auth)).toEqual({
			isAuthenticated: true,
			sessionId: null,
			user: {
				userId: 'user-456',
				email: 'cookie-user@example.com',
				name: 'Cookie User'
			}
		});
		expect(localStorageMock.getItem).not.toHaveBeenCalled();
		expect(localStorageMock.setItem).not.toHaveBeenCalled();
		expect(localStorageMock.removeItem).not.toHaveBeenCalled();
	});
});
