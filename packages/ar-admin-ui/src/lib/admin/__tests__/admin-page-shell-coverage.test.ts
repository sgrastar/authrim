import { readdirSync, readFileSync, statSync } from 'node:fs';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const adminRoutesDir = fileURLToPath(new URL('../../../routes/admin', import.meta.url));
const srcDir = fileURLToPath(new URL('../../../', import.meta.url));

function walkFiles(dir: string): string[] {
	return readdirSync(dir)
		.flatMap((entry) => {
			const path = `${dir}/${entry}`;
			return statSync(path).isDirectory() ? walkFiles(path) : [path];
		})
		.sort();
}

function relativeToSrc(path: string): string {
	return relative(srcDir, path);
}

describe('Admin UI route structure', () => {
	it('keeps Admin pages on the shared page shell or an approved shell wrapper', () => {
		const approvedStandalonePages = new Set(['routes/admin/login/+page.svelte']);
		const adminPages = walkFiles(adminRoutesDir).filter((path) => path.endsWith('/+page.svelte'));

		const missingShell = adminPages
			.map((path) => ({
				path: relativeToSrc(path),
				source: readFileSync(path, 'utf8')
			}))
			.filter(({ path, source }) => {
				if (approvedStandalonePages.has(path)) return false;
				return !source.includes('AdminPageShell') && !source.includes('IdentityMappingPageShell');
			})
			.map(({ path }) => path);

		expect(missingShell).toEqual([]);
	});

	it('keeps generated backup and scratch files out of the Admin UI source tree', () => {
		const scratchFiles = walkFiles(srcDir)
			.map(relativeToSrc)
			.filter(
				(path) => /\.(bak|backup|old|tmp)$/.test(path) || /(^|\/)[^/]*guide\.html$/.test(path)
			);

		expect(scratchFiles).toEqual([]);
	});

	it('keeps theme switching routed through the shared ThemeSwitcher component', () => {
		const header = readFileSync(`${srcDir}/lib/components/admin/AdminHeader.svelte`, 'utf8');
		const switcher = readFileSync(`${srcDir}/lib/components/admin/ThemeSwitcher.svelte`, 'utf8');

		expect(header).toContain('<ThemeSwitcher variant="menu" />');
		expect(header).not.toContain('themeStore.setSkin');
		expect(header).not.toContain('themeStore.setMode');
		expect(switcher).toContain("variant?: 'toolbar' | 'menu'");
		expect(switcher).toContain('themeStore.setSkin');
		expect(switcher).toContain('themeStore.setMode');
	});

	it('keeps Admin route tables routed through the shared AdminDataTable component', () => {
		const adminPages = walkFiles(adminRoutesDir).filter((path) => path.endsWith('/+page.svelte'));

		const rawTablePages = adminPages
			.map((path) => ({
				path: relativeToSrc(path),
				source: readFileSync(path, 'utf8')
			}))
			.filter(({ source }) => source.includes('<table'))
			.map(({ path }) => path);

		expect(rawTablePages).toEqual([]);
	});

	it('keeps hidden Admin routes covered by breadcrumbs and platform context detection', () => {
		const layout = readFileSync(`${srcDir}/routes/admin/+layout.svelte`, 'utf8');
		const hiddenBreadcrumbRoutes = [
			'/admin/account-settings',
			'/admin/role-rules',
			'/admin/platform/tenant-domain-mappings',
			'/admin/admin-roles'
		];
		const platformOnlyRoutes = [
			'/admin/tenant-vanity-domains',
			'/admin/platform/tenant-domain-mappings',
			'/admin/dr-backup',
			'/admin/approvals',
			'/admin/operational-logs'
		];

		for (const route of hiddenBreadcrumbRoutes) {
			expect(layout).toContain(`path: '${route}'`);
		}

		for (const route of platformOnlyRoutes) {
			expect(layout).toContain(`'${route}'`);
		}
	});
});
