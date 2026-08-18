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

function maskNonMarkup(content: string): string {
	const ranges = [
		...content.matchAll(/<script\b[\s\S]*?<\/script\b[^>]*>/gi),
		...content.matchAll(/<style\b[\s\S]*?<\/style\b[^>]*>/gi),
		...content.matchAll(/<!--[\s\S]*?-->/g)
	]
		.map((match) => ({ start: match.index, end: match.index + match[0].length }))
		.sort((left, right) => left.start - right.start);

	let cursor = 0;
	let markup = '';

	for (const range of ranges) {
		if (range.start < cursor) continue;
		markup += content.slice(cursor, range.start);
		markup += ' ';
		cursor = range.end;
	}

	return markup + content.slice(cursor);
}

function staticJapaneseMarkup(content: string): string[] {
	const markup = maskNonMarkup(content);
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
	it('ignores Japanese text in script, style, and comment regions without joining boundaries', () => {
		expect(
			staticJapaneseMarkup(
				'<script>const label = "日本語";</script><p>English</p><!-- 日本語 --><style>.日本語 {}</style>'
			)
		).toEqual([]);
		expect(staticJapaneseMarkup('<script>const label = "日本語";</script><p>保存</p>')).toEqual([
			'保存'
		]);
	});

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
