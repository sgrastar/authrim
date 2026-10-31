import type { LayoutServerLoad } from './$types';
import { LOCALE_COOKIE, resolveLocale } from '$lib/i18n/locales';

export const load: LayoutServerLoad = async ({ cookies }) => {
	return { locale: resolveLocale(cookies.get(LOCALE_COOKIE)) };
};
