import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const pageSource = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');
const english = readFileSync(new URL('../../../../i18n/en/admin-saml.ts', import.meta.url), 'utf8');
const japanese = readFileSync(
	new URL('../../../../i18n/ja/admin-saml.ts', import.meta.url),
	'utf8'
);

describe('SAML SP minimum identity assurance level UI', () => {
	it('loads the stored minimum and sends it, or null to remove it, with the SP config', () => {
		expect(pageSource).toContain("minimumIal = data.config.minimumIal ?? '';");
		expect(pageSource).toContain('minimumIal: minimumIal || null,');
	});

	it('offers it only for a service provider, and none, IAL2 and IAL3 to choose from', () => {
		const spSection = pageSource.indexOf("{#if provider.providerType === 'saml_sp'}");
		const select = pageSource.indexOf('<select id="minimumIal" bind:value={minimumIal}');
		expect(spSection).toBeGreaterThan(-1);
		expect(select).toBeGreaterThan(spSection);
		expect(pageSource).toContain('{$LL.admin_saml_detail_minimum_ial_none()}');
		expect(pageSource).toContain('<option value="IAL2">IAL2</option>');
		expect(pageSource).toContain('<option value="IAL3">IAL3</option>');
	});

	it('keeps an IAL1 minimum visible instead of showing it as no minimum', () => {
		expect(pageSource).toContain("{#if minimumIal === 'IAL1'}");
	});

	it('is worded in English and Japanese', () => {
		for (const source of [english, japanese]) {
			expect(source).toContain('admin_saml_detail_minimum_ial:');
			expect(source).toContain('admin_saml_detail_minimum_ial_none:');
			expect(source).toContain('admin_saml_detail_minimum_ial_hint:');
		}
	});
});
