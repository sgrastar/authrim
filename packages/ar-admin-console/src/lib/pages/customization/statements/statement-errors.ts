import { ApiError } from '#lib/api/api-error.js';
import type { MessageKey } from '#lib/i18n/i18n.svelte.js';

export type StatementErrorContext = 'load' | 'create' | 'save' | 'version' | 'publish' | 'delete';

const FALLBACK: Record<StatementErrorContext, MessageKey> = {
	load: 'cs.error.load',
	create: 'cs.error.create',
	save: 'cs.error.save',
	version: 'cs.error.version',
	publish: 'cs.error.publish',
	delete: 'cs.error.delete'
};

/** What a failed call says to the admin. */
export function statementErrorKey(error: unknown, context: StatementErrorContext): MessageKey {
	if (error instanceof ApiError) {
		if (error.status === 403) return 'cs.error.forbidden';
		if (error.status === 404) return 'cs.error.notFound';
		if (error.status === 409) {
			if (error.code === 'document_changed') return 'cs.error.changedWhilePublishing';
			if (context === 'create') return 'cs.error.slugTaken';
			if (context === 'version') return 'cs.error.versionTaken';
			if (context === 'delete') return 'cs.error.retired';
			return 'cs.error.immutable';
		}
		if (error.status === 400 && context === 'publish') {
			if (/older than/iu.test(error.message)) return 'cs.error.olderVersion';
			if (/localization/iu.test(error.message)) return 'cs.error.noText';
		}
	}
	return FALLBACK[context];
}

/** The API's own words for a refused value, to show after our sentence. */
export const apiDetail = (error: unknown): string =>
	error instanceof ApiError && error.status === 400 && error.message ? ` ${error.message}` : '';
