import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function readRoute(relativePath: string): string {
	const path = fileURLToPath(new URL(`../../../routes/${relativePath}`, import.meta.url));
	return readFileSync(path, 'utf8');
}

function readApi(relativePath: string): string {
	const path = fileURLToPath(new URL(`../../api/${relativePath}`, import.meta.url));
	return readFileSync(path, 'utf8');
}

describe('field mapping Admin UI smoke checks', () => {
	it('keeps the field mapping routes in the left navigation instead of bottom cards', () => {
		const layout = readRoute('admin/+layout.svelte');

		expect(layout).toContain('/admin/field-mapping');
		expect(layout).toContain('admin_nav_source_destination');
		expect(layout).toContain('/admin/field-mapping/profiles');
		expect(layout).toContain('/admin/resolution-center');
		expect(layout).toContain('showInSidebar: false');
		expect(layout).not.toContain("href: '/admin/field-mapping/resolution-center'");
		expect(layout).not.toContain('Mapping Rules');
		expect(layout).not.toContain('/admin/field-mapping/operations');
		expect(layout).not.toContain('/admin/field-mapping/overview');
		expect(layout).not.toContain('/admin/field-mapping/field-mapping-sets');
		expect(layout).not.toContain('/admin/field-mapping/edit');
		expect(layout).not.toContain('/admin/field-mapping/federation-trust');
		expect(layout).not.toContain('/admin/field-mapping/schema-readiness');
		expect(layout).not.toContain('/admin/field-mapping/profiles#destination-consent');
	});

	it('wires operation, profile, resolution, and federation pages to their APIs', () => {
		const api = readApi('admin-identity-mapping.ts');
		const profiles = readRoute('admin/field-mapping/profiles/+page.svelte');
		const profileEditor = readRoute('admin/field-mapping/profiles/edit/+page.svelte');
		const resolution = readRoute('admin/resolution-center/+page.svelte');
		const federation = readRoute('admin/field-mapping/federation-trust/+page.svelte');

		expect(api).toContain('/api/admin/identity-mapping/review-tasks');
		expect(api).toContain('/api/admin/federation/trust-sources');
		expect(api).toContain('/metadata-documents');
		expect(api).toContain('/api/admin/identity-mapping/protocol-schemas');
		expect(api).toContain('/api/admin/identity-mapping/external-schemas');
		expect(api).toContain('/api/admin/identity-mapping/source-profiles');
		expect(api).toContain('/api/admin/identity-mapping/source-profiles/csv/parse');
		expect(api).toContain('/api/admin/identity-mapping/destination-profiles');
		expect(api).toContain('deleteSourceProfile');
		expect(api).toContain('deleteDestinationProfile');
		expect(api).toContain('/api/admin/identity-mapping/attribute-groups');
		expect(api).toContain('/api/admin/identity-mapping/attribute-fields');
		expect(api).toContain('/api/admin/identity-mapping/templates');
		expect(api).toContain('/api/admin/identity-mapping/schema-readiness');
		expect(api).toContain('/activate');
		expect(api).toContain('/transition');
		expect(profiles).toContain('listSourceProfiles');
		expect(profiles).toContain('listDestinationProfiles');
		expect(profiles).toContain('admin_identity_mapping_profiles_lists_title');
		expect(profiles).toContain('sourceProfileListItems');
		expect(profiles).toContain('destinationProfileListItems');
		expect(profiles).toContain('admin_identity_mapping_profiles_create_source');
		expect(profiles).toContain('admin_identity_mapping_profiles_create_destination');
		expect(profiles).toContain('/admin/field-mapping/profiles/edit?kind=source');
		expect(profiles).toContain('/admin/field-mapping/profiles/edit?kind=destination');
		expect(profiles).toContain('onclick={() => editSourceProfile(profile)}');
		expect(profiles).toContain('onclick={() => editDestinationProfile(profile)}');
		expect(profiles).not.toContain('listProtocolSchemas');
		expect(profiles).not.toContain('listExternalSchemas');
		expect(profiles).not.toContain('listAttributeGroups');
		expect(profiles).not.toContain('listAttributeFields');
		expect(profiles).not.toContain('listTemplates');
		expect(profileEditor).toContain('admin_identity_mapping_profile_edit_create_source');
		expect(profileEditor).toContain('admin_identity_mapping_profile_edit_create_destination');
		expect(profileEditor).toContain('listAttributeGroups');
		expect(profileEditor).toContain('listAttributeFields');
		expect(profileEditor).toContain('destinationTemplates');
		expect(profileEditor).toContain('sourceTemplates');
		expect(profileEditor).toContain("setSourceKind('scim')");
		expect(profileEditor).toContain('admin_identity_mapping_profile_edit_source_method_aria');
		expect(profileEditor).toContain('copyScimSourceTemplate');
		expect(profileEditor).toContain('admin_identity_mapping_profile_edit_create_from_existing');
		expect(profileEditor).toContain('admin_identity_mapping_profile_edit_create_from_template');
		expect(profileEditor).not.toContain(
			'admin_identity_mapping_profile_edit_destination_consent_settings'
		);
		expect(profileEditor).not.toContain(
			'admin_identity_mapping_profile_edit_configure_release_consent'
		);
		expect(profileEditor).not.toContain('id="destination-consent"');
		expect(profileEditor).toContain('deleteCurrentProfile');
		expect(profileEditor).toContain('admin_identity_mapping_profile_edit_delete');
		expect(profileEditor).toContain('parseCsvSourceProfile');
		expect(profileEditor).toContain('const stagedProfileLifecycleControlsEnabled = false');
		expect(profileEditor).toContain('completingProfileLifecycle');
		expect(profileEditor).toContain('saveAndActivateCurrentProfile');
		expect(profileEditor).toContain('completeProfileLifecycle');
		expect(profileEditor).toContain('reviewDraft: reviewCurrentProfileVersion');
		expect(profileEditor).toContain('activateVersion: activateCurrentProfileVersion');
		expect(profileEditor).toContain('admin_identity_mapping_profile_edit_save()');
		expect(profileEditor).toContain('admin_identity_mapping_profile_edit_save_draft_profile');
		expect(profileEditor).toContain('admin_identity_mapping_profile_edit_save_destination_draft');
		expect(profileEditor).toContain('admin_identity_mapping_profile_edit_manual');
		expect(profileEditor).toContain('Shift_JIS');
		expect(profileEditor).toContain('admin_identity_mapping_profile_edit_add_saml_attribute');
		expect(profileEditor).toContain('admin_identity_mapping_profile_edit_save_attribute_group');
		expect(profileEditor).toContain('admin_identity_mapping_profile_edit_save_attribute_field');
		expect(profileEditor).not.toContain('admin_identity_mapping_profile_edit_tenant_default');
		expect(profileEditor).not.toContain('admin_identity_mapping_profile_edit_destination_override');
		expect(profiles).not.toContain('admin_identity_mapping_profile_edit_save_draft_profile');
		expect(profiles).not.toContain('admin_identity_mapping_profile_edit_save_destination_draft');
		expect(profiles).not.toContain(
			'admin_identity_mapping_profile_edit_destination_consent_settings'
		);
		expect(resolution).toContain('listReviewTasks');
		expect(resolution).toContain("status: 'in_review'");
		expect(resolution).toContain('transitionResolutionItem');
		expect(federation).toContain('listFederationTrustSources');
		expect(federation).toContain('listFederationMetadataDocuments');
		expect(federation).toContain('listAggregatePreviewEntities');
	});

	it('loads schema readiness from the control-plane API instead of hardcoded rows', () => {
		const readiness = readRoute('admin/field-mapping/schema-readiness/+page.svelte');

		expect(readiness).toContain('getSchemaReadiness');
		expect(readiness).toContain('schemaPresent');
		expect(readiness).toContain('gateState');
		expect(readiness).not.toContain('const rows: ReadinessRow[]');
	});

	it('keeps operator naming separate from internal review task storage names', () => {
		const resolution = readRoute('admin/resolution-center/+page.svelte');

		expect(resolution).toContain('admin_identity_mapping_resolution_title');
		expect(resolution).not.toContain('review_tasks');
		expect(resolution).not.toContain('Review Queue');
	});

	it('redirects the legacy field mapping resolution route to the dashboard-adjacent URL', () => {
		const legacyRoute = readRoute('admin/field-mapping/resolution-center/+page.server.ts');

		expect(legacyRoute).toContain("redirect(301, '/admin/resolution-center')");
	});
});
