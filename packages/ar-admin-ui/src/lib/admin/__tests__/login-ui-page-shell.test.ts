import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
	resolve(__dirname, '../../../routes/admin/login-ui/+page.svelte'),
	'utf8'
);

describe('Login UI settings page shell', () => {
	it('removes the redundant outer border from settings panels', () => {
		expect(source).toMatch(/\.settings-detail-page\s*\{[^}]*--panel-border:\s*none;/);
	});
});
