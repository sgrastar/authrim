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

function readComponent(relativePath: string): string {
	const path = fileURLToPath(new URL(`../../components/${relativePath}`, import.meta.url));
	return readFileSync(path, 'utf8');
}

describe('identity mapping Admin UI smoke checks', () => {
	it('keeps the identity mapping routes in the left navigation instead of bottom cards', () => {
		const layout = readRoute('admin/+layout.svelte');
		const page = readRoute('admin/identity-mapping/+page.svelte');

		expect(layout).toContain('/admin/identity-mapping');
		expect(layout).toContain('/admin/identity-mapping/profiles');
		expect(layout).toContain('/admin/identity-mapping/operations');
		expect(layout).toContain('/admin/identity-mapping/resolution-center');
		expect(layout).toContain('/admin/identity-mapping/federation-trust');
		expect(layout).toContain('/admin/identity-mapping/schema-readiness');
		expect(layout).toContain('/admin/identity-mapping/profiles#destination-consent');
		expect(page).not.toContain('operations-grid');
		expect(page).not.toContain('operation-card');
	});

	it('keeps the flow editor graph interaction affordances present', () => {
		const flowEditor = readComponent('identity-mapping/IdentityMappingFlowEditor.svelte');
		const page = readRoute('admin/identity-mapping/+page.svelte');

		expect(flowEditor).toContain('startConnectionDrag');
		expect(flowEditor).toContain('drag-edge');
		expect(flowEditor).toContain('edge-selected');
		expect(flowEditor).toContain('adapter-hidden');
		expect(flowEditor).toContain('node-handle output');
		expect(flowEditor).toContain('node-handle input');
		expect(flowEditor).toContain('Consent status');
		expect(flowEditor).toContain('Challenge mode');
		expect(flowEditor).toContain('Release policy');
		expect(flowEditor).toContain('Privacy Policy');
		expect(flowEditor).toContain('Overview');
		expect(flowEditor).toContain('Inbound mapping');
		expect(flowEditor).toContain('Outbound release');
		expect(flowEditor).toContain('view-inbound');
		expect(flowEditor).toContain('view-outbound');
		expect(flowEditor).toContain("role === 'source' && toNode.role === 'target'");
		expect(flowEditor).toContain("role === 'target' && toNode.role === 'destination'");
		expect(flowEditor).toContain('$props');
		expect(flowEditor).not.toContain('mappingSamples');
		expect(flowEditor).not.toContain('SAML Salesforce columns');
		expect(flowEditor).not.toContain('Identity Mapping Control Plane');
		expect(flowEditor).not.toContain('Authrim Admin');
		expect(flowEditor).not.toContain('Theme');
		expect(page).toContain('buildIdentityMappingFlowSamples');
		expect(page).toContain('getSchemaReadiness');
		expect(page).toContain('samples={flowSamples}');
		expect(page).not.toContain('Tier 2 Operations');
	});

	it('wires operation, profile, resolution, and federation pages to their APIs', () => {
		const api = readApi('admin-identity-mapping.ts');
		const operations = readRoute('admin/identity-mapping/operations/+page.svelte');
		const profiles = readRoute('admin/identity-mapping/profiles/+page.svelte');
		const resolution = readRoute('admin/identity-mapping/resolution-center/+page.svelte');
		const federation = readRoute('admin/identity-mapping/federation-trust/+page.svelte');

		expect(api).toContain('/api/admin/identity-mapping/review-tasks');
		expect(api).toContain('/api/admin/identity-mapping/federation-trust-sources');
		expect(api).toContain('/metadata-documents');
		expect(api).toContain('/api/admin/identity-mapping/protocol-schemas');
		expect(api).toContain('/api/admin/identity-mapping/external-schemas');
		expect(api).toContain('/api/admin/identity-mapping/source-profiles');
		expect(api).toContain('/api/admin/identity-mapping/source-profiles/csv/parse');
		expect(api).toContain('/api/admin/identity-mapping/destination-profiles');
		expect(api).toContain('/api/admin/identity-mapping/oidc/custom-scopes');
		expect(api).toContain('/api/admin/identity-mapping/oidc/custom-claims');
		expect(api).toContain('/api/admin/identity-mapping/templates');
		expect(api).toContain('/api/admin/identity-mapping/schema-readiness');
		expect(api).toContain('/rollback');
		expect(api).toContain('/publish');
		expect(api).toContain('/compile');
		expect(api).toContain('/activate');
		expect(api).toContain('/transition');
		expect(operations).toContain('Confirm rollback');
		expect(operations).toContain('rollbackPolicy');
		expect(operations).toContain('runPolicyOperation');
		expect(profiles).toContain('listProtocolSchemas');
		expect(profiles).toContain('listExternalSchemas');
		expect(profiles).toContain('listSourceProfiles');
		expect(profiles).toContain('listDestinationProfiles');
		expect(profiles).toContain('listOidcCustomScopes');
		expect(profiles).toContain('listOidcCustomClaims');
		expect(profiles).toContain('parseCsvSourceProfile');
		expect(profiles).toContain('Save draft profile');
		expect(profiles).toContain('Save destination draft');
		expect(profiles).toContain('Save custom scope');
		expect(profiles).toContain('Save custom claim');
		expect(profiles).toContain('Manual columns');
		expect(profiles).toContain('Shift_JIS');
		expect(profiles).toContain('listTemplates');
		expect(profiles).toContain('Destination Consent Settings');
		expect(profiles).toContain('Tenant default');
		expect(profiles).toContain('Client override');
		expect(resolution).toContain('listReviewTasks');
		expect(resolution).toContain("status: 'in_review'");
		expect(resolution).toContain('transitionResolutionItem');
		expect(federation).toContain('listFederationTrustSources');
		expect(federation).toContain('listFederationMetadataDocuments');
		expect(federation).toContain('listAggregatePreviewEntities');
	});

	it('loads schema readiness from the control-plane API instead of hardcoded rows', () => {
		const readiness = readRoute('admin/identity-mapping/schema-readiness/+page.svelte');

		expect(readiness).toContain('getSchemaReadiness');
		expect(readiness).toContain('schemaPresent');
		expect(readiness).toContain('gateState');
		expect(readiness).not.toContain('const rows: ReadinessRow[]');
	});

	it('keeps operator naming separate from internal review task storage names', () => {
		const resolution = readRoute('admin/identity-mapping/resolution-center/+page.svelte');

		expect(resolution).toContain('Mapping Resolution Center');
		expect(resolution).not.toContain('review_tasks');
		expect(resolution).not.toContain('Review Queue');
	});
});
