import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('SAML local metadata state', () => {
	it('does not label an unavailable tenant-info request as an undeployed SAML Worker', () => {
		const page = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');

		expect(page).toContain('{#if tenantInfo && !tenantInfo.components.saml}');
		expect(page).not.toContain('{#if !tenantInfo?.components.saml}');
	});
});
