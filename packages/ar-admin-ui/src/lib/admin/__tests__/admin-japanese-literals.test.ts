import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const srcRoot = resolve(__dirname, '../../..');
const japanesePattern = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

function walkSvelteFiles(directory: string): string[] {
	return readdirSync(directory).flatMap((entry) => {
		const path = resolve(directory, entry);
		return statSync(path).isDirectory()
			? walkSvelteFiles(path)
			: path.endsWith('.svelte')
				? [path]
				: [];
	});
}

function stripNonMarkup(content: string): string {
	return content
		.replace(/<script\b[\s\S]*?<\/script\b[^>]*>/gi, '')
		.replace(/<style\b[\s\S]*?<\/style\b[^>]*>/gi, '')
		.replace(/<!--[\s\S]*?-->/g, '');
}

function staticJapaneseMarkup(content: string): string[] {
	const markup = stripNonMarkup(content);
	const findings: string[] = [];

	for (const match of markup.matchAll(/>\s*([^<>{}][^<>{}]*)\s*</g)) {
		const value = match[1].replace(/\s+/g, ' ').trim();
		if (japanesePattern.test(value) && value !== '日本語') findings.push(value);
	}

	for (const match of markup.matchAll(/\b[\w-]+\s*=\s*(["'])(.*?)\1/g)) {
		const value = match[2].replace(/\s+/g, ' ').trim();
		if (japanesePattern.test(value)) findings.push(value);
	}

	return findings;
}

describe('Admin UI Japanese literal guard', () => {
	it('does not render static Japanese text independently of the selected locale', () => {
		const findings = walkSvelteFiles(srcRoot).flatMap((path) =>
			staticJapaneseMarkup(readFileSync(path, 'utf8')).map((value) => ({ path, value }))
		);

		expect(findings).toEqual([]);
	});

	it('keeps authentication method pages fully backed by the translation catalog', () => {
		const pages = [
			resolve(srcRoot, 'routes/admin/authentication-methods/+page.svelte'),
			resolve(srcRoot, 'routes/admin/authentication-methods/[profileId]/+page.svelte')
		];

		for (const page of pages) {
			expect(readFileSync(page, 'utf8')).not.toMatch(japanesePattern);
		}
	});
});
