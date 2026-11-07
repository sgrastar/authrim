import { ApiError } from '#lib/api/api-error.js';
import type { MessageKey } from '#lib/i18n/i18n.svelte.js';

/** What a failed screen call says to the admin; `fallback` for anything else. */
export function screenErrorKey(error: unknown, fallback: MessageKey): MessageKey {
	if (!(error instanceof ApiError)) return fallback;
	// A 409 keeps the API's own code in its body (`error`).
	switch (typeof error.body.error === 'string' ? error.body.error : error.code) {
		case 'screen_in_use':
			return 'sc.error.inUse';
		case 'screen_usage_unknown':
			return 'sc.error.usageUnknown';
		case 'screen_key_taken':
			return 'sc.error.keyTaken';
	}
	if (error.status === 409 || error.status === 412 || error.status === 428) {
		return 'sc.error.conflict';
	}
	return fallback;
}
