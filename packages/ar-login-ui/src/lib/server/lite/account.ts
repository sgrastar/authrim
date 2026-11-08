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
import { liteBackendForEvent } from './backend-for-event';
import { forwardSetCookies } from './cookies';
import { openAccountPost, read, type LiteAccountPost } from './account-post';
import {
	liteAccountSecurityActions,
	liteAccountStepUpView,
	readLiteAccountPasskeyCreate,
	readLiteAccountStepUp
} from './account-security';
import {
	liteAccountTotp,
	liteAccountTotpActions,
	liteAccountTotpEnrollStale,
	readLiteAccountTotpEnroll
} from './account-totp';
import {
	liteAccountSocial,
	liteAccountSocialActions,
	liteAccountSocialOutcome
} from './account-social';
import { liteAccountLauncherActions, liteAccountLaunchers } from './account-launcher';
import { cspHashSource } from './csp';
import { qrDataUri } from './qr';
import { LITE_PASSKEY_SCRIPT } from '#lib/lite/passkey-ceremony.js';
import {
	liteAccountActivity,
	liteAccountConsents,
	liteAccountDevices,
	liteAccountItemId,
	liteAccountPasskeys,
	liteAccountProfile,
	liteAccountSessions
} from './account-widgets';
import { newOperationNonce } from './login-actions';
import { liteMessages } from './messages';
import { record } from './totp-passkey';
import { liteTxnClient } from './txn-client';

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

/**
 * The page's query (`?…`, or empty) without a form action's key, nor a link's outcome (said once,
 * on the page the provider sent back to).
 */
