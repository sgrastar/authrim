import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * In a Svelte template a quoted attribute still interpolates `{…}`, so pattern="[0-9]{6}" reaches
 * the browser as pattern="[0-9]6" and rejects every valid code. Regex quantifiers must be passed
 * as an expression: pattern={'[0-9]{6}'}.
 */

const SRC = fileURLToPath(new URL('..', import.meta.url));

function svelteFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return svelteFiles(path);
		return entry.name.endsWith('.svelte') ? [path] : [];
	});
}

describe('pattern attributes', () => {
	it('never put a regex quantifier inside a quoted attribute', () => {
		const offenders = svelteFiles(SRC).flatMap((path) =>
			[...readFileSync(path, 'utf8').matchAll(/\bpattern="[^"]*\{[^"]*"/g)].map(
				(match) => `${relative(SRC, path)}: ${match[0]}`
			)
		);
		expect(offenders).toEqual([]);
	});
});
