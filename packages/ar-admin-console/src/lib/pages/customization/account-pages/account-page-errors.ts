/** What to tell the admin when an account page change is refused. */
import { ApiError } from '#lib/api/api-error.js';
import type { MessageKey } from '#lib/i18n/i18n.svelte.js';
import type { PublishProblem } from './account-page-model';

export function pagesErrorKey(failure: unknown): MessageKey {
	if (failure instanceof ApiError) {
		// Someone else saved first (the settings version moved on).
		if (failure.status === 409) return 'ap.err.conflict';
		if (failure.status === 403) return 'ap.err.forbidden';
	}
	return 'ap.err.generic';
}

/** The message key and values for a page that cannot be published, and why. */
export function publishProblemMessage(problem: PublishProblem): {
	key: MessageKey;
	values?: Record<string, string>;
} {
	switch (problem.code) {
		case 'duplicate_place':
			return { key: 'ap.err.duplicatePlace' };
		case 'duplicate_screen':
			return { key: 'ap.err.duplicateScreen' };
		case 'screen_missing':
			return { key: 'ap.err.screenMissing', values: { key: problem.screenKey } };
		case 'multiple_widgets':
			return { key: 'ap.err.multipleWidgets', values: { name: problem.name } };
		case 'link_target':
			return { key: 'ap.err.linkTarget', values: { target: problem.target } };
	}
}
