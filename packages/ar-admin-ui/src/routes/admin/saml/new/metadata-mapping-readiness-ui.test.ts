import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const pageSource = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');

describe('SAML metadata mapping readiness UI', () => {
	it('waits for Mapping Set release fields after applying a metadata preview', () => {
		expect(pageSource).toContain('async function applyPreviewConfig(config: SAMLProviderConfig)');
		expect(pageSource).toContain('await applyPreviewConfig(preview.config)');
		expect(pageSource).toContain(
			'if (identityMappingFieldMappingSetId) await loadMappingReleaseFields()'
		);
	});

	it('blocks provider submission while mapping choices or release fields are loading', () => {
		const actionsStart = pageSource.indexOf('<div class="form-actions">');
		const actionsEnd = pageSource.indexOf('</div>', actionsStart);
		const actions = pageSource.slice(actionsStart, actionsEnd);

		expect(actions).toContain('importingMetadata');
		expect(actions).toContain('loadingFieldMappingSets || loadingMappingReleaseFields');
	});

	it('allows a disabled provider to be registered before mapping repair is complete', () => {
		expect(pageSource).toContain("return enabled ? validateIdentityMappingSelection() : ''");
		expect(pageSource).toContain(
			"setupTarget !== 'federation' &&\n\t\t\t\t\t\tenabled &&\n\t\t\t\t\t\t(loadingFieldMappingSets || loadingMappingReleaseFields)"
		);
	});
});
