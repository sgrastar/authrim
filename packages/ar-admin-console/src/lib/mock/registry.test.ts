import { describe, expect, it } from 'vitest';
import { isStandalonePath, resolveNavPath } from '$lib/shell/nav';
import { consolePathOfFile, mockPageFor, mockPagePaths } from './registry';

describe('mock page registry', () => {
	it('reads a page file as the console path it stands for', () => {
		expect(consolePathOfFile('./pages/index.svelte')).toBe('/admin');
		expect(consolePathOfFile('./pages/users/all.svelte')).toBe('/admin/users/all');
		expect(consolePathOfFile('./pages/platform/index.svelte')).toBe('/admin/platform');
		expect(consolePathOfFile('./pages/platform/tenants/list.svelte')).toBe(
			'/admin/platform/tenants/list'
		);
	});

	it('finds a page by console path, with or without a trailing slash', () => {
		expect(mockPageFor('/admin/users/all')).toBeTypeOf('function');
		expect(mockPageFor('/admin/users/all/')).toBe(mockPageFor('/admin/users/all'));
		expect(mockPageFor('/admin/users/nothing-here')).toBeUndefined();
	});

	// A page file at a path the navigation does not have would never be reached.
	it('has only pages at places the navigation knows', () => {
		for (const path of mockPagePaths()) {
			expect(resolveNavPath(path) ?? (isStandalonePath(path) ? {} : null), path).not.toBeNull();
		}
	});
});
