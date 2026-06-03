import type { LayoutServerLoad } from './$types';
import { resolveLocale } from '$i18n/locales';

export const load: LayoutServerLoad = async ({ cookies }) => {
	// Get language preference from cookie
	const preferredLanguage = resolveLocale(cookies.get('preferredLanguage'));

	return {
		preferredLanguage
	};
};
