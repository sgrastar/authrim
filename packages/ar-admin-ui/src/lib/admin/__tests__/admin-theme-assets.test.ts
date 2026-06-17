import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const srcDir = fileURLToPath(new URL('../../../', import.meta.url));
const packageDir = fileURLToPath(new URL('../../../../', import.meta.url));
const staticDir = `${packageDir}/static`;
const stylesDir = `${srcDir}/lib/styles`;

function walkFiles(dir: string): string[] {
	return readdirSync(dir)
		.flatMap((entry) => {
			const path = `${dir}/${entry}`;
			return statSync(path).isDirectory() ? walkFiles(path) : [path];
		})
		.sort();
}

function readSource(relativePath: string): string {
	return readFileSync(`${srcDir}/${relativePath}`, 'utf8');
}

describe('Admin UI theme assets', () => {
	it('loads Admin UI theme fonts as bundled Vite assets', () => {
		const appCss = readSource('app.css');
		const fontsCss = readSource('lib/styles/fonts.css');
		const fontUrls = [...fontsCss.matchAll(/url\('([^']+)'\)/g)].map((match) => match[1]);

		expect(appCss).toContain("@import './lib/styles/fonts.css'");
		expect(fontUrls.length).toBeGreaterThan(0);

		for (const fontUrl of fontUrls) {
			expect(fontUrl.startsWith('../assets/fonts/admin-ui/')).toBe(true);
			expect(fontUrl).not.toMatch(/zen-(?:kaku|maru)/);
			expect(existsSync(`${stylesDir}/${fontUrl}`), `${fontUrl} should exist as a Vite asset`).toBe(
				true
			);
		}

		expect(fontsCss).not.toMatch(/Zen (?:Kaku|Maru)/);
	});

	it('does not reference Google Fonts from Admin UI source or static assets', () => {
		const scannedFiles = [...walkFiles(srcDir), ...walkFiles(staticDir)].filter((path) =>
			/\.(css|html|svelte|ts|js|json)$/.test(path)
		);
		const externalFontReferences = scannedFiles
			.map((path) => ({
				path: relative(packageDir, path),
				source: readFileSync(path, 'utf8')
			}))
			.filter(({ source }) => /fonts\.googleapis|fonts\.gstatic|https:\/\/fonts\./.test(source))
			.map(({ path }) => path);

		expect(externalFontReferences).toEqual([]);
	});

	it('keeps CSS theme selection on Admin skins instead of legacy variants', () => {
		const themesCss = readSource('lib/styles/themes.css');

		expect(themesCss).toContain("data-admin-skin='classic'");
		expect(themesCss).toContain("data-admin-skin='admin'");
		expect(themesCss).toContain("data-admin-skin='paper-beige'");
		expect(themesCss).toContain("data-admin-skin='frosted'");
		expect(themesCss).not.toContain('data-variant');
		expect(themesCss).not.toContain('variant-btn');
		expect(themesCss).not.toContain('light-variant-selector');
		expect(themesCss).not.toContain('dark-variant-selector');
	});

	it('keeps spreadsheet-style profile editors theme-token driven', () => {
		const themesCss = readSource('lib/styles/themes.css');
		const profileEditor = readSource('routes/admin/field-mapping/profiles/edit/+page.svelte');

		for (const token of [
			'--sheet-header-bg',
			'--sheet-row-bg',
			'--sheet-row-hover-bg',
			'--sheet-cell-height',
			'--sheet-cell-padding',
			'--sheet-shadow'
		]) {
			expect(themesCss).toContain(token);
			expect(profileEditor).toContain(token);
		}
	});

	it('keeps detail and danger surfaces theme-token driven', () => {
		const themesCss = readSource('lib/styles/themes.css');
		const detailHeader = readSource('lib/components/admin/AdminDetailHeader.svelte');
		const clientDetail = readSource('routes/admin/clients/[id]/+page.svelte');
		const customClaimDetail = readSource('routes/admin/custom-claims/[id]/+page.svelte');

		for (const token of [
			'--detail-icon-size',
			'--detail-icon-border',
			'--detail-title-size',
			'--detail-meta-size',
			'--info-label-size',
			'--info-value-size'
		]) {
			expect(themesCss).toContain(token);
		}

		for (const token of [
			'--detail-icon-size',
			'--detail-icon-border',
			'--detail-title-size',
			'--detail-meta-size'
		]) {
			expect(detailHeader).toContain(token);
		}

		for (const token of [
			'--danger-zone-bg',
			'--danger-zone-border',
			'--danger-zone-radius',
			'--danger-zone-padding',
			'--danger-zone-title-size',
			'--danger-zone-description-size'
		]) {
			expect(themesCss).toContain(token);
			expect(clientDetail).toContain(token);
			expect(customClaimDetail).toContain(token);
		}
	});

	it('keeps Frosted tabs as a glass segmented control', () => {
		const themesCss = readSource('lib/styles/themes.css');
		const frostedBlock = themesCss.match(/:root\[data-admin-skin='frosted'\] \{[\s\S]*?\n\}/)?.[0];

		expect(frostedBlock).toContain('--tabs-gap: 4px');
		expect(frostedBlock).toContain('--tabs-padding: 5px');
		expect(frostedBlock).toContain('--tabs-margin-bottom: 26px');
		expect(frostedBlock).toContain('--tabs-width: fit-content');
		expect(frostedBlock).toContain('--tabs-radius: 12px');
		expect(frostedBlock).toContain('--tabs-bg: rgba(255, 255, 255, 0.46)');
		expect(frostedBlock).toContain('--tabs-tab-height: 34px');
		expect(frostedBlock).toContain('--tabs-tab-active-bg: var(--color-accent)');
		expect(frostedBlock).toContain('--tabs-tab-active-marker-display: none');
	});

	it('keeps the setup sky transition available for light and dark mode switches', () => {
		const themesCss = readSource('lib/styles/themes.css');

		expect(themesCss).toContain('html.theme-transitioning::after');
		expect(themesCss).toContain('html.theme-transitioning.theme-transition-to-light::after');
		expect(themesCss).toContain('@keyframes authrim-dusk');
		expect(themesCss).toContain('@keyframes authrim-dawn');
		expect(themesCss).toContain(
			'linear-gradient(180deg, rgba(226, 138, 88, 0.24), rgba(45, 59, 94, 0.32))'
		);
		expect(themesCss).toContain(
			'linear-gradient(180deg, rgba(102, 138, 178, 0.2), rgba(244, 196, 132, 0.22))'
		);
	});
});
