import type { AuthenticationMethodsResponse } from '#lib/api/authentication-methods.js';

export type HumanVerificationProvider = 'turnstile' | 'hcaptcha' | 'recaptcha';

type Loader = () => Promise<AuthenticationMethodsResponse | null>;

interface CacheEntry {
	data: AuthenticationMethodsResponse;
	expiresAt: number;
}

const DEFAULT_CACHE_TTL_SECONDS = 180;

const cache = new Map<string, CacheEntry>();

function getCacheTtlMs(data: AuthenticationMethodsResponse): number {
	const ttlSeconds = Number(data.meta?.cacheTTL);
	if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
		return DEFAULT_CACHE_TTL_SECONDS * 1000;
	}

	return ttlSeconds * 1000;
}

/**
 * The cached answer of a key if it is still fresh, else null. Never loads: for a path that must
 * not wait for or make a request (the plain sign-in entry's environment banner).
 */
export function peekCachedAuthenticationMethods(
	cacheKey: string,
	now = Date.now()
): AuthenticationMethodsResponse | null {
	const cached = cache.get(cacheKey);
	return cached && cached.expiresAt > now ? cached.data : null;
}

export async function getCachedAuthenticationMethods(
	cacheKey: string,
	loader: Loader,
	now = Date.now()
): Promise<AuthenticationMethodsResponse | null> {
	const cached = cache.get(cacheKey);
	if (cached && cached.expiresAt > now) {
		return cached.data;
	}

	const data = await loader();
	// An answer the server marks as not to be kept (cacheTTL 0: a setting it could not read) is
	// used for this request only, or it would be served until a default lifetime runs out.
	if (data && Number(data.meta?.cacheTTL) !== 0) {
		cache.set(cacheKey, {
			data,
			expiresAt: Date.now() + getCacheTtlMs(data)
		});
	}
	return data;
}

export function resolveHumanVerificationProviderFromAuthenticationMethods(
	data: AuthenticationMethodsResponse | null
): HumanVerificationProvider | null {
	const humanVerification = data?.methods?.humanVerification;
	if (
		humanVerification?.enabled !== true ||
		typeof humanVerification.siteKey !== 'string' ||
		!humanVerification.siteKey.trim()
	) {
		return null;
	}

	if (
		humanVerification.provider === 'turnstile' ||
		humanVerification.provider === 'hcaptcha' ||
		humanVerification.provider === 'recaptcha'
	) {
		return humanVerification.provider;
	}

	return null;
}

export function clearAuthenticationMethodsServerCache(): void {
	cache.clear();
}
