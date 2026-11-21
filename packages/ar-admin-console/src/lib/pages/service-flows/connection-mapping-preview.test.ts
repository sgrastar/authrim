import { describe, expect, it } from 'vitest';
import type { MappingSetChangePreview } from '#lib/api/mapping-set.js';
import { setChangePreviewOf } from './connection-mapping-preview.js';

const base: MappingSetChangePreview = {
	setId: 'set-1',
	owner: 'tenant',
	changes: [],
	references: { count: 2, scan_complete: true },
	usage_complete: true,
	apps: [],
	apps_truncated: false,
	sample: null
};

describe('the mapping set screen reads the facade’s answer', () => {
	it('lists the apps and the service providers that use the set side by side', () => {
		const preview = setChangePreviewOf({
			...base,
			apps: [
				{
					tenant_id: 't',
					client_id: 'portal',
					name: 'Portal',
					tier: 'tenant_default',
					changes: [{ kind: 'added', claim: 'org', profile_id: null, namespace: 'x' }],
					held_back: [{ claim: 'org', scope: 'profile' }]
				}
			],
			sps: [
				{
					tenant_id: 't',
					provider_id: 'sp-1',
					sp_entity_id: 'urn:sp',
					name: 'Library SP',
					changes: [{ kind: 'removed', claim: 'mail', profile_id: null, namespace: 'x' }],
					held_back: [{ attribute: 'mail', reason: 'not_released' }],
					pinned_version_id: null
				}
			]
		});
		expect(preview.apps.map((row) => [row.client_id, row.tier])).toEqual([
			['portal', 'tenant_default'],
			['sp-1', 'client']
		]);
		expect(preview.apps[0].changes).toEqual([
			{
				kind: 'added',
				claim: 'org',
				previous_claim: undefined,
				type_before: undefined,
				type_after: undefined
			}
		]);
		expect(preview.apps[1].held_back).toEqual([
			{ claim: 'mail', scope: '', reason: 'not_released' }
		]);
		expect(preview.sample).toBeNull();
	});

	it('says the look at the users is incomplete when a list was cut short', () => {
		expect(setChangePreviewOf(base).usage_complete).toBe(true);
		expect(setChangePreviewOf({ ...base, apps_truncated: true }).usage_complete).toBe(false);
		expect(setChangePreviewOf({ ...base, sps_truncated: true }).usage_complete).toBe(false);
		expect(setChangePreviewOf({ ...base, usage_complete: false }).usage_complete).toBe(false);
	});

	it('counts the apps of each tenant for a platform set, and keeps an unknown count unknown', () => {
		const preview = setChangePreviewOf({
			...base,
			tenants: [{ tenant_id: 'a', apps_using: 4 }, { tenant_id: 'b' }]
		});
		expect(preview.tenants).toEqual([
			{ tenant_id: 'a', apps_using: 4 },
			{ tenant_id: 'b', apps_using: null }
		]);
	});

	it('names a held-back claim once, however many changes hold it back', () => {
		const preview = setChangePreviewOf({
			...base,
			apps: [
				{
					tenant_id: 't',
					client_id: 'portal',
					name: 'Portal',
					tier: 'client',
					changes: [],
					held_back: [
						{ claim: 'org', scope: 'profile' },
						{ claim: 'org', scope: 'profile' },
						{ claim: 'org', scope: 'email' }
					]
				}
			]
		});
		expect(preview.apps[0].held_back).toEqual([
			{ claim: 'org', scope: 'profile' },
			{ claim: 'org', scope: 'email' }
		]);
	});

	it('leaves out an empty tenant summary, so the service providers are the ones shown', () => {
		expect(setChangePreviewOf({ ...base, tenants: [] }).tenants).toBeUndefined();
	});

	it('is incomplete when anything could not be looked at fully', () => {
		for (const partial of [
			{ tenants_truncated: true },
			{ defaults_unavailable: 'timeout' },
			{ unresolved_sp_references: [{}] },
			{ tenants: [{ tenant_id: 'a', apps_using: 3, apps_count_is_lower_bound: true }] },
			{ tenants: [{ tenant_id: 'a', unavailable: 'timeout' }] }
		])
			expect(setChangePreviewOf({ ...base, ...partial }).usage_complete).toBe(false);
	});

	it('does not give a count that is only a lower bound as if it were exact', () => {
		const preview = setChangePreviewOf({
			...base,
			tenants: [{ tenant_id: 'a', apps_using: 3, apps_count_is_lower_bound: true }]
		});
		expect(preview.tenants).toEqual([{ tenant_id: 'a', apps_using: null }]);
	});

	it('counts the apps and the service providers of a tenant together for a platform set', () => {
		const preview = setChangePreviewOf({
			...base,
			tenants: [
				{ tenant_id: 'a', apps_using: 2, sps_using: 3 },
				{ tenant_id: 'b', sps_using: 4 },
				{ tenant_id: 'c' }
			]
		});
		expect(preview.tenants).toEqual([
			{ tenant_id: 'a', apps_using: 5 },
			{ tenant_id: 'b', apps_using: 4 },
			{ tenant_id: 'c', apps_using: null }
		]);
	});

	it('keeps the reason a service provider holds a change back, apart from any scope', () => {
		const preview = setChangePreviewOf({
			...base,
			sps: [
				{
					tenant_id: 't',
					provider_id: 'sp-1',
					sp_entity_id: null,
					name: 'SP',
					changes: [],
					held_back: [{ attribute: 'mail', reason: 'pinned_version' }],
					pinned_version_id: 'v1'
				}
			]
		});
		expect(preview.apps[0].held_back).toEqual([
			{ claim: 'mail', scope: '', reason: 'pinned_version' }
		]);
	});
});
