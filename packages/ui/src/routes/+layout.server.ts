import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ cookies }) => {
	// Get language preference from cookie
	const preferredLanguage = cookies.get('preferredLanguage') || 'en';

	return {
		preferredLanguage
	};
};
