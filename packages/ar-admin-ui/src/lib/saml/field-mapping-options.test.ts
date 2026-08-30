import { describe, expect, it } from 'vitest';
import {
	buildSelectableFieldMappingSets,
	filterCompatibleActiveFieldMappingSets
} from './field-mapping-options';

const fieldMappingSets = [
	{ id: 'draft-inbound', lifecycleState: 'draft' },
	{ id: 'active-inbound', lifecycleState: 'active' },
	{ id: 'active-outbound', lifecycleState: 'active' },
	{ id: 'published-outbound', lifecycleState: 'active' },
	{ id: 'orphaned-active-snapshot', lifecycleState: 'active' }
];

const versions = {
	'draft-inbound': [{ lifecycleState: 'draft', directions: { source: true, destination: false } }],
	'active-inbound': [
		{ lifecycleState: 'active', directions: { source: true, destination: false } }
	],
	'active-outbound': [
		{ lifecycleState: 'active', directions: { source: false, destination: true } }
	],
	'published-outbound': [
		{
			lifecycleState: 'published',
			directions: { source: false, destination: true },
			latestSnapshot: { lifecycleState: 'draft' }
		}
	],
	'orphaned-active-snapshot': [
		{
			lifecycleState: 'published',
			directions: { source: false, destination: true },
			latestSnapshot: { lifecycleState: 'active' }
		}
	]
};

describe('filterCompatibleActiveFieldMappingSets', () => {
	it('offers only active inbound mappings to SAML IdP providers', () => {
		expect(
			filterCompatibleActiveFieldMappingSets(fieldMappingSets, versions, 'saml_idp').map(
				(item) => item.id
			)
		).toEqual(['active-inbound']);
	});

	it('offers only active outbound mappings to SAML SP providers', () => {
		expect(
			filterCompatibleActiveFieldMappingSets(fieldMappingSets, versions, 'saml_sp').map(
				(item) => item.id
			)
		).toEqual(['active-outbound']);
	});

	it('does not treat an orphaned active snapshot as an active field mapping version', () => {
		expect(
			filterCompatibleActiveFieldMappingSets(fieldMappingSets, versions, 'saml_sp').map(
				(item) => item.id
			)
		).not.toContain('orphaned-active-snapshot');
	});

	it('supports legacy version summaries that expose profile IDs instead of directions', () => {
		const legacySets = [{ id: 'legacy', lifecycleState: 'active' }];
		const legacyVersions = {
			legacy: [
				{
					lifecycleState: 'active',
					sourceProfileIds: ['source-profile'],
					destinationProfileIds: []
				}
			]
		};

		expect(
			filterCompatibleActiveFieldMappingSets(legacySets, legacyVersions, 'saml_idp')
		).toHaveLength(1);
		expect(
			filterCompatibleActiveFieldMappingSets(legacySets, legacyVersions, 'saml_sp')
		).toHaveLength(0);
	});

	it('keeps an incompatible current selection visible while excluding other invalid choices', () => {
		expect(
			buildSelectableFieldMappingSets({
				fieldMappingSets,
				versionsByFieldMappingSetId: versions,
				providerType: 'saml_sp',
				currentFieldMappingSetId: 'draft-inbound'
			}).map((item) => item.id)
		).toEqual(['draft-inbound', 'active-outbound']);
	});
});
