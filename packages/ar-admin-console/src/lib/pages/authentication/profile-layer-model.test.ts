import { describe, expect, it } from 'vitest';
import type { ProfileLayer } from '#lib/api/profile-layer.js';
import { layerBadges, layerEditable, layerNote } from './profile-layer-model';

const layer = (overrides: Partial<ProfileLayer> = {}): ProfileLayer => ({
	scope: 'platform',
	platformValues: {},
	overridden: false,
	overrideInactive: false,
	overrideInactiveReason: null,
	locked: false,
	editable: true,
	platformUpdated: false,
	copyVersion: null,
	...overrides
});

describe('a profile’s platform layer in the console', () => {
	it('shows nothing for a profile of the tenant’s own', () => {
		expect(layerBadges(null)).toEqual([]);
		expect(layerNote(null)).toBeNull();
		expect(layerEditable(null)).toBe(true);
	});

	it('badges a platform profile with what holds for the tenant', () => {
		expect(layerBadges(layer()).map((b) => b.label)).toEqual(['pl.platform']);
		expect(
			layerBadges(layer({ overridden: true, platformUpdated: true })).map((b) => b.label)
		).toEqual(['pl.platform', 'pl.overridden', 'pl.updated']);
		expect(
			layerBadges(
				layer({ locked: true, overrideInactive: true, overrideInactiveReason: 'locked' })
			).map((b) => b.label)
		).toEqual(['pl.platform', 'pl.locked', 'pl.inactive']);
		// Default: no platform badge, only its state.
		expect(layerBadges(layer({ scope: 'tenant', overridden: true })).map((b) => b.label)).toEqual([
			'pl.overridden'
		]);
	});

	it('explains saving a platform profile, and offers going back once there is a copy', () => {
		expect(layerNote(layer())).toEqual({ tone: 'info', lines: ['pl.copyNote'], canRevert: false });
		expect(layerNote(layer({ overridden: true, platformUpdated: true }))).toEqual({
			tone: 'info',
			lines: ['pl.copyActive', 'pl.updatedNote'],
			canRevert: true
		});
		expect(layerNote(layer({ scope: 'tenant' }))?.lines).toEqual(['pl.defaultNote']);
	});

	it('is read only, with the reason, while the platform sets the tenant’s values aside', () => {
		const locked = layer({
			locked: true,
			editable: false,
			overrideInactive: true,
			overrideInactiveReason: 'locked'
		});
		expect(layerEditable(locked)).toBe(false);
		expect(layerNote(locked)).toEqual({
			tone: 'warning',
			lines: ['pl.readOnlyLocked', 'pl.copyKept'],
			canRevert: true
		});
		expect(
			layerNote(layer({ editable: false, overrideInactiveReason: 'changes_not_allowed' }))
		).toEqual({ tone: 'warning', lines: ['pl.readOnly'], canRevert: false });
		// With a copy set aside, the reason is known.
		expect(
			layerNote(
				layer({
					editable: false,
					overrideInactive: true,
					overrideInactiveReason: 'changes_not_allowed'
				})
			)?.lines
		).toEqual(['pl.readOnlyNotAllowed', 'pl.copyKept']);
	});

	it('does not call a copy set aside while it still applies', () => {
		// The platform is deleting it: not changeable, but the tenant's copy holds.
		expect(layerNote(layer({ editable: false, overridden: true, copyVersion: 1 }))).toEqual({
			tone: 'warning',
			lines: ['pl.readOnly'],
			canRevert: true
		});
	});
});
