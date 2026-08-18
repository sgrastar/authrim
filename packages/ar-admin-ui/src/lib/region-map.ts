export const LOCATION_HINT_REGIONS = [
	'apac',
	'enam',
	'wnam',
	'weur',
	'eeur',
	'oc',
	'afr',
	'me'
] as const;

export const NATIVE_DO_PLACEMENT_REGIONS = ['apac', 'enam', 'wnam', 'weur', 'eeur', 'oc'] as const;

export function isLocationHintRegion(region: string): boolean {
	return (LOCATION_HINT_REGIONS as readonly string[]).includes(region);
}

export function isNativeDoPlacementRegion(region: string): boolean {
	return (NATIVE_DO_PLACEMENT_REGIONS as readonly string[]).includes(region);
}

export function isScaleRegionSelectable(
	region: string,
	allowedRegions: readonly string[]
): boolean {
	return allowedRegions.includes(region) && isNativeDoPlacementRegion(region);
}

export function resolveNativeDoPlacementRegions(region: string): string[] {
	switch (region) {
		case 'afr':
		case 'me':
			return ['weur'];
		default:
			return isNativeDoPlacementRegion(region) ? [region] : [];
	}
}

export function buildRegionMapRenderKey(selectedRegions: readonly string[]): string {
	return [...new Set(selectedRegions)].sort().join('|');
}
