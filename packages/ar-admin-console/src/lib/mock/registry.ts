import type { Component } from 'svelte';

type MockPageModule = { default: Component };
type Loader = () => Promise<MockPageModule>;

const files = import.meta.glob<MockPageModule>('./pages/**/*.svelte');

/**
 * The console path a page file stands for: `./pages/users/all.svelte` is `/admin/users/all`,
 * `./pages/index.svelte` is `/admin` and `./pages/platform/index.svelte` is `/admin/platform`.
 * Adding a page is adding a file; nothing is registered by hand.
 */
export function consolePathOfFile(file: string): string {
	const relative = file.replace(/^\.\/pages\//, '').replace(/\.svelte$/, '');
	const segments = relative.split('/').filter((segment) => segment !== 'index');
	return `/admin${segments.length > 0 ? `/${segments.join('/')}` : ''}`;
}

const byPath = new Map<string, Loader>(
	Object.entries(files).map(([file, load]) => [consolePathOfFile(file), load])
);

/** The mock page for a console path, or undefined when none has been made yet. */
export function mockPageFor(consolePath: string): Loader | undefined {
	return byPath.get(consolePath.replace(/\/+$/, '') || '/');
}

/** Every console path that has a mock page. */
export function mockPagePaths(): string[] {
	return [...byPath.keys()].sort();
}
