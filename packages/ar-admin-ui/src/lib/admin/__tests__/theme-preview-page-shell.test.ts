import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
	resolve(__dirname, '../../../routes/admin/themes/+page.svelte'),
	'utf8'
);

describe('theme preview page shell', () => {
	it('previews the header in the auth panel and the footer outside the split main area', () => {
		const headerIndex = source.indexOf('class="preview-auth-header"');
		const mainIndex = source.indexOf('class="preview-main"');
		const panelIndex = source.indexOf('class="preview-auth-container"');
		const footerIndex = source.indexOf('class="preview-footer preview-page-footer"');

		expect(headerIndex).toBeGreaterThan(-1);
		expect(panelIndex).toBeGreaterThan(mainIndex);
		expect(headerIndex).toBeGreaterThan(panelIndex);
		expect(footerIndex).toBeGreaterThan(headerIndex);
		expect(source).not.toContain('preview-page-header');
		expect(source).toContain('.login-preview-page.split .preview-main');
		expect(source).toContain('.login-preview-page.split > .preview-page-footer');
	});

	it('keeps preview controls on the shared compact scale across templates', () => {
		expect(source).toContain('--preview-card-padding: 20px;');
		expect(source).toContain('--preview-control-height: 44px;');
		expect(source).toContain('--preview-heading-size: 1.25rem;');
		expect(source).toContain('min-height: var(--preview-control-height);');
		expect(source).toContain('font-size: var(--preview-header-title-size);');
		expect(source).not.toContain('min-height: 38px;');
		expect(source).not.toContain('min-height: 40px;');
	});
});
