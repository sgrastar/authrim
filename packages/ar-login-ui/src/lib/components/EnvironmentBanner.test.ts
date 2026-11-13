import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import EnvironmentBanner from './EnvironmentBanner.svelte';

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

describe('EnvironmentBanner', () => {
	it('draws the text as a plain note, escaped', () => {
		const { body } = render(EnvironmentBanner, {
			props: { text: 'Staging <b>environment</b>' }
		});
		expect(body).toContain('class="environment-banner"');
		expect(body).toContain('role="note"');
		expect(body).toContain('Staging &lt;b>environment&lt;/b>');
		expect(body).not.toContain('<b>');
		// No inline style: the lite CSP forbids it, and the look is a constant rule.
		expect(body).not.toContain('style=');
	});

	it('picks the text of the server language, else the general text', () => {
		const props = { text: 'Staging', textLocalizations: { ja: 'ステージング環境です。' } };
		expect(render(EnvironmentBanner, { props: { ...props, locale: 'ja' } }).body).toContain(
			'ステージング環境です。'
		);
		expect(render(EnvironmentBanner, { props: { ...props, locale: 'en' } }).body).toContain(
			'Staging'
		);
		// Only a Japanese text: nothing to show in English.
		expect(
			render(EnvironmentBanner, {
				props: { text: '', textLocalizations: { ja: 'ステージング環境です。' }, locale: 'en' }
			}).body
		).not.toContain('environment-banner');
	});

	it('draws nothing without text', () => {
		expect(render(EnvironmentBanner, { props: { text: '' } }).body).not.toContain(
			'environment-banner'
		);
	});

	it('is styled by constant rules in both stylesheets, with no start-edge stripe', () => {
		for (const css of [read('../../app.css'), read('../lite/lite.css')]) {
			const rule = css.match(/\n\.environment-banner \{[^}]*\}/)?.[0] ?? '';
			expect(rule).toContain('border-block-end: 1px solid');
			expect(rule).toContain('padding-inline');
			expect(rule).not.toMatch(/border-(inline-start|left)/);
			expect(rule).not.toMatch(/position:\s*(fixed|absolute|sticky)/);
			expect(rule).not.toContain('z-index');
		}
	});

	it('has no component style (the lite CSP allows only its hashed stylesheet)', () => {
		expect(read('./EnvironmentBanner.svelte')).not.toContain('<style');
		expect(read('../../routes/+layout.svelte')).not.toContain('<style');
	});
});
