/**
 * The lite account page (lite plan PR7b): `/account` (and `/account/<path>`, the same page) for
 * the signed-in person, drawn on the server from the tenant's account page (`GET
 * /api/account/capabilities`, composed as the SPA composes it: account-page.ts) with each
 * widget's data read here, and its actions as form posts.
 *
 * Its transaction is bound by ar-auth to the browser's live session and its user (an account page
 * acts for them only): every call passes the session, and a post from a page of another session
 * (a sign-in as someone else in another tab) is refused. ar-management resolves the account from
 * the session at each call, so nothing here names a user.
 */
import { error, fail, redirect, type RequestEvent } from '@sveltejs/kit';
import { getCachedAuthenticationMethodsForRequest } from '../../../hooks.server';
import { getPlatformEnv } from '#lib/server/platform-env.js';
import {
	LITE_ACCOUNT_WIDGETS,
	liteAccountConditionsUsed,
	liteAccountHref,
	liteAccountPageWords,
	liteAccountPlacementVisible,
	liteAccountScreenFields,
	liteAccountWidgetTitle,
	liteLocaleVariants,
	readLiteAccountPage,
	type LiteAccountConditions,
	type LiteAccountField,
	type LiteAccountWidget
} from './account-page';
import type { LiteBackendClient } from './backend-client';
import { liteBackendForEvent } from './backend-for-event';
import { forwardSetCookies } from './cookies';
import { readLiteForm } from './form';
import { newOperationNonce, sameToken } from './login-actions';
import { liteMessages } from './messages';
import { record } from './totp-passkey';
import { liteTxnClient, type LiteTxnView } from './txn-client';

const SESSION_COOKIE = 'authrim_session';

