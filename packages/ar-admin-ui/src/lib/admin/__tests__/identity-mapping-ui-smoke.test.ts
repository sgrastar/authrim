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
	it('keeps the Tier 2 identity mapping routes linked from the main page', () => {
		const layout = readRoute('admin/+layout.svelte');
		const page = readRoute('admin/identity-mapping/+page.svelte');

		expect(layout).toContain('/admin/identity-mapping');
		expect(page).toContain('/admin/identity-mapping/profiles');
		expect(page).toContain('/admin/identity-mapping/operations');
		expect(page).toContain('/admin/identity-mapping/resolution-center');
		expect(page).toContain('/admin/identity-mapping/federation-trust');
		expect(page).toContain('/admin/identity-mapping/schema-readiness');
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
		expect(flowEditor).toContain("role === 'source' && toNode.role === 'target'");
		expect(flowEditor).toContain("role === 'target' && toNode.role === 'destination'");
		expect(flowEditor).toContain('$props');
		expect(flowEditor).not.toContain('mappingSamples');
		expect(flowEditor).not.toContain('SAML Salesforce columns');
		expect(page).toContain('buildIdentityMappingFlowSamples');
		expect(page).toContain('getSchemaReadiness');
		expect(page).toContain('samples={flowSamples}');
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
