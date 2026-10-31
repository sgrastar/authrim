import { describe, expect, it } from 'vitest';
import {
	RUNTIME_TOKEN_EXCHANGE_FEATURE_KEY,
	shouldRenderRuntimeFeatureFlag
} from '../runtime-feature-flags';

describe('runtime feature flags helper', () => {
	it('hides the token exchange flag that tokens.exchange_enabled replaces, at every scope', () => {
		for (const scope of ['platform', 'tenant', 'client'] as const) {
			expect(shouldRenderRuntimeFeatureFlag(RUNTIME_TOKEN_EXCHANGE_FEATURE_KEY, scope)).toBe(false);
		}
		expect(shouldRenderRuntimeFeatureFlag('feature.enable_sd_jwt', 'tenant')).toBe(true);
	});
});
