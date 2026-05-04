import { describe, expect, it } from 'vitest'
import {
	applyRuntimeFeatureFlagOverrides,
	RUNTIME_TOKEN_EXCHANGE_FEATURE_KEY,
	shouldRenderRuntimeFeatureFlag,
	splitRuntimeFeatureFlagPatches
} from '../runtime-feature-flags'

describe('runtime feature flags helper', () => {
	it('applies runtime token exchange value over generic category values', () => {
		const result = applyRuntimeFeatureFlagOverrides(
			{
				category: 'feature-flags',
				version: 'v1',
				values: { [RUNTIME_TOKEN_EXCHANGE_FEATURE_KEY]: false },
				sources: { [RUNTIME_TOKEN_EXCHANGE_FEATURE_KEY]: 'default' }
			},
			{
				tokenExchangeEnabled: {
					value: true,
					source: 'kv'
				}
			}
		)

		expect(result.values[RUNTIME_TOKEN_EXCHANGE_FEATURE_KEY]).toBe(true)
		expect(result.sources[RUNTIME_TOKEN_EXCHANGE_FEATURE_KEY]).toBe('kv')
	})

	it('splits token exchange patches from generic feature flag patches', () => {
		const result = splitRuntimeFeatureFlagPatches([
			{ op: 'set', key: RUNTIME_TOKEN_EXCHANGE_FEATURE_KEY, value: true },
			{ op: 'set', key: 'feature.enable_sd_jwt', value: true }
		])

		expect(result.tokenExchangeEnabled).toBe(true)
		expect(result.genericPatches).toEqual([
			{ op: 'set', key: 'feature.enable_sd_jwt', value: true }
		])
	})

	it('renders token exchange only at platform scope', () => {
		expect(shouldRenderRuntimeFeatureFlag(RUNTIME_TOKEN_EXCHANGE_FEATURE_KEY, 'platform')).toBe(true)
		expect(shouldRenderRuntimeFeatureFlag(RUNTIME_TOKEN_EXCHANGE_FEATURE_KEY, 'tenant')).toBe(false)
		expect(shouldRenderRuntimeFeatureFlag('feature.enable_sd_jwt', 'tenant')).toBe(true)
	})
})
