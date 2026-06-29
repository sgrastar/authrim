import { fetchDiscoveryConfig } from './discovery-entry';
import type { DiscoveryConfigResponse } from './discovery-entry';

const DISCOVERY_CONFIG_CACHE_TTL_MS = 180_000;

type DiscoveryConfigCacheEntry = {
	expiresAt: number;
	value: DiscoveryConfigResponse;
};

const discoveryConfigCache = new Map<string, DiscoveryConfigCacheEntry>();

export async function fetchCachedLoginDiscoveryConfig(
	fetchFn: typeof fetch,
	cacheKey: string,
	headers?: HeadersInit
): Promise<DiscoveryConfigResponse> {
	const now = Date.now();
	const cached = discoveryConfigCache.get(cacheKey);
	if (cached && cached.expiresAt > now) {
		return cached.value;
	}

	const value = await fetchDiscoveryConfig(fetchFn, headers);
	discoveryConfigCache.set(cacheKey, {
		expiresAt: now + DISCOVERY_CONFIG_CACHE_TTL_MS,
		value
	});
	return value;
}

export function clearLoginDiscoveryConfigCacheForTests(): void {
	discoveryConfigCache.clear();
}