async function sha256Hex(value: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The page's own path and query (where a sign-in returns to): `/account` or under it. */
function accountReturn(event: RequestEvent): string {
	const path = event.url.pathname.startsWith('/account') ? event.url.pathname : '/account';
	const search = new URLSearchParams(event.url.search);
	// Never a form action's key (a post's page drawn again is the page).
	for (const key of [...search.keys()]) if (key.startsWith('/')) search.delete(key);
	const query = search.toString();
	return `${path}${query ? `?${query}` : ''}`;
}

/** To the sign-in page, back here once signed in (the transaction keeps the return target). */
function toSignIn(event: RequestEvent): never {
	redirect(303, `/login?return_to=${encodeURIComponent(accountReturn(event))}`);
}

async function authenticationMethods(event: RequestEvent) {
	return (
		event.locals.authenticationMethods ??
		(await getCachedAuthenticationMethodsForRequest(event, getPlatformEnv(event)).catch(() => null))
	);
}

async function errorPage(event: RequestEvent, kind: 'busy' | 'unavailable') {
	const { LL } = await liteMessages(event.locals.locale);
	return {
		page: 'error' as const,
		title: LL.error_title(),
		message: kind === 'busy' ? LL.error_rateLimited() : LL.account_loadFailed(),
		back: LL.account_title(),
		backHref: accountReturn(event)
	};
}

/** A block as the page draws it. */
type LiteAccountBlock =
	| { kind: 'heading'; label: string; text: string | null; column: 1 | 2 | null }
	| { kind: 'text'; text: string; column: 1 | 2 | null }
	| { kind: 'link'; label: string; href: string; column: 1 | 2 | null }
	| { kind: 'divider'; text: string | null; column: 1 | 2 | null }
	| { kind: 'widget'; widget: LiteAccountWidget; title: string; column: 1 | 2 | null };

/** The default title of each widget (the SPA's `accountWidgetTitle`). */
function widgetDefaults(LL: Awaited<ReturnType<typeof liteMessages>>['LL']) {
	return {
		account_upgrade_widget: LL.account_guestTitle(),
		account_profile_widget: LL.account_profileTitle(),
		account_device_list_widget: LL.account_devices(),
		account_session_widget: LL.account_sessions(),
		account_passkey_widget: LL.account_passkeys(),
		account_totp_widget: LL.account_totp(),
		account_consent_widget: LL.account_consentTitle(),
		account_activity_widget: LL.account_activityTitle(),
		account_social_account_widget: LL.account_socialAccounts(),
		account_launcher_widget: LL.account_launcherTitle()
	} satisfies Record<LiteAccountWidget, string>;
}

/** GET of an account API (its JSON, or null with the status for a failure). */
async function read(
	backend: LiteBackendClient,
	path: string
): Promise<{ ok: true; json: Record<string, unknown> } | { ok: false; status: number }> {
	const answer = await backend.request(path).catch(() => null);
	if (!answer) return { ok: false, status: 503 };
	return answer.status === 200
		? { ok: true, json: record(answer.json) }
		: { ok: false, status: answer.status };
}

export async function liteAccountPage(event: RequestEvent) {
	const { LL } = await liteMessages(event.locals.locale);
	const methods = await authenticationMethods(event);
	// The tenant offers no account page: home.
	if (methods?.ui.selfService?.accountPageEnabled !== true) redirect(303, '/');
	const sessionId = event.cookies.get(SESSION_COOKIE);
	if (!sessionId) toSignIn(event);
	const txns = liteTxnClient(event, { session: true });
	const backend = liteBackendForEvent(event, 'page_load');
	if (!txns || !backend) error(503, 'temporarily_unavailable');

	// The transaction first (ar-auth checks the session is live): one per browser and session.
	const created = await txns.create({
		purpose: 'account',
		returnTo: accountReturn(event),
		reuseKey: await sha256Hex(JSON.stringify(['account']))
	});
	if (!created.ok) {
		const canonical = (created as { canonicalOrigin?: unknown }).canonicalOrigin;
		if (created.reason === 'origin_not_canonical' && typeof canonical === 'string') {
			const origin = new URL(canonical).origin;
			redirect(303, new URL(`${event.url.pathname}${event.url.search}`, origin).toString(), {
				external: [origin]
			});
		}
		if (created.reason === 'session_invalid') toSignIn(event);
		if (created.reason === 'budget_exceeded') return errorPage(event, 'busy');
		if (created.reason === 'invalid_return_to') toSignIn(event);
		return errorPage(event, 'unavailable');
	}
	const txn = created.txn;

	const [capabilities, profile] = await Promise.all([
		read(backend, '/api/account/capabilities'),
		read(backend, '/api/account/profile')
	]);
	if (
		(!capabilities.ok && capabilities.status === 401) ||
		(!profile.ok && profile.status === 401)
	) {
		toSignIn(event);
	}
	if (!capabilities.ok || !profile.ok) return errorPage(event, 'unavailable');
	const page = readLiteAccountPage(capabilities.json);
	if (!page) return errorPage(event, 'unavailable');

	// The lists the placements' conditions read (only those they need).
	const used = liteAccountConditionsUsed(page);
	const [consents, sessions] = await Promise.all([
		used.has('consent_records_available') ? read(backend, '/api/account/consents') : null,
		used.has('multiple_sessions') ? read(backend, '/api/account/sessions') : null
	]);
	const listLength = (answer: typeof consents, key: string) =>
		answer?.ok && Array.isArray(answer.json[key]) ? (answer.json[key] as unknown[]).length : 0;
	const registration = record(record(profile.json).profile).registration_state;
	const m = record(methods?.methods);
	const totp = record(m.totp);
	const conditions: LiteAccountConditions = {
		registrationState:
			registration === 'guest' || registration === 'registered' ? registration : null,
		passkeyEnabled: record(m.passkey).enabled === true,
		totpManagementEnabled:
			Object.keys(totp).length > 0 &&
			(((totp.loginEnabled ?? totp.enabled) as boolean | undefined) === true ||
				totp.accountLinkEnabled === true),
		externalIdpEnabled: record(m.external).enabled === true,
		consentRecordsAvailable: listLength(consents, 'consents') > 0,
		multipleSessions: listLength(sessions, 'sessions') > 1
	};

	const locale = event.locals.locale ?? 'en';
	const defaultLocale =
		typeof methods?.ui.defaultLocale === 'string' ? methods.ui.defaultLocale : 'en';
	const shown = page.placements.filter((placement) =>
		liteAccountPlacementVisible(placement, conditions)
	);
	const shownIds = new Set(shown.map((placement) => placement.id));
	const defaults = widgetDefaults(LL);
	const blocks = (fields: LiteAccountField[]): LiteAccountBlock[] =>
		fields.flatMap((field): LiteAccountBlock[] => {
			const column = field.layoutColumn;
			switch (field.blockType) {
				case 'heading':
					return [{ kind: 'heading', label: field.label, text: field.text, column }];
				case 'text': {
					const words = field.text || field.label;
					return words ? [{ kind: 'text', text: words, column }] : [];
				}
				case 'link': {
					const href = liteAccountHref(field.href, (id) => shownIds.has(id));
					return href && field.label ? [{ kind: 'link', label: field.label, href, column }] : [];
				}
				case 'divider':
					return [{ kind: 'divider', text: field.text, column }];
				default:
					if (!LITE_ACCOUNT_WIDGETS.has(field.blockType)) return [];
					return [
						{
							kind: 'widget',
							widget: field.blockType as LiteAccountWidget,
							title: liteAccountWidgetTitle(field, defaults[field.blockType as LiteAccountWidget]),
							column
						}
					];
			}
		});
	const placements = shown.flatMap((placement) => {
		const screen = page.screens.find((candidate) => candidate.screenKey === placement.screenKey);
		if (!screen) return [];
		return [
			{
				id: placement.id,
				width: placement.width,
				overview: placement.screenKey === 'account_overview',
				blocks: blocks(liteAccountScreenFields(screen, locale, defaultLocale))
			}
		];
	});
	// The theme's title for the page (its text in the page's locale, else the default's).
	const themeTexts = record(record(methods?.ui.appearance).textLocalizations);
	const themeTitle =
		[...new Set([...liteLocaleVariants(locale), ...liteLocaleVariants(defaultLocale)])]
			.map((candidate) => record(themeTexts[candidate]).accountTitle)
			.find((value): value is string => typeof value === 'string' && value.trim().length > 0) ??
		null;
	const words = liteAccountPageWords(page, locale, defaultLocale, themeTitle);
	return {
		page: 'account' as const,
		txnId: txn.id,
		csrfToken: txn.csrfToken,
		op: newOperationNonce(),
		search: event.url.search,
		guest:
			(record(record(profile.json).session).amr as unknown[] | undefined)?.includes('anon') ??
			false,
		placements,
		text: {
			title: words.title ?? LL.account_title(),
			description: words.description,
			signOut: LL.header_logout(),
			guestSignOutWarning: LL.account_guestLogoutWarning(),
			confirmSignOut: LL.header_logout(),
			cancel: LL.dialog_cancel(),
			actionFailed: LL.account_actionFailed(),
			sessionChanged: LL.lite_reauthSessionEnded()
		}
	};
}

/** A post of the page: its transaction (form token, current policy), the browser's session. */
export async function openAccountPost(event: RequestEvent): Promise<
	| {
			post: {
				txns: NonNullable<ReturnType<typeof liteTxnClient>>;
				backend: LiteBackendClient;
				txn: LiteTxnView;
				fields: ReadonlyMap<string, string>;
			};
	  }
	| { failure: ReturnType<typeof fail> }
> {
	const refused = { failure: fail(403, { restart: true }) };
	const txns = liteTxnClient(event, { session: true });
	const backend = liteBackendForEvent(event, 'form_post');
	const form = await readLiteForm(event.request);
	if (!txns || !backend || !form.ok) return refused;
	const txnId = form.fields.get('txn');
	const token = form.fields.get('csrf');
	if (!txnId || !token) return refused;
	// Read only while the browser's session is the one it was made for, live, and its user's
	// (ar-auth checks): another tab's sign-in as someone else is not acted on from this page.
	const got = await txns.get(txnId, { current: true });
	if (!got.ok && got.reason === 'session_invalid') {
		return { failure: fail(409, { error: 'session_changed' as const }) };
	}
	if (!got.ok || !sameToken(got.txn.csrfToken, token)) return refused;
	if (got.txn.bound.purpose !== 'account') return refused;
	if (got.txn.state === 'completed' || got.txn.state === 'abandoned') return refused;
	return { post: { txns, backend, txn: got.txn, fields: form.fields } };
}

/** `sign_out`: the session ended (a guest is asked first: its account cannot be come back to). */
export async function liteAccountSignOutAction(event: RequestEvent) {
	const opened = await openAccountPost(event);
	if ('failure' in opened) return opened.failure;
	const { post } = opened;
	if (post.fields.get('confirm') !== 'guest') {
		// Whether the person is a guest is known first (the SPA stops when it cannot tell): a guest
		// is never signed out unasked.
		const profile = await read(post.backend, '/api/account/profile');
		const amr = profile.ok ? record(profile.json.session).amr : undefined;
		if (!Array.isArray(amr)) return fail(503, { error: 'action_failed' as const });
		if (amr.includes('anon')) return fail(409, { confirmGuestSignOut: true as const });
	}
	const answer = await post.backend
		.request('/api/v1/auth/direct/logout', { json: {} })
		.catch(() => null);
	if (!answer || answer.status >= 400) return fail(503, { error: 'action_failed' as const });
	await post.txns
		.transition(post.txn.id, { expectedVersion: post.txn.version, to: 'completed' })
		.catch(() => null);
	forwardSetCookies(event, post.backend.setCookies());
	redirect(303, '/');
}

export const liteAccountActions = {
	sign_out: liteAccountSignOutAction
};
