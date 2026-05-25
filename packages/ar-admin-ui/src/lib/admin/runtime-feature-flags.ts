import type { CategorySettings, SettingSource, UIPatch } from '$lib/api/admin-settings';

export const RUNTIME_TOKEN_EXCHANGE_FEATURE_KEY = 'feature.enable_token_exchange';

export function isPlatformRuntimeFeatureFlag(key: string): boolean {
	return key === RUNTIME_TOKEN_EXCHANGE_FEATURE_KEY;
}

export function shouldRenderRuntimeFeatureFlag(
	key: string,
	scopeLevel: 'platform' | 'tenant' | 'client'
): boolean {
	if (!isPlatformRuntimeFeatureFlag(key)) {
		return true;
	}

	return scopeLevel === 'platform';
}

export function applyRuntimeFeatureFlagOverrides(
	settings: CategorySettings,
	runtime: {
		tokenExchangeEnabled?: {
			value: boolean;
			source: SettingSource;
		};
	}
): CategorySettings {
	const values = { ...settings.values };
	const sources = { ...settings.sources };

	if (runtime.tokenExchangeEnabled) {
		values[RUNTIME_TOKEN_EXCHANGE_FEATURE_KEY] = runtime.tokenExchangeEnabled.value;
		sources[RUNTIME_TOKEN_EXCHANGE_FEATURE_KEY] = runtime.tokenExchangeEnabled.source;
	}

	return {
		...settings,
		values,
		sources
	};
}

export function splitRuntimeFeatureFlagPatches(patches: UIPatch[]): {
	genericPatches: UIPatch[];
	tokenExchangeEnabled?: boolean;
} {
	const genericPatches: UIPatch[] = [];
	let tokenExchangeEnabled: boolean | undefined;

	for (const patch of patches) {
		if (patch.key !== RUNTIME_TOKEN_EXCHANGE_FEATURE_KEY) {
			genericPatches.push(patch);
			continue;
		}

		if (patch.op === 'set') {
			tokenExchangeEnabled = patch.value === true;
		} else if (patch.op === 'disable') {
			tokenExchangeEnabled = false;
		}
	}

	return {
		genericPatches,
		tokenExchangeEnabled
	};
}
