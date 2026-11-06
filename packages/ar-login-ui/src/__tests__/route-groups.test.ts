import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROUTES = resolve(__dirname, '../routes');

/**
 * Pages that live outside the `(main)` group on purpose. They get the bare root layout: no
 * Login UI stores, no `app.css`, no UnoCSS. Add a page here only when it brings its own styles.
 */
const PAGES_OUTSIDE_MAIN = new Set<string>([]);

function listFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		return statSync(path).isDirectory() ? listFiles(path) : [path];
	});
}

describe('Login UI route groups', () => {
	const files = listFiles(ROUTES).map((path) => relative(ROUTES, path));

	it('keeps the root layout free of the normal Login UI styles and stores', () => {
		const rootLayout = readFileSync(join(ROUTES, '+layout.svelte'), 'utf8');
		expect(rootLayout).not.toMatch(/import\s+['"][^'"]+\.css['"]/u);
		expect(rootLayout).not.toContain('virtual:uno.css');
		expect(rootLayout).not.toContain('initializeLoginUIStores');
		expect(files).not.toContain('+layout.server.ts');
		expect(files).not.toContain('+layout.ts');
	});

	it('loads the normal Login UI styles and stores in the (main) layout', () => {
		const mainLayout = readFileSync(join(ROUTES, '(main)/+layout.svelte'), 'utf8');
		expect(mainLayout).toContain("import 'virtual:uno.css';");
		expect(mainLayout).toContain("import '../../app.css';");
		expect(mainLayout).toContain('initializeLoginUIStores');
	});

	it('puts every page in the (main) group unless it is listed', () => {
		const pagesOutsideMain = files
			.filter((path) => /(^|\/)\+page(\.server)?\.(svelte|ts)$/u.test(path))
			.filter((path) => !path.startsWith('(main)/'))
			.map((path) => path.replace(/\/?\+page(\.server)?\.(svelte|ts)$/u, '') || '/');
		expect(pagesOutsideMain.filter((page) => !PAGES_OUTSIDE_MAIN.has(page))).toEqual([]);
	});
});
