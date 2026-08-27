import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const pageSource = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');

describe('SAML provider deferred mapping setup UI', () => {
	it('explains why an imported provider is disabled until mapping is configured', () => {
		expect(pageSource).toContain('{#if !identityMappingFieldMappingSetId}');
		expect(pageSource).toContain('admin_saml_detail_mapping_pending');
	});

	it('does not allow enabling a provider before a Field Mapping Set is selected', () => {
		expect(pageSource).toContain('disabled={!enabled && !identityMappingFieldMappingSetId}');
		expect(pageSource).toContain('admin_saml_detail_provider_status_mapping_required');
	});

	it('keeps the resolved destination profile after a normalized provider save response', () => {
		expect(pageSource).toContain('identityMappingDestinationProfileId = destinationProfileIds[0]');
		expect(pageSource).not.toContain(
			"identityMappingDestinationProfileId = data.config.identityMapping?.destinationProfileId || ''"
		);
	});

	it('allows a broken mapping to be saved only while the provider is disabled', () => {
		expect(pageSource).toContain('if (enabled && !identityMappingFieldMappingSetId)');
		expect(pageSource).toContain(
			"if (enabled && provider?.providerType === 'saml_sp' && mappingReleaseFieldsError)"
		);
	});

	it('uses compatible Mapping Set choices and preserves advanced mapping selectors', () => {
		expect(pageSource).toContain('buildSelectableFieldMappingSets({');
		expect(pageSource).toContain('buildProviderIdentityMapping({');
		expect(pageSource).not.toContain('{#each fieldMappingSets as fieldMappingSet');
	});

	it('waits for Mapping Set resolution before saving an enabled provider', () => {
		expect(pageSource).toContain('if (enabled && loadingMappingReleaseFields) return');
		expect(pageSource).toContain(
			'disabled={saving || (enabled && loadingMappingReleaseFields)}'
		);
	});
});
