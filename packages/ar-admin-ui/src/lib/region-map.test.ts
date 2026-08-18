import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
	buildRegionMapRenderKey,
	isLocationHintRegion,
	isNativeDoPlacementRegion,
	isScaleRegionSelectable,
	resolveNativeDoPlacementRegions
} from './region-map';

describe('scale region map', () => {
	it('redraws when the selected region set changes, including same-size replacements', () => {
		const initial = buildRegionMapRenderKey(['apac', 'enam', 'weur']);
		const replacement = buildRegionMapRenderKey(['apac', 'enam', 'eeur']);

		expect(replacement).not.toBe(initial);
		expect(buildRegionMapRenderKey(['weur', 'apac', 'enam'])).toBe(initial);
	});

	it('models AFR and ME as accepted hints with nearby native placement', () => {
		for (const region of ['afr', 'me']) {
			expect(isLocationHintRegion(region)).toBe(true);
			expect(isNativeDoPlacementRegion(region)).toBe(false);
			expect(isScaleRegionSelectable(region, ['afr', 'me', 'weur'])).toBe(false);
			expect(resolveNativeDoPlacementRegions(region)).toEqual(['weur']);
		}
	});

	it('models EEUR as a native Durable Objects placement region', () => {
		expect(isLocationHintRegion('eeur')).toBe(true);
		expect(isNativeDoPlacementRegion('eeur')).toBe(true);
		expect(isScaleRegionSelectable('eeur', ['eeur'])).toBe(true);
		expect(isScaleRegionSelectable('eeur', [])).toBe(false);
		expect(resolveNativeDoPlacementRegions('eeur')).toEqual(['eeur']);
	});

	it('disables unavailable region controls and associates their reason for assistive technology', () => {
		const page = readFileSync(resolve(__dirname, '..', 'routes/admin/scale/+page.svelte'), 'utf8');

		expect(page).toContain('disabled={isLastSelected || !isSelectable}');
		expect(page).toContain('aria-label={region.label}');
		expect(page).toContain(
			'aria-describedby={!isSelectable ? availabilityDescriptionId : undefined}'
		);
		expect(page).toContain('$LL.admin_scale_region_unavailable_do()');
	});
});
