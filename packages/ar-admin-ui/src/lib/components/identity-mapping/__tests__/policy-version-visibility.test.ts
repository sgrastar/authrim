import { describe, expect, it } from 'vitest';
import {
	resolveMappingEditorLaneSelectorMode,
	shouldExposeFieldMappingVersion
} from '../policy-version-visibility';

const draft = {
	policyId: 'policy-1',
	policyLifecycleState: 'draft',
	versionId: 'version-1',
	versionLifecycleState: 'draft',
	routePolicyOptionId: null,
	selectedPolicyId: null,
	selectedVersionId: null
};

describe('shouldExposeFieldMappingVersion', () => {
	it('keeps the newly saved selected draft visible for immediate review and activation', () => {
		expect(
			shouldExposeFieldMappingVersion({
				...draft,
				selectedPolicyId: 'policy-1',
				selectedVersionId: 'version-1'
			})
		).toBe(true);
	});

	it('also exposes active and explicitly routed versions but not unrelated drafts', () => {
		expect(
			shouldExposeFieldMappingVersion({
				...draft,
				policyLifecycleState: 'active',
				versionLifecycleState: 'active'
			})
		).toBe(true);
		expect(
			shouldExposeFieldMappingVersion({
				...draft,
				routePolicyOptionId: 'policy-1:version-1:destination'
			})
		).toBe(true);
		expect(shouldExposeFieldMappingVersion(draft)).toBe(false);
	});
});

describe('resolveMappingEditorLaneSelectorMode', () => {
	it('keeps a new unsaved-route editor in profile mode after the first save', () => {
		expect(
			resolveMappingEditorLaneSelectorMode({
				configuredMode: 'profile',
				routePolicyOptionId: null
			})
		).toBe('profile');
	});

	it('uses policy mode for overview pages and route-selected mapping versions', () => {
		expect(
			resolveMappingEditorLaneSelectorMode({
				configuredMode: 'policy',
				routePolicyOptionId: null
			})
		).toBe('policy');
		expect(
			resolveMappingEditorLaneSelectorMode({
				configuredMode: 'profile',
				routePolicyOptionId: 'policy-1:version-1:source'
			})
		).toBe('policy');
	});
});
