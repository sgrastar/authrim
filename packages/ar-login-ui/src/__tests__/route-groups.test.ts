import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROUTES = resolve(__dirname, '../routes');

/**
 * Pages that live outside the `(main)` group on purpose. They get the bare root layout: no
 * Login UI stores, no `app.css`, no UnoCSS. Add a page here only when it brings its own styles.
 */
/**
 * Pages outside (main) and the lite group: the statement text framed on the consent step, drawn
 * on the server without the normal Login UI (the same for both).
 */
const PAGES_OUTSIDE_MAIN = new Set<string>(['statements/[slug]/embed']);

/**
 * The lite Login UI's pages (routes/__lite): reached only through reroute, with their own inline
 * stylesheet and no client JavaScript.
 */
const LITE_PREFIX = '__lite';

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
		// Its one server load only reads the platform's environment banner from the request's
		// authentication methods answer (no fetch of its own); it has no universal load.
		const rootLoad = readFileSync(join(ROUTES, '+layout.server.ts'), 'utf8');
		expect(rootLoad).not.toMatch(/\bfetch\(/u);
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
		expect(
			pagesOutsideMain.filter(
				(page) => !PAGES_OUTSIDE_MAIN.has(page) && !page.startsWith(`${LITE_PREFIX}/`)
			)
		).toEqual([]);
	});

	it('keeps the lite pages free of the normal Login UI styles and client scripts', () => {
		const liteLayout = readFileSync(join(ROUTES, '__lite/+layout.ts'), 'utf8');
		expect(liteLayout).toContain('export const csr = false;');
		for (const path of files.filter((file) => file.startsWith(`${LITE_PREFIX}/`))) {
			const source = readFileSync(join(ROUTES, path), 'utf8');
			expect(source, path).not.toMatch(/import\s+['"][^'"]+\.css['"]/u);
			expect(source, path).not.toContain('virtual:uno.css');
		}
	});
});
