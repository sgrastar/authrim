import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import { locales } from '$i18n/i18n-util';
import { toDocumentDirection, toDocumentLanguage } from '#lib/i18n/locales.js';
import { liteMessages } from '#lib/server/lite/messages.js';
import { liteTransformPageChunk } from '#lib/server/lite/document.js';
import ErrorPage from '../../../routes/__lite/error/+page.svelte';

/**
 * The lite Login UI's budget: a page is at most 30 KB gzip (Cloudflare compresses responses; the
 * HTML is the whole page) and loads nothing else. Checked for every Login UI language, through the
 * same app.html and transform a request gets.
 */
const BUDGET_GZIP_BYTES = 30 * 1024;
const APP_HTML = readFileSync(resolve(__dirname, '../../../app.html'), 'utf8');

/**
 * A logo at the largest size the lite logo check accepts: 8 KB of image as base64. Random bytes,
 * because a real image barely compresses and the budget must hold for it.
 */
const LARGEST_LOGO = `data:image/png;base64,${btoa(
	String.fromCharCode(...crypto.getRandomValues(new Uint8Array(8 * 1024)))
)}`;

async function documentFor(
	locale: (typeof locales)[number],
	logo: string | null = null
): Promise<string> {
	const { LL } = await liteMessages(locale);
	const { head, body } = render(ErrorPage, {
		props: {
			data: {
				brandName: 'Example Organisation',
				logo,
				errorText: { title: '', message: '', back: '' },
				title: LL.error_title(),
				message: LL.error_temporarily_unavailable(),
				codeLabel: LL.error_errorCode(),
				code: 'temporarily_unavailable',
				back: LL.common_backToLogin()
			}
		} as never
	});
	const html = APP_HTML.replace('%sveltekit.head%', head).replace('%sveltekit.body%', body);
	return liteTransformPageChunk(html, {
		language: toDocumentLanguage(locale),
		direction: toDocumentDirection(locale)
	});
}

describe('lite page budget', { timeout: 60_000 }, () => {
	it.each(locales)('keeps the error page within budget, self-contained (%s)', async (locale) => {
		const document = await documentFor(locale);
		expect(gzipSync(document).byteLength).toBeLessThanOrEqual(BUDGET_GZIP_BYTES);
		// Nothing loaded from anywhere: no scripts, stylesheets, images or fonts by URL.
		expect(document).not.toMatch(/<script\b[^>]*\bsrc=/iu);
		expect(document).not.toMatch(/<link\b[^>]*rel="(?:stylesheet|modulepreload|preload)"/iu);
		expect(document).not.toMatch(/<img\b[^>]*src="(?!data:)/iu);
		expect(document).not.toMatch(/url\(/iu);
		expect(document).not.toContain('style="');
	});

	it.each(locales)('stays within budget with the largest logo (%s)', async (locale) => {
		const document = await documentFor(locale, LARGEST_LOGO);
		expect(document).toContain('<img src="data:image/png;base64,');
		expect(gzipSync(document).byteLength).toBeLessThanOrEqual(BUDGET_GZIP_BYTES);
	});

	it('renders right to left for Arabic', async () => {
		expect(await documentFor('ar')).toContain('dir="rtl"');
	});
});
