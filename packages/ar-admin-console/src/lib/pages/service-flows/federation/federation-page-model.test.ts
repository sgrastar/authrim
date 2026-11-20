import { describe, expect, it } from 'vitest';
import { MOCK_FEDERATION_SOURCES } from '#lib/api/fake/federation-sources-fake.js';
import { federationFormOf } from '../federation-model';
import {
	addCertificate,
	entityStateIn,
	formChanged,
	MAX_EXCLUDED,
	refreshDelta,
	remainingDays,
	snapshotForm,
	toggleExcluded
} from './federation-page-model';

const form = () => federationFormOf(MOCK_FEDERATION_SOURCES[0]);

describe('whether the form changed', () => {
	it('is not changed by the order of the exceptions or the certificates', () => {
		const original = snapshotForm(form());
		const reordered = form();
		reordered.excludedEntityIds.reverse();
		expect(formChanged(reordered, original)).toBe(false);
		const edited = { ...form(), name: 'Other' };
		expect(formChanged(edited, original)).toBe(true);
		expect(formChanged({ ...form(), excludedEntityIds: [] }, original)).toBe(true);
	});
});

describe('setting an entity aside', () => {
	it('adds it, takes it back, and stops at the limit the server keeps', () => {
		expect(toggleExcluded(['a'], 'b')).toEqual({ list: ['a', 'b'], full: false });
		expect(toggleExcluded(['a', 'b'], 'a')).toEqual({ list: ['b'], full: false });
		const full = Array.from({ length: MAX_EXCLUDED }, (_, i) => `e${i}`);
		expect(toggleExcluded(full, 'new')).toEqual({ list: full, full: true });
		// Taking one back from a full list is always possible.
		expect(toggleExcluded(full, 'e0').list).toHaveLength(MAX_EXCLUDED - 1);
	});

	it('counts the unsaved list, but an explicit connection comes first', () => {
		expect(entityStateIn({ entityId: 'a', explicitProviderId: null }, ['a'])).toBe('excluded');
		expect(entityStateIn({ entityId: 'a', explicitProviderId: null }, [])).toBe('participating');
		expect(entityStateIn({ entityId: 'a', explicitProviderId: 'p' }, ['a'])).toBe('explicit');
	});
});

describe('certificates and numbers', () => {
	it('adds a certificate once', () => {
		const [existing] = form().certificates;
		expect(addCertificate([existing], { ...existing, id: 'other' })).toHaveLength(1);
		expect(
			addCertificate([existing], { ...existing, id: 'new', fingerprintSha256: 'ff' })
		).toHaveLength(2);
	});

	it('counts whole days to a date, negative once it has passed', () => {
		const now = Date.UTC(2026, 10, 20, 12);
		expect(remainingDays(new Date(now + 14 * 86_400_000 + 1000).toISOString(), now)).toBe(14);
		expect(remainingDays(new Date(now - 86_400_000 - 1000).toISOString(), now)).toBe(-2);
		expect(remainingDays(null, now)).toBeNull();
		expect(remainingDays('not a date', now)).toBeNull();
	});

	it('reads the change in entities with its sign', () => {
		expect(refreshDelta({ entityCountDelta: 4 })).toBe('+4');
		expect(refreshDelta({ entityCountDelta: -2 })).toBe('−2');
		expect(refreshDelta({ entityCountDelta: 0 })).toBe('±0');
		expect(refreshDelta({ entityCountDelta: null })).toBe('');
	});
});
