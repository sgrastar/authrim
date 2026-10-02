/**
 * Feature flags that duplicate a setting runtime reads elsewhere, hidden so an edit cannot look
 * applied: `feature.enable_token_exchange` repeats `tokens.exchange_enabled` (the Tokens
 * settings), which Token Exchange reads.
 */
export const RUNTIME_TOKEN_EXCHANGE_FEATURE_KEY = 'feature.enable_token_exchange';

export function isPlatformRuntimeFeatureFlag(key: string): boolean {
	return key === RUNTIME_TOKEN_EXCHANGE_FEATURE_KEY;
}

export function shouldRenderRuntimeFeatureFlag(
	key: string,
	_scopeLevel: 'platform' | 'tenant' | 'client'
): boolean {
	return !isPlatformRuntimeFeatureFlag(key);
}
