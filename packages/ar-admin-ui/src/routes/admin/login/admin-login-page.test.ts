import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const page = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');

describe('Admin login page', () => {
	it('bounds browser and network authentication phases and cancels a timed out ceremony', () => {
		expect(page).toMatch(/withAdminLoginTimeout\(\s*adminAuthAPI\.getLoginOptions\(\)/u);
		expect(page).toContain('WebAuthnAbortService.cancelCeremony');
		expect(page).toMatch(/withAdminLoginTimeout\(\s*adminAuthAPI\.verifyLogin/u);
		expect(page).toContain('withAdminLoginTimeout(adminAuth.checkAuth()');
	});

	it('does not append raw authentication errors to the operator-visible message', () => {
		expect(page).not.toContain('error +=');
		expect(page).not.toContain("console.error('Login error:'");
	});
});
