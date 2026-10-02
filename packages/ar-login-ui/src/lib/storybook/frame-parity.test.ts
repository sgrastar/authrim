import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function read(url: string): string {
	return readFileSync(new URL(url, import.meta.url), 'utf8');
}

/** The opening tag of the `.login-ui-theme-boundary` element. */
function boundaryTag(source: string): string {
	const start = source.indexOf('class="login-ui-theme-boundary"');
	expect(start, 'boundary element not found').toBeGreaterThan(-1);
	const open = source.lastIndexOf('<div', start);
	const close = source.indexOf('\n>', start);
	return source.slice(open, close + 2);
}

function bound(tag: string, pattern: RegExp): string[] {
	return [...tag.matchAll(pattern)].map((match) => match[1]).sort();
}

describe('Storybook frame', () => {
	const layout = boundaryTag(read('../../routes/+layout.svelte'));
	const frame = boundaryTag(read('./LoginUIFrame.svelte'));

	it('carries the same data-* attributes as the layout boundary', () => {
		const attributes = bound(layout, /\s(data-[a-z-]+)=/g);
		expect(attributes.length).toBeGreaterThan(15);
		expect(bound(frame, /\s(data-[a-z-]+)=/g)).toEqual(attributes);
	});

	it('sets the same inline custom properties as the layout boundary', () => {
		expect(bound(frame, /style:(--[a-z-]+)=/g)).toEqual(bound(layout, /style:(--[a-z-]+)=/g));
	});
});
