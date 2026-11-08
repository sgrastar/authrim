/**
 * The lite account page's linked external accounts (lite plan PR7b; the SPA's
 * AccountSocialAccountsWidget): the accounts linked, linking another (the browser leaves for the
 * provider and comes back to the page with `?social_link=`), and unlinking one (asked first).
 *
 * ar-bridge serves the links and reads the browser's own session from its cookie for each: its
 * start of a link takes only a one-use intent made for that session and user, and the callback
 * attaches the account only while the session stands for the same user. Nothing here names the
 * session or the user to it.
 */
import { fail, type RequestEvent } from '@sveltejs/kit';
import { openAccountPost, type LiteAccountPost } from './account-post';
import { holdForStepUp, registerPendingAction, stepUpAsked } from './account-security';
import { liteAccountItemId } from './account-widgets';
import { formatTimestamp } from '#lib/utils/date.js';
import { liteMessages } from './messages';
import { record } from './totp-passkey';

type LL = Awaited<ReturnType<typeof liteMessages>>['LL'];

function text(value: unknown, max = 8192): string | null {
	return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;
}

/** A provider's ID as the authentication-methods API names it (its slug, else its ID). */
const PROVIDER_ID = /^[A-Za-z0-9_.:-]{1,128}$/u;

export interface LiteAccountSocialView {
	identities: Array<{
		id: string;
		name: string;
		email: string | null;
		meta: string;
		/** The question asked before it is unlinked, and its button. */
		confirm: string;
		confirmAction: string;
	}>;
	/** The providers that may be linked still (OAuth / OIDC, on for sign-in, not linked). */
	linkable: Array<{ id: string; label: string }>;
}

/** The accounts linked and the providers linkable, as the SPA's widget lists them. */
export function liteAccountSocial(
	json: Record<string, unknown>,
	providers: unknown,
	LL: LL,
	locale: string
): LiteAccountSocialView {
	const rows = Array.isArray(json.identities) ? json.identities : [];
	const linkedProviders = new Set<string>();
	const identities = rows.flatMap((raw) => {
		const row = record(raw);
		const id = liteAccountItemId(row.id);
		const providerKey = text(row.providerSlug) ?? text(row.providerId);
		if (providerKey) linkedProviders.add(providerKey);
		if (!id) return [];
		const linkedAt = typeof row.linkedAt === 'number' ? row.linkedAt : null;
		const lastLoginAt = typeof row.lastLoginAt === 'number' ? row.lastLoginAt : null;
		const name = text(row.providerName) ?? '-';
		return [
			{
				id,
				name,
				confirm: LL.account_socialUnlinkConfirm({ provider: name }),
				confirmAction: LL.account_socialUnlinkConfirmAction({ provider: name }),
				email: text(row.providerEmail),
				meta: [
					LL.account_socialLinkedAt({ date: formatTimestamp(linkedAt, locale) }),
					...(lastLoginAt
						? [LL.account_socialLastUsed({ date: formatTimestamp(lastLoginAt, locale) })]
						: [])
				].join(' / ')
			}
		];
	});
	const linkable = (Array.isArray(providers) ? providers : []).flatMap((raw) => {
		const provider = record(raw);
		const id =
			typeof provider.id === 'string' && PROVIDER_ID.test(provider.id) ? provider.id : null;
		if (
			!id ||
			provider.startMode !== 'oauth_redirect' ||
			provider.enabled === false ||
			provider.loginEnabled === false ||
			linkedProviders.has(id)
		) {
			return [];
		}
		return [{ id, label: LL.account_socialLinkWith({ provider: text(provider.name, 200) ?? id }) }];
	});
	return { identities, linkable };
}

/** The outcome of a link the provider sent back (`?social_link=`), as the SPA says it. */
export function liteAccountSocialOutcome(
	url: URL,
	LL: LL
): { kind: 'success' | 'error'; message: string } | null {
	const outcome = url.searchParams.get('social_link');
	if (!outcome) return null;
	if (outcome === 'linked') return { kind: 'success', message: LL.account_socialLinked() };
	return { kind: 'error', message: socialMessage(url.searchParams.get('reason'), LL) };
}

/** The page's message for a link's outcome or a refused unlink (the SPA's socialErrorMessage). */
export function socialMessage(code: string | null | undefined, LL: LL): string {
	switch (code) {
		case 'already_linked':
			return LL.account_socialErrorAlreadyLinked();
		case 'email_not_verified':
			return LL.account_socialErrorEmailNotVerified();
		case 'session_expired':
			return LL.account_socialErrorSessionExpired();
		case 'cancelled':
			return LL.account_socialErrorCancelled();
		case 'remaining_login_method_required':
			return LL.account_socialErrorLastMethod();
		case 'operation_in_progress':
			return LL.account_socialErrorInProgress();
		default:
			return LL.account_socialErrorFailed();
	}
}

