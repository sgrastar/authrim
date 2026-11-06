import { ApiError } from '#lib/api/api-error.js';
import type { MessageKey } from '#lib/i18n/i18n.svelte.js';

/** What a failed theme call says to the admin; `fallback` for anything else. */
export function themeErrorKey(error: unknown, fallback: MessageKey): MessageKey {
	if (!(error instanceof ApiError)) return fallback;
	switch (error.code) {
		case 'theme_active':
			return 'th.error.active';
		case 'theme_name_taken':
			return 'th.error.nameTaken';
		case 'theme_limit_reached':
			return 'th.error.limit';
		case 'ADMIN_CONFLICT':
			return 'th.error.conflict';
	}
	if (error.status === 409 || error.status === 412) return 'th.error.conflict';
	if (error.status === 404) return 'th.page.notFound';
	return fallback;
}
