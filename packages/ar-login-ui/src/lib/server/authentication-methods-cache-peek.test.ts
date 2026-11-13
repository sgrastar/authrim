import { describe, expect, it, vi } from 'vitest';
import {
	clearAuthenticationMethodsServerCache,
	getCachedAuthenticationMethods,
	peekCachedAuthenticationMethods
} from './authentication-methods-cache';

const answer = { methods: {}, ui: {}, meta: { cacheTTL: 60, revision: 't' } } as never;

describe('peekCachedAuthenticationMethods', () => {
	it('is null on a miss and never loads; returns a fresh entry; null once expired', async () => {
		clearAuthenticationMethodsServerCache();
		expect(peekCachedAuthenticationMethods('k')).toBeNull();
		const loader = vi.fn(async () => answer);
		await getCachedAuthenticationMethods('k', loader);
		expect(peekCachedAuthenticationMethods('k')).toBe(answer);
		expect(loader).toHaveBeenCalledTimes(1);
		expect(peekCachedAuthenticationMethods('k', Date.now() + 61_000)).toBeNull();
	});
});