/**
 * ar-bridge's start of a link, only as such: `/auth/external/<provider>/start` carrying its intent
 * (and the tenant's hint) and nothing else, drawn on the tenant's public origin (the page's: where
 * the browser's session is, and where a lite sign-in with a provider starts too). ar-bridge names
 * it on its issuer's host, which a tenant's own domain is not.
 */
export function liteLinkStartUrl(value: unknown, publicOrigin: string): string | null {
	if (typeof value !== 'string' || value.length > 2048) return null;
	let url: URL;
	let origin: URL;
	try {
		url = new URL(value);
		origin = new URL(publicOrigin);
	} catch {
		return null;
	}
	const keys = [...url.searchParams.keys()];
	if (
		(url.protocol !== 'https:' && url.protocol !== 'http:') ||
		url.username ||
		url.password ||
		url.hash ||
		!/^\/auth\/external\/[A-Za-z0-9_.:%-]{1,256}\/start$/u.test(url.pathname) ||
		keys.length < 1 ||
		new Set(keys).size !== keys.length ||
		!keys.every((key) => key === 'link_intent' || key === 'tenant_hint') ||
		!/^[A-Za-z0-9_-]{43}$/u.test(url.searchParams.get('link_intent') ?? '')
	) {
		return null;
	}
	return new URL(`${url.pathname}${url.search}`, origin.origin).toString();
}

function failed(answer: { status: number; json: unknown } | null) {
	const error = record(answer?.json).error;
	return fail(answer && answer.status < 500 ? (answer.status === 429 ? 429 : 400) : 503, {
		error: typeof error === 'string' && /^[a-z_]{1,64}$/u.test(error) ? error : 'failed',
		widget: 'social'
	});
}

/**
 * `social_link`: the browser sent to the provider, to come back to the page linked. It leaves by
 * the relay page (a 303 after a form post would run into the page's `form-action` once the start
 * goes on to the provider: relay.ts), which the account page's load draws.
 */
async function startLink(event: RequestEvent, post: LiteAccountPost, args: Record<string, string>) {
	const provider = args.provider ?? '';
	if (!PROVIDER_ID.test(provider)) return fail(400, { error: 'failed', widget: 'social' });
	const answer = await post.backend
		.request('/api/external/links', { json: { provider_id: provider } })
		.catch(() => null);
	if (stepUpAsked(answer))
		return holdForStepUp(post, { action: 'social_link', args: { provider } });
	if (answer?.status === 409 && record(answer.json).error === 'already_linked') {
		return fail(409, { error: 'already_linked_here' as const, widget: 'social' });
	}
	const target =
		answer?.status === 200
			? liteLinkStartUrl(record(answer.json).authorization_url, post.txn.bound.publicOrigin)
			: null;
	if (!target) return failed(answer?.status === 200 ? null : answer);
	const { LL } = await liteMessages(event.locals.locale);
	event.locals.liteRelay = { url: target, continueLabel: LL.common_continue() };
	return { started: true as const, widget: 'social' };
}

/** `social_unlink`: an account unlinked, once the person confirmed it (asked first, as the SPA). */
async function unlink(_event: RequestEvent, post: LiteAccountPost, args: Record<string, string>) {
	const id = liteAccountItemId(args.id);
	if (!id) return fail(400, { error: 'failed', widget: 'social' });
	const answer = await post.backend
		.request(`/api/external/links/${encodeURIComponent(id)}`, { method: 'DELETE' })
		.catch(() => null);
	if (stepUpAsked(answer)) return holdForStepUp(post, { action: 'social_unlink', args: { id } });
	if (answer?.status !== 200) return failed(answer);
	return { notice: 'social_unlinked' as const, widget: 'social' };
}

registerPendingAction('social_link', startLink);
registerPendingAction('social_unlink', unlink);

export async function liteAccountSocialLinkAction(event: RequestEvent) {
	const opened = await openAccountPost(event);
	if ('failure' in opened) return opened.failure;
	return startLink(event, opened.post, { provider: opened.post.fields.get('provider') ?? '' });
}

export async function liteAccountSocialUnlinkAction(event: RequestEvent) {
	const opened = await openAccountPost(event);
	if ('failure' in opened) return opened.failure;
	const id = liteAccountItemId(opened.post.fields.get('identity'));
	if (!id) return fail(400, { error: 'failed', widget: 'social' });
	// Asked first: the page drawn again with the confirmation for this account.
	if (opened.post.fields.get('confirm') !== '1') {
		return { confirmUnlink: id, widget: 'social' };
	}
	return unlink(event, opened.post, { id });
}

export const liteAccountSocialActions = {
	social_link: liteAccountSocialLinkAction,
	social_unlink: liteAccountSocialUnlinkAction
};
