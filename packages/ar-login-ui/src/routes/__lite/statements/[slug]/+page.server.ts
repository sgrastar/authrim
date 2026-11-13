import type { PageServerLoad } from './$types';
import { isLocale } from '$i18n/i18n-util';
import { fetchPublicApiForPageRequest } from '../../../../hooks.server';
import { liteMessages } from '#lib/server/lite/messages.js';
import { liteStatementPage } from '#lib/server/lite/statement-page.js';

/** The lite public statement page: one consent statement's text (lib/server/lite/statement-page). */
export const load: PageServerLoad = async (event) => {
	// The language the consent step showed (`lang`), else the reader's.
	const asked = event.url.searchParams.get('lang');
	const locale = asked && isLocale(asked) ? asked : (event.locals.locale ?? 'en');
	const { LL } = await liteMessages(locale);
	// The tenant may come from the shared Login UI's cookie: never kept by a cache.
	event.setHeaders({ 'Cache-Control': 'private, no-store' });
	const statement = await liteStatementPage(
		(path) => fetchPublicApiForPageRequest(event, path),
		event.params.slug,
		event.url.searchParams.get('version'),
		locale,
		LL
	);
	return { statement };
};
