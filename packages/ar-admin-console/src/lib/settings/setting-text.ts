/**
 * The console's words for a setting of the Settings API. The API's own label and description
 * are English and written from the implementation ("Default session lifetime in
 * milliseconds"); the console words them for admins, in every language, under
 * `set.k.<key>` (label), `set.k.<key>.desc` (optional) and `set.k.<key>.<choice>`.
 */
import { hasMessage, type MessageKey } from '$lib/i18n/i18n.svelte';

export function settingText(key: string) {
	const base = `set.k.${key}`;
	const description = `${base}.desc`;
	return {
		label: base as MessageKey,
		description: hasMessage(description) ? (description as MessageKey) : undefined,
		choice: (choice: string) => `${base}.${choice}` as MessageKey
	};
}
