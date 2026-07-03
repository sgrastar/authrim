import type { AuthenticationMethodsResponse } from '$lib/api/authentication-methods';

export type HumanVerificationProvider = 'turnstile' | 'hcaptcha' | 'recaptcha';

type Loader = () => Promise<AuthenticationMethodsResponse | null>;

interface CacheEntry {
	data: AuthenticationMethodsResponse;
	expiresAt: number;
}

const DEFAULT_CACHE_TTL_SECONDS = 180;

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<AuthenticationMethodsResponse | null>>();

function getCacheTtlMs(data: AuthenticationMethodsResponse): number {
	const ttlSeconds = Number(data.meta?.cacheTTL);
	if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
		return DEFAULT_CACHE_TTL_SECONDS * 1000;
	}

	return ttlSeconds * 1000;
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

	const pending = inFlight.get(cacheKey);
	if (pending) {
		return pending;
	}

	const request = (async () => {
		const data = await loader();
		if (data) {
			cache.set(cacheKey, {
				data,
				expiresAt: Date.now() + getCacheTtlMs(data)
			});
		}
		return data;
	})();

	inFlight.set(cacheKey, request);
	try {
		return await request;
	} finally {
		inFlight.delete(cacheKey);
	}
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
	inFlight.clear();
}
