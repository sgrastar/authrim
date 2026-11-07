import type { Locales, TranslationFunctions } from '$i18n/i18n-types';
import { i18nObject, isLocale } from '$i18n/i18n-util';
import { loadLocaleAsync } from '$i18n/i18n-util.async';

/**
 * The lite Login UI's strings for one locale, loaded on demand: only the locale a page is
 * rendered in is loaded (never all of them), and only the strings a page renders reach the HTML.
 *
 * The translations are returned inside an object: `i18nObject` is a Proxy that answers every
 * name, `then` included, so returned bare from an async function it would be taken for a
 * promise and never settle.
 */
export async function liteMessages(
	locale: string | undefined
): Promise<{ LL: TranslationFunctions }> {
	const chosen: Locales = locale && isLocale(locale) ? locale : 'en';
	await loadLocaleAsync(chosen);
	return { LL: i18nObject(chosen) };
}
