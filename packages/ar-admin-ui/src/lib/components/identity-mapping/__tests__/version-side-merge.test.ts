import { describe, expect, it } from 'vitest';
import type { IdentityMappingFieldMappingVersionSummary } from '$lib/api/admin-identity-mapping';
import type { MappingDraftPayload } from '../types';
import { mergeMappingVersionSide } from '../version-side-merge';

const destinationDraft: MappingDraftPayload = {
	versionLabel: 'destination-draft',
	sourceProfileIds: [],
	rules: [
		{
			ruleKey: 'new-destination',
			ruleKind: 'destination_release',
			action: 'map'
		}
	],
	metadata: {
		sampleId: 'destination-profile-oidc',
		sampleTitle: 'OIDC',
		viewMode: 'destination',
		edgeCount: 1,
		transformCount: 0
	}
};

const existingVersion: IdentityMappingFieldMappingVersionSummary = {
	id: 'version-1',
	tenantId: 'tenant-a',
	fieldMappingSetId: 'mapping-set-1',
	versionLabel: 'v1',
	lifecycleState: 'active',
	sourceProfileIds: ['source_profile_scim'],
	destinationProfileIds: ['destination_profile_oidc'],
	rules: [
		{
			id: 'source-rule-id',
			ruleKey: 'existing-source',
			ruleKind: 'source_mapping',
			action: 'map',
			priority: 10,
			scope: { tenant: 'tenant-a' },
			condition: { when: 'present' },
			edges: [
				{
					id: 'source-edge-id',
					sourceRef: { profileId: 'source-profile-source_profile_scim', path: 'userName' },
					targetRef: { path: 'preferred_username' },
					edgeKind: 'direct',
					displayOrder: 0
				}
			],
			transforms: [],
			validationRules: [
				{
					id: 'validation-1',
					ruleId: 'source-rule-id',
					targetRef: { path: 'preferred_username' },
					validationKind: 'required',
					severity: 'error',
					parameters: { allowEmpty: false }
				}
			]
		},
		{
			id: 'destination-rule-id',
			ruleKey: 'old-destination',
			ruleKind: 'destination_release',
			action: 'map',
			priority: 20,
			edges: [],
			transforms: []
		}
	],
	releaseRules: [
		{
			id: 'release-1',
			destinationType: 'oidc',
			destinationId: 'destination_profile_oidc',
			sourceRef: { path: 'preferred_username' },
			releaseAction: 'allow',
			legalBasis: 'consent',
			purpose: 'authentication',
			condition: { scope: 'profile' },
			priority: 10
		}
	],
	conflictRules: [
		{
			id: 'conflict-1',
			targetRef: { path: 'preferred_username' },
			conflictStrategy: 'prefer_verified',
			sourcePriority: ['scim', 'oidc'],
			condition: { when: 'different' }
		}
	]
};

describe('field mapping version side merge', () => {
	it('keeps a new destination-only mapping free of source profiles', () => {
		expect(mergeMappingVersionSide(destinationDraft, null, 'destination')).toEqual({
			sourceProfileIds: [],
			rules: destinationDraft.rules
		});
	});

	it('replaces the edited destination side and preserves the existing source side', () => {
		const merged = mergeMappingVersionSide(destinationDraft, existingVersion, 'destination');

		expect(merged.sourceProfileIds).toEqual(['source_profile_scim']);
		expect(merged.rules.map((rule) => rule.ruleKey)).toEqual([
			'existing-source',
			'new-destination'
		]);
		expect(merged.rules.some((rule) => rule.ruleKey === 'old-destination')).toBe(false);
		expect(merged.rules[0]).toMatchObject({
			scope: { tenant: 'tenant-a' },
			condition: { when: 'present' },
			validationRules: [expect.objectContaining({ validationKind: 'required', severity: 'error' })],
			releaseRules: [expect.objectContaining({ releaseAction: 'allow' })],
			conflictRules: [expect.objectContaining({ conflictStrategy: 'prefer_verified' })]
		});
	});

	it('replaces the edited source side and preserves the existing destination side', () => {
		const sourceDraft: MappingDraftPayload = {
			...destinationDraft,
			sourceProfileIds: ['source-profile-source_profile_csv'],
			rules: [
				{
					ruleKey: 'new-source',
					ruleKind: 'source_mapping',
					action: 'map'
				}
			],
			metadata: { ...destinationDraft.metadata, viewMode: 'source' }
		};
		const merged = mergeMappingVersionSide(sourceDraft, existingVersion, 'source');

		expect(merged.sourceProfileIds).toEqual(['source-profile-source_profile_csv']);
		expect(merged.rules.map((rule) => rule.ruleKey)).toEqual(['old-destination', 'new-source']);
		expect(merged.rules[0]).toMatchObject({
			releaseRules: [expect.objectContaining({ releaseAction: 'allow' })],
			conflictRules: [expect.objectContaining({ conflictStrategy: 'prefer_verified' })]
		});
	});

	it('retains unsupported semantics when an edited rule still maps the same fields', () => {
		const draft: MappingDraftPayload = {
			...destinationDraft,
			sourceProfileIds: ['source_profile_scim'],
			rules: [
				{
					ruleKey: 'regenerated-source-rule',
					ruleKind: 'source_mapping',
					action: 'map',
					metadata: { source: 'admin_ui_flow_editor' },
					edges: [
						{
							sourceRef: {
								role: 'source',
								profileId: 'source_profile_scim',
								path: 'userName'
							},
							targetRef: { path: 'preferred_username' }
						}
					]
				}
			],
			metadata: { ...destinationDraft.metadata, viewMode: 'source' }
		};

		const merged = mergeMappingVersionSide(draft, existingVersion, 'source');
		const edited = merged.rules.find((rule) => rule.ruleKey === 'regenerated-source-rule');

		expect(edited).toMatchObject({
			scope: { tenant: 'tenant-a' },
			condition: { when: 'present' },
			metadata: { source: 'admin_ui_flow_editor' },
			validationRules: [expect.objectContaining({ validationKind: 'required', severity: 'error' })]
		});
	});
});
