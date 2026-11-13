/**
 * The lite account page's consent withdrawal (the SPA's AccountConsentWidget): a service (OIDC), a
 * SAML service provider or a consent statement, asked first (the page drawn again with the
 * question) and then withdrawn with the browser's own session, as the SPA does.
 */
import { fail, type RequestEvent } from '@sveltejs/kit';
import { openAccountPost } from './account-post';
import { record } from './totp-passkey';

const KINDS = ['oauth_client', 'saml_sp', 'statement'] as const;
type Kind = (typeof KINDS)[number];

/** The API's path for a consent (the identifier is the client ID, entity ID or statement ID). */
function withdrawPath(kind: Kind, target: string): string {
	switch (kind) {
		case 'oauth_client':
			return `/api/account/consents/oauth-client?client_id=${encodeURIComponent(target)}`;
		case 'saml_sp':
			return `/api/account/consents/saml-sp?sp_entity_id=${encodeURIComponent(target)}`;
		case 'statement':
			return `/api/account/consents/statements/${encodeURIComponent(target)}`;
	}
}

/** `consent_withdraw`: asked first, then the consent withdrawn (a 404 is "already gone"). */
export async function liteAccountConsentWithdrawAction(event: RequestEvent) {
	const opened = await openAccountPost(event);
	if ('failure' in opened) return opened.failure;
	const { post } = opened;
	const kind = KINDS.find((candidate) => candidate === post.fields.get('kind'));
	const target = post.fields.get('target') ?? '';
	if (!kind || target.length === 0 || target.length > 2048) {
		return fail(400, { error: 'failed', widget: 'consent' });
	}
	if (post.fields.get('confirm') !== '1') {
		return { confirmWithdraw: `${kind}:${target}`, widget: 'consent' };
	}
	const answer = await post.backend
		.request(withdrawPath(kind, target), { method: 'DELETE' })
		.catch(() => null);
	if (answer?.status === 200) return { notice: 'consent_withdrawn' as const, widget: 'consent' };
	// Gone already (another tab, or the service): the list drawn again says so.
	if (answer?.status === 404) return { notice: 'consent_gone' as const, widget: 'consent' };
	const error = record(answer?.json).error;
	return fail(answer && answer.status < 500 ? (answer.status === 429 ? 429 : 400) : 503, {
		error: typeof error === 'string' && /^[a-z_]{1,64}$/u.test(error) ? error : 'failed',
		widget: 'consent'
	});
}

export const liteAccountConsentActions = {
	consent_withdraw: liteAccountConsentWithdrawAction
};
