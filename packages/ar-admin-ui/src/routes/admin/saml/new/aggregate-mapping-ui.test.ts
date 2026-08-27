import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const pageSource = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');

describe('SAML aggregate provider registration UI', () => {
	it('defers Field Mapping Set selection until after aggregate provider registration', () => {
		expect(pageSource).not.toContain('id="aggregateIdentityMappingFieldMapping"');
		expect(pageSource).toContain('admin_saml_new_aggregate_mapping_after_create');
	});

	it('registers aggregate providers disabled without a shared mapping configuration', () => {
		const start = pageSource.indexOf('async function startAggregateBatchCreate()');
		const end = pageSource.indexOf('async function pollAggregateBatch()', start);
		const batchCreate = pageSource.slice(start, end);

		expect(batchCreate).toContain('enabled: false');
		expect(batchCreate).not.toContain('identityMapping:');
		expect(batchCreate).not.toContain('providerType:');
	});

	it('keeps aggregate mode controls as non-submit buttons', () => {
		const aggregateModeGrid = pageSource.indexOf('class="template-grid aggregate-mode-grid"');
		const trustProfileBranch = pageSource.indexOf(
			"{#if aggregateImportMode === 'trust_profile'}",
			aggregateModeGrid
		);
		const modeControls = pageSource.slice(aggregateModeGrid, trustProfileBranch);

		expect(aggregateModeGrid).toBeGreaterThan(-1);
		expect(modeControls.match(/type="button"/g)).toHaveLength(2);
	});

	it('labels aggregate entities with equal-width IdP and SP badges', () => {
		expect(pageSource).toContain("entity.role === 'saml_idp' || entity.role === 'ambiguous'");
		expect(pageSource).toContain("entity.role === 'saml_sp' || entity.role === 'ambiguous'");
		expect(pageSource.match(/class="aggregate-entity-role-badge /g)).toHaveLength(2);
		expect(pageSource).toContain('width: 2.75rem;');
		expect(pageSource).toContain('flex: 0 0 2.75rem;');
	});
});
