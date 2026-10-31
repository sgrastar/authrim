import { i18n } from '$lib/i18n/i18n.svelte';
import type { Locale } from '$lib/i18n/locales';

let override: ((locale: Locale) => void) | null = null;

/**
 * Lets a page that has no server behind it (the dev-only mock) switch the language in the browser
 * only. Returns the function that puts the normal behaviour back.
 */
export function overrideLanguageChange(handler: (locale: Locale) => void): () => void {
	override = handler;
	return () => {
		if (override === handler) override = null;
	};
}

/**
 * Switches the language now and stores it in a cookie so the server renders the next page with
 * the right lang/dir. The cookie is set server-side (Safari ITP does not cap it).
 */
export async function changeLanguage(locale: Locale): Promise<void> {
	if (override) {
		override(locale);
		return;
	}
	const previous = i18n.locale;
	i18n.set(locale);
	try {
		const response = await fetch('/api/set-language', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ language: locale })
		});
		if (!response.ok) throw new Error('set-language failed');
	} catch {
		i18n.set(previous);
	}
}
