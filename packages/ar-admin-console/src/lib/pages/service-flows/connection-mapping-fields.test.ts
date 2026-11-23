import { describe, expect, it } from 'vitest';
import type {
	DestinationDescriptor,
	MappingCatalog,
	MappingDestinationProfile,
	MappingSetContent
} from '#lib/api/mapping-set.js';
import { codecContext, profileDescriptor, withProfileExamples } from './connection-mapping-fields';

const profile = {
	id: 'profile-1',
	tenantId: 't',
	destinationType: 'saml',
	profileKey: 'p',
	displayName: 'P',
	ownerScopeType: 'tenant',
	ownerScopeId: 't',
	baseProfileId: null,
	lifecycleState: 'active',
	activeVersionId: 'v1',
	version: null,
	activeVersion: {
		id: 'v1',
		versionLabel: '1',
		lifecycleState: 'active',
		schemaHash: 'h',
		validationSummary: {},
		warningSummary: {},
		releaseImpact: {},
		schema: {
			destinationType: 'saml',
			attributes: [
				{
					name: 'urn:oid:2.5.4.4',
					label: 'sn',
					valueType: 'string',
					examples: ['鈴木', '佐藤', '']
				},
				{ name: 'mail', label: 'mail', valueType: 'string' }
			]
		}
	}
} as unknown as MappingDestinationProfile;

const catalog = { versionId: 'c1', entries: [] } as unknown as MappingCatalog;
const content = { catalogVersionId: 'c1', rules: [] } as unknown as MappingSetContent;

describe('the sample values of an output source reach the attributes of the mapping', () => {
	it('come from the profile when the mapping is made from it', () => {
		const context = codecContext('saml', profileDescriptor(profile), catalog, content);
		const sn = context.targets.find((target) => target.key === 'urn:oid:2.5.4.4');
		// Empty ones are dropped; an attribute with none has no samples at all.
		expect(sn?.samples).toEqual(['鈴木', '佐藤']);
		expect(context.targets.find((target) => target.key === 'mail')?.samples).toBeUndefined();
	});

	it('are added to a descriptor the server sent, which has none', () => {
		const sent: DestinationDescriptor = {
			...profileDescriptor(profile),
			fields: profileDescriptor(profile).fields.map(({ examples: _examples, ...field }) => field)
		};
		const context = codecContext('saml', withProfileExamples(sent, profile), catalog, content);
		expect(context.targets.find((target) => target.key === 'urn:oid:2.5.4.4')?.samples).toEqual([
			'鈴木',
			'佐藤'
		]);
		// Without the profile the descriptor is left as it is.
		expect(withProfileExamples(sent, undefined)).toBe(sent);
	});
});
