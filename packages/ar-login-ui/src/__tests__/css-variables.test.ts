import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Every CSS custom property a component reads must be one the Login UI defines. An undefined one
 * resolves to nothing (or silently to its fallback), which is how account surfaces ended up
 * transparent and skeletons invisible.
 *
 * app.css is a definition source only: it still carries unused rules whose references are cleaned
 * up separately.
 */

const SRC = fileURLToPath(new URL('..', import.meta.url));

function sources(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return sources(path);
		return /\.(svelte|css|ts)$/.test(entry.name) && !/\.(test|spec)\.ts$/.test(entry.name)
			? [path]
			: [];
	});
}

const files = sources(SRC).map((path) => ({ path, text: readFileSync(path, 'utf8') }));

const defined = new Set(
	files.flatMap(({ text }) => [
		...[...text.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)].map((match) => match[1]),
		...[...text.matchAll(/style:(--[a-zA-Z0-9-]+)/g)].map((match) => match[1]),
		...[...text.matchAll(/setProperty\(\s*['"](--[a-zA-Z0-9-]+)/g)].map((match) => match[1])
	])
);

describe('CSS custom properties', () => {
	it('components read only properties the Login UI defines', () => {
		const undefinedReads = files
			.filter(({ path }) => !path.endsWith('app.css'))
			.flatMap(({ path, text }) =>
				[...text.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)/g)]
					.filter((match) => !defined.has(match[1]))
					.map((match) => {
						const line = text.slice(0, match.index).split('\n').length;
						return `${relative(SRC, path)}:${line} ${match[1]}`;
					})
			);
		expect(undefinedReads).toEqual([]);
	});
});
