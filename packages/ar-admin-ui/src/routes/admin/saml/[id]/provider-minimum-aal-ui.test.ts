import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const pageSource = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');
const english = readFileSync(new URL('../../../../i18n/en/admin-saml.ts', import.meta.url), 'utf8');
const japanese = readFileSync(
	new URL('../../../../i18n/ja/admin-saml.ts', import.meta.url),
	'utf8'
);

describe('SAML SP minimum authentication assurance level UI', () => {
	it('loads the stored minimum and sends it, or null to remove it, with the SP config', () => {
		expect(pageSource).toContain("minimumAal = data.config.minimumAal ?? '';");
		expect(pageSource).toContain('minimumAal: minimumAal || null,');
	});

	it('offers it only for a service provider, and none, AAL2 and AAL3 to choose from', () => {
		const spSection = pageSource.indexOf("{#if provider.providerType === 'saml_sp'}");
		const select = pageSource.indexOf('<select id="minimumAal" bind:value={minimumAal}');
		expect(spSection).toBeGreaterThan(-1);
		expect(select).toBeGreaterThan(spSection);
		expect(pageSource).toContain('{$LL.admin_saml_detail_minimum_aal_none()}');
		expect(pageSource).toContain('<option value="AAL2">AAL2</option>');
		expect(pageSource).toContain('<option value="AAL3">AAL3</option>');
	});

	it('keeps an AAL1 minimum visible instead of showing it as no minimum', () => {
		expect(pageSource).toContain("{#if minimumAal === 'AAL1'}");
	});

	it('offers the assurance mode of the AuthnContextClassRef emission', () => {
		expect(pageSource).toContain(
			'<input type="radio" bind:group={authnContextClassRefMode} value="assurance" />'
		);
	});

	it('is worded in English and Japanese', () => {
		for (const source of [english, japanese]) {
			expect(source).toContain('admin_saml_detail_minimum_aal:');
			expect(source).toContain('admin_saml_detail_minimum_aal_none:');
			expect(source).toContain('admin_saml_detail_minimum_aal_hint:');
			expect(source).toContain('admin_saml_detail_assurance_level:');
		}
	});
});
