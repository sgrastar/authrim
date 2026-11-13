import type { PageServerLoad } from './$types';
import { isLocale } from '$i18n/i18n-util';
import { fetchPublicApiForPageRequest } from '../../../../hooks.server';
import { liteMessages } from '#lib/server/lite/messages.js';
import { liteStatementPage } from '#lib/server/lite/statement-page.js';

/**
 * A statement's text alone, for the frame on the consent step (the same for the normal and the
 * lite Login UI): drawn on the server, without scripts, and framed only by this origin
 * (hooks.server.ts, `isStatementEmbedPath`).
 */
export const csr = false;

export const load: PageServerLoad = async (event) => {
	// The language the consent step showed (`lang`), else the reader's.
	const asked = event.url.searchParams.get('lang');
	const locale = asked && isLocale(asked) ? asked : (event.locals.locale ?? 'en');
	const { LL } = await liteMessages(locale);
	const statement = await liteStatementPage(
		(path) => fetchPublicApiForPageRequest(event, path),
		event.params.slug,
		event.url.searchParams.get('version'),
		locale,
		LL
	);
	return { statement };
};