function pageQuery(event: RequestEvent, set: Record<string, string> = {}): string {
	const search = new URLSearchParams(event.url.search);
	for (const key of [...search.keys()]) if (key.startsWith('/')) search.delete(key);
	search.delete('social_link');
	search.delete('reason');
	for (const [key, value] of Object.entries(set)) search.set(key, value);
	const query = search.toString();
	return query ? `?${query}` : '';
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

export async function liteAccountPage(event: RequestEvent) {
	const { LL } = await liteMessages(event.locals.locale);
	// A link started by the action: the relay page to its start (the load starts nothing else).
	if (event.locals.liteRelay) {
		return {
			page: 'relay' as const,
			title: LL.account_title(),
			relay: { method: 'get' as const, url: event.locals.liteRelay.url },
			continueLabel: event.locals.liteRelay.continueLabel
		};
	}
	const methods = await authenticationMethods(event);
	// The tenant offers no account page: home.
	if (methods?.ui.selfService?.accountPageEnabled !== true) redirect(303, '/');
	const sessionId = event.cookies.get(SESSION_COOKIE);
	if (!sessionId) toSignIn(event);
	const txns = liteTxnClient(event, { session: true });
	const backend = liteBackendForEvent(event, 'page_load');
	if (!txns || !backend) error(503, 'temporarily_unavailable');

	// The transaction first (ar-auth checks the session is live): one per browser and session,
	// whatever the page's path or query (it keeps no return target: a sign-in's is its own).
	const created = await txns.create({
		purpose: 'account',
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
		return errorPage(event, 'unavailable');
	}
	let txn = created.txn;
	// An authenticator's setup past its time: its secret removed (the page draws it no more).
	if (liteAccountTotpEnrollStale(txn.data)) {
		const cleared = await txns
			.transition(txn.id, {
				expectedVersion: txn.version,
				to: 'pending',
				patch: { accountTotpEnroll: null }
			})
			.catch(() => null);
		if (cleared?.ok) txn = cleared.txn;
	}

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
	// The consents' words in the page's language (the SPA's `getConsents(getLocale())`).
	const locale = event.locals.locale ?? 'en';
	const pageLanguage = {
		'Accept-Language': /^[A-Za-z]{2,3}([_-][A-Za-z0-9]{2,8})?$/u.test(locale)
			? locale.replace('_', '-')
			: 'en'
	};
	const [consents, sessions] = await Promise.all([
		used.has('consent_records_available')
			? read(backend, '/api/account/consents', pageLanguage)
			: null,
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

	// Each widget drawn, its data (read once, only for the widgets the page draws).
	const drawn = new Set(
		placements.flatMap((placement) =>
			placement.blocks.flatMap((block) => (block.kind === 'widget' ? [block.widget] : []))
		)
	);
	const cursor = event.url.searchParams.get('activity_cursor');
	const [
		sessionList,
		deviceList,
		consentList,
		activityList,
		passkeyList,
		totpList,
		socialList,
		launcherList
	] = await Promise.all([
		drawn.has('account_session_widget')
			? (sessions ?? read(backend, '/api/account/sessions'))
			: null,
		drawn.has('account_device_list_widget') ? read(backend, '/api/account/devices') : null,
		drawn.has('account_consent_widget')
			? (consents ?? read(backend, '/api/account/consents', pageLanguage))
			: null,
		drawn.has('account_activity_widget')
			? read(
					backend,
					`/api/account/operations?limit=20${
						cursor && /^[A-Za-z0-9_.~=-]{1,1024}$/u.test(cursor)
							? `&cursor=${encodeURIComponent(cursor)}`
							: ''
					}`
				)
			: null,
		drawn.has('account_passkey_widget') ? read(backend, '/api/account/passkeys') : null,
		drawn.has('account_totp_widget') ? read(backend, '/api/account/totp') : null,
		drawn.has('account_social_account_widget') ? read(backend, '/api/external/links') : null,
		drawn.has('account_launcher_widget') ? read(backend, '/api/account/launchers') : null
	]);
	// An authenticator being added: its secret and QR code (drawn once, by its widget).
	let enroll = drawn.has('account_totp_widget') ? readLiteAccountTotpEnroll(txn.data) : null;
	// A setup whose credential is no longer pending (activated, or removed, when the post that did
	// it could not clear it): its secret removed now, never drawn again.
	const pendingIds = new Set(
		(Array.isArray(record(totpList?.ok ? totpList.json : null).credentials)
			? (record(totpList?.ok ? totpList.json : null).credentials as unknown[])
			: []
		)
			.map(record)
			.filter((row) => row.status === 'pending')
			.map((row) => row.id)
	);
	// Drawn only when the list confirms it pending (a list not read draws none: the setup is kept).
	if (enroll && !totpList?.ok) enroll = null;
	if (enroll && totpList?.ok && !pendingIds.has(enroll.credentialId)) {
		const cleared = await txns
			.transition(txn.id, {
				expectedVersion: txn.version,
				to: 'pending',
				patch: { accountTotpEnroll: null }
			})
			.catch(() => null);
		if (cleared?.ok) txn = cleared.txn;
		enroll = null;
	}
	const widgets = {
		profile: liteAccountProfile(profile.json),
		sessions: sessionList?.ok ? liteAccountSessions(sessionList.json, LL, locale) : null,
		devices: deviceList?.ok ? liteAccountDevices(deviceList.json, locale) : null,
		consents: consentList?.ok ? liteAccountConsents(consentList.json, LL, locale) : null,
		activity: activityList?.ok ? liteAccountActivity(activityList.json, LL, locale) : null,
		// The activity's next page: the page's own query with its cursor (the language kept).
		activityNextHref: null as string | null,
		passkeys: passkeyList?.ok ? liteAccountPasskeys(passkeyList.json, LL, locale) : null,
		// A passkey being added: its ceremony.
		passkeyCreate: (() => {
			// One ceremony at a time: none while a step-up is asked for.
			const create =
				drawn.has('account_passkey_widget') && !readLiteAccountStepUp(txn.data)
					? readLiteAccountPasskeyCreate(txn.data)
					: null;
			return create ? { registration: create.registration, challenge: create.challengeId } : null;
		})(),
		totp: totpList?.ok ? liteAccountTotp(totpList.json, LL, locale) : null,
		totpEnroll: enroll
			? {
					credentialId: enroll.credentialId,
					secret: enroll.secret,
					qr: await qrDataUri(enroll.otpauthUri)
				}
			: null,
		social: socialList?.ok
			? liteAccountSocial(socialList.json, record(m.external).providers, LL, locale)
			: null,
		// A link's outcome, on the page the provider sent back to.
		socialOutcome: drawn.has('account_social_account_widget')
			? liteAccountSocialOutcome(event.url, LL)
			: null,
		launcher: launcherList?.ok ? liteAccountLaunchers(launcherList.json, event.url, locale) : null,
		// An authenticator may be added (the tenant offers them: the SPA's widget's condition).
		totpAddEnabled: conditions.totpManagementEnabled,
		activityIncomplete:
			activityList !== null && !activityList.ok && activityList.error === 'log_query_incomplete'
	};
	// A change held for a step-up: the panel that asks for it.
	const held = readLiteAccountStepUp(txn.data);
	const stepUp = held
		? await liteAccountStepUpView({ backend }, held, {
				methods: m,
				profile: widgets.profile
			})
		: null;
	// A passkey ceremony drawn (a step-up's, or one adding a passkey): its fixed script, allowed by
	// its hash.
	if (stepUp?.passkey || widgets.passkeyCreate) {
		event.locals.liteCsp = { scriptHashes: [await cspHashSource(LITE_PASSKEY_SCRIPT)] };
	}
	if (widgets.activity?.nextCursor) {
		widgets.activityNextHref = `${event.url.pathname}${pageQuery(event, {
			activity_cursor: widgets.activity.nextCursor
		})}`;
	}
	return {
		page: 'account' as const,
		txnId: txn.id,
		csrfToken: txn.csrfToken,
		op: newOperationNonce(),
		// The page's query without a form action's key (a post's page is drawn with its own URL).
		search: pageQuery(event),
		// The launcher's filters: a form the page is drawn again with, keeping the rest of its query.
		launcherAction: event.url.pathname,
		launcherKeep: [...new URLSearchParams(pageQuery(event)).entries()].filter(
			([key]) => key !== 'launcher_q' && key !== 'launcher_category' && key !== 'launcher_favorites'
		),
		guest:
			(record(record(profile.json).session).amr as unknown[] | undefined)?.includes('anon') ??
			false,
		placements,
		widgets,
		stepUp,
		text: {
			title: words.title ?? LL.account_title(),
			description: words.description,
			signOut: LL.header_logout(),
			guestSignOutWarning: LL.account_guestLogoutWarning(),
			confirmSignOut: LL.header_logout(),
			cancel: LL.dialog_cancel(),
			actionFailed: LL.account_actionFailed(),
			sessionChanged: LL.lite_reauthSessionEnded(),
			loadFailed: LL.account_loadFailed(),
			empty: LL.account_empty(),
			name: LL.account_name(),
			email: LL.account_email(),
			verified: LL.account_verified(),
			editName: LL.account_editName(),
			save: LL.account_save(),
			saved: LL.account_saved(),
			saveFailed: LL.account_saveFailed(),
			sessionsDescription: LL.account_sessionsDescription(),
			currentSession: LL.account_currentSession(),
			logoutSession: LL.account_logoutSession(),
			devicesDescription: LL.account_connectedDevicesDescription(),
			noDevices: LL.account_noConnectedDevices(),
			currentDevice: LL.account_currentDevice(),
			consentDescription: LL.account_consentDescription(),
			consentEmpty: LL.account_consentEmpty(),
			activityMore: LL.account_activityLoadMore(),
			activityIncomplete: LL.account_activityIncomplete(),
			anotherWay: LL.lite_reauthAnotherWay(),
			stepUpTitle: LL.account_reauthTitle(),
			stepUpDescription: LL.account_reauthDescription(),
			stepUpNoMethods: LL.account_reauthNoMethods(),
			stepUpPasskey: LL.account_reauthWithPasskey(),
			stepUpEmail: LL.account_reauthWithEmailCode(),
			stepUpEmailSent: LL.account_reauthEmailCodeSent({
				email: stepUp?.email?.maskedEmail ?? ''
			}),
			stepUpCode: LL.emailCode_codeLabel(),
			stepUpVerify: LL.account_reauthVerifyEmailCode(),
			stepUpTotpCode: LL.login_totpCodeLabel(),
			stepUpTotp: LL.account_reauthWithTotp(),
			stepUpFailed: LL.account_actionFailed(),
			codeInvalid: LL.emailCode_errorInvalid(),
			busy: LL.error_rateLimited(),
			passkeyName: LL.account_passkeyName(),
			addPasskey: LL.account_addPasskey(),
			deletePasskey: LL.account_delete(),
			remainingMethod: LL.account_remainingLoginMethodRequired(),
			passkeyFailed: LL.account_passkeyRegistrationFailed(),
			passkeyUnsupported: LL.lite_passkeyUnsupported(),
			passkeyCeremonyFailed: LL.lite_passkeyFailed(),
			javascriptRequired: LL.lite_javascriptRequired(),
			totpName: LL.account_totpName(),
			addTotp: LL.account_addTotp(),
			totpSetupTitle: LL.account_totpSetupTitle(),
			totpQrAlt: LL.account_totpQrAlt(),
			totpManualKey: LL.account_totpManualKey(),
			totpActivationCode: LL.account_totpActivationCode(),
			totpActivate: LL.account_totpActivate(),
			totpBackupCodes: LL.account_totpBackupCodes(),
			totpBackupCodesRemaining: totpRemaining(LL, widgets.totp),
			totpRegenerate: LL.account_totpRegenerateBackupCodes(),
			totpCurrentCode: LL.account_totpCurrentCode(),
			totpDeleteCode: LL.account_totpDeleteCode(),
			totpPending: LL.account_totpPending(),
			totpDone: LL.account_totpDone(),
			deleteTotp: LL.account_delete(),
			socialEmpty: LL.account_socialEmpty(),
			socialLinkHeading: LL.account_socialLinkHeading(),
			socialNoProviders: LL.account_socialNoProviders(),
			socialUnlink: LL.account_socialUnlink(),
			socialUnlinked: LL.account_socialUnlinked(),
			socialAlreadyLinkedHere: LL.account_socialErrorAlreadyLinkedHere(),
			socialLastMethod: LL.account_socialErrorLastMethod(),
			socialInProgress: LL.account_socialErrorInProgress(),
			socialFailed: LL.account_socialErrorFailed(),
			launcherDescription: LL.account_launcherDescription(),
			launcherEmpty: LL.account_launcherEmpty(),
			launcherSearch: LL.account_launcherSearch(),
			launcherAllCategories: LL.account_launcherAllCategories(),
			launcherFavorites: LL.account_launcherFavorites(),
			launcherNoMatches: LL.account_launcherNoMatches(),
			launcherFavorite: LL.account_launcherFavoriteAdd(),
			launcherUnfavorite: LL.account_launcherFavoriteRemove(),
			launcherFavoriteFailed: LL.account_launcherFavoriteUpdateFailed()
		}
	};
}

function totpRemaining(
	LL: Awaited<ReturnType<typeof liteMessages>>['LL'],
	totp: { backupCodes: { total: number; remaining: number } } | null
): string {
	return totp ? LL.account_totpBackupCodesRemaining(totp.backupCodes) : '';
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
	// The transaction is given up first, while its session still is (after the sign-out ar-auth
	// would no longer act on it): it no longer counts as one of the browser's live ones. A page
	// drawn again makes another.
	return endSession(event, post);
}

/** Signs the session out (the transaction given up first), then home. */
async function endSession(event: RequestEvent, post: LiteAccountPost) {
	const ended = await post.txns
		.transition(post.txn.id, { expectedVersion: post.txn.version, to: 'abandoned' })
		.catch(() => null);
	if (!ended?.ok) return fail(409, { error: 'retry' as const });
	const answer = await post.backend
		.request('/api/v1/auth/direct/logout', { json: {} })
		.catch(() => null);
	if (!answer || answer.status >= 400) return fail(503, { error: 'action_failed' as const });
	forwardSetCookies(event, post.backend.setCookies());
	redirect(303, '/');
}

/** `profile_save`: the name (as the SPA's form, at most 100 characters). */
export async function liteAccountProfileSaveAction(event: RequestEvent) {
	const opened = await openAccountPost(event);
	if ('failure' in opened) return opened.failure;
	const { post } = opened;
	const name = (post.fields.get('name') ?? '').trim();
	if (name.length > 100) return fail(400, { error: 'save_failed' as const, widget: 'profile' });
	const answer = await post.backend
		.request('/api/account/profile', { method: 'PATCH', json: { name } })
		.catch(() => null);
	if (!answer || answer.status !== 200) {
		return fail(answer?.status === 400 ? 400 : 503, {
			error: 'save_failed' as const,
			widget: 'profile'
		});
	}
	return { notice: 'saved' as const, widget: 'profile' };
}

/** `session_revoke`: a session signed out; this one, the browser signed out too (home). */
export async function liteAccountSessionRevokeAction(event: RequestEvent) {
	const opened = await openAccountPost(event);
	if ('failure' in opened) return opened.failure;
	const { post } = opened;
	const id = liteAccountItemId(post.fields.get('session'));
	if (!id) return fail(400, { error: 'action_failed' as const, widget: 'sessions' });
	// This browser's own session: the transaction given up first (while the session still is),
	// then revoked as any (its record kept; its answer clears the session's cookies), then signed
	// out (as the SPA does), home.
	const own = id === post.txn.bound.sessionId;
	if (own) {
		const ended = await post.txns
			.transition(post.txn.id, { expectedVersion: post.txn.version, to: 'abandoned' })
			.catch(() => null);
		if (!ended?.ok) return fail(409, { error: 'retry' as const });
	}
	const answer = await post.backend
		.request(`/api/account/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' })
		.catch(() => null);
	if (!answer || answer.status !== 200) {
		return fail(answer && answer.status < 500 ? answer.status : 503, {
			error: 'action_failed' as const,
			widget: 'sessions'
		});
	}
	if (own) {
		await post.backend.request('/api/v1/auth/direct/logout', { json: {} }).catch(() => null);
		forwardSetCookies(event, post.backend.setCookies());
		redirect(303, '/');
	}
	return { notice: 'revoked' as const, widget: 'sessions' };
}

export const liteAccountActions = {
	...liteAccountSecurityActions,
	...liteAccountTotpActions,
	...liteAccountSocialActions,
	...liteAccountLauncherActions,
	sign_out: liteAccountSignOutAction,
	profile_save: liteAccountProfileSaveAction,
	session_revoke: liteAccountSessionRevokeAction
};
