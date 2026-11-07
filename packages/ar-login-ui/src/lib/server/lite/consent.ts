/**
 * The lite consent page's data and decision (plan §8, PR5c): the same ar-auth API the SPA's
 * `/consent` uses (`GET /auth/consent?challenge_id=`, `POST /auth/consent`), driven from the
 * server.
 *
 * The page draws what the consent answer gives (checked here, never echoed raw). A decision is
 * built from the consent answer read again when the form is posted: only the person's choices
 * (an optional item, the organization) come from the form, each checked against that answer.
 * ar-auth's answer is a destination (the `/authorize` continuation, the client's redirect), or a
 * form post as data (a denial with `response_mode=form_post`, asked for by `X-Authrim-Relay`):
 * the page relays the browser there.
 */
import type { LiteBackendClient } from './backend-client';

/**
 * The most items (and organizations) the page draws: a decision's form must stay within the lite
 * form reader's fields (32), with its hidden fields and the organization.
 */
const MAX_ITEMS = 25;
/** The most scopes drawn (a request asking for more is not drawn). */
const MAX_SCOPES = 100;
const MAX_TEXT = 4000;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown, max = MAX_TEXT): string | null {
	return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;
}

/** A text the page must draw in full when it is given: `undefined` when it is too long to. */
function shownText(value: unknown, max = MAX_TEXT): string | null | undefined {
	if (typeof value !== 'string' || value.length === 0) return null;
	return value.length <= max ? value : undefined;
}

/** An https link for a document or a client's page; anything else is not drawn. */
export function liteConsentLink(value: unknown): string | null {
	const raw = text(value, 2048);
	if (!raw) return null;
	try {
		const url = new URL(raw);
		return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : null;
	} catch {
		return null;
	}
}

export interface LiteConsentItem {
	statementId: string;
	title: string;
	description: string | null;
	processingPurpose: string | null;
	withdrawalImpact: string | null;
	documentUrl: string | null;
	versionId: string;
	contentHash: string | null;
	isRequired: boolean;
	/** A required item the person must accept to allow (`enforcement: block`). */
	blocks: boolean;
	/** `none`: no checkbox (always granted); otherwise the person chooses. */
	checkboxMode: 'none' | 'required' | 'optional';
	defaultChecked: boolean;
}

export interface LiteConsentView {
	challengeId: string;
	clientName: string;
	clientTrusted: boolean;
	clientUri: string | null;
	policyUri: string | null;
	tosUri: string | null;
	scopes: string[];
	userEmail: string;
	userName: string | null;
	/** The organizations the person may choose from (only with the selector on). */
	organizations: Array<{ id: string; name: string }>;
	defaultOrgId: string | null;
	actingAs: { id: string; name: string } | null;
	/** The organization an Allow is for, when there is one (drawn whether or not it can be chosen). */
	targetOrg: { id: string; name: string } | null;
	itemsEnabled: boolean;
	items: LiteConsentItem[];
}

/** The consent answer, checked; null when it is not one the page can draw. */
export function readLiteConsent(json: unknown): LiteConsentView | null {
	if (!isRecord(json) || !isRecord(json.client) || !isRecord(json.user)) return null;
	const challengeId = text(json.challenge_id, 512);
	const clientName = text(json.client.client_name, 200) ?? text(json.client.client_id, 200);
	const userEmail = text(json.user.email, 320);
	if (!challengeId || !clientName || !userEmail || !Array.isArray(json.scopes)) return null;
	// Every scope the request asks for is drawn (Allow grants them all): an answer with one the page
	// cannot draw is not drawn at all.
	if (json.scopes.length > MAX_SCOPES) return null;
	const scopes: string[] = [];
	for (const scope of json.scopes) {
		const name = isRecord(scope) ? text(scope.name, 256) : null;
		if (!name) return null;
		scopes.push(name);
	}
	const features = isRecord(json.features) ? json.features : {};
	// The organizations to choose from are drawn in full (one left out could be the one an Allow is
	// for, the browser then choosing another), or the consent is not drawn.
	const organizations: Array<{ id: string; name: string }> = [];
	if (features.org_selector_enabled === true && Array.isArray(json.organizations)) {
		if (json.organizations.length > MAX_ITEMS) return null;
		for (const org of json.organizations) {
			const id = isRecord(org) ? text(org.id, 200) : null;
			const name = isRecord(org) ? text(org.name, 200) : null;
			if (!id || !name) return null;
			organizations.push({ id, name });
		}
	}
	const primary = isRecord(json.primary_org) ? text(json.primary_org.id, 200) : null;
	const actingAs =
		isRecord(json.acting_as) && text(json.acting_as.id, 200)
			? {
					id: String(json.acting_as.id),
					name: text(json.acting_as.name, 200) ?? text(json.acting_as.email, 320) ?? ''
				}
			: null;
	const items: LiteConsentItem[] = [];
	for (const raw of Array.isArray(json.consent_items) ? json.consent_items : []) {
		if (!isRecord(raw)) continue;
		const statementId = text(raw.statement_id, 200);
		const versionId = text(raw.version_id, 200);
		const title = text(raw.title, 500);
		if (!statementId || !versionId || !title) return null;
		const mode = raw.checkbox_mode;
		// What the person accepts is drawn in full, or the consent is not drawn at all.
		const description = shownText(raw.description);
		const processingPurpose = shownText(raw.processing_purpose);
		const withdrawalImpact = shownText(raw.withdrawal_impact);
		if (description === undefined || processingPurpose === undefined) return null;
		if (withdrawalImpact === undefined) return null;
		// A document the item names is linked, or the consent is not drawn (one that cannot be
		// opened here is not accepted unread).
		const documentUrl = liteConsentLink(raw.document_url);
		if (!documentUrl && typeof raw.document_url === 'string' && raw.document_url.length > 0) {
			return null;
		}
		items.push({
			statementId,
			title,
			description,
			processingPurpose,
			withdrawalImpact,
			documentUrl,
			versionId,
			contentHash: text(raw.content_hash, 200),
			isRequired: raw.is_required === true,
			blocks: raw.is_required === true && raw.enforcement === 'block',
			checkboxMode: mode === 'none' || mode === 'required' ? mode : 'optional',
			defaultChecked: raw.checkbox_default_checked === true
		});
		if (items.length > MAX_ITEMS) return null;
	}
	const defaultOrgId = text(json.target_org_id, 200) ?? primary;
	// With a choice, the organization an Allow is for by default is one of the choices.
	if (
		organizations.length > 1 &&
		defaultOrgId &&
		!organizations.some((o) => o.id === defaultOrgId)
	) {
		return null;
	}
	const named = (id: string | null) => {
		if (!id) return null;
		for (const org of [
			...(Array.isArray(json.organizations) ? json.organizations : []),
			json.primary_org
		]) {
			if (isRecord(org) && org.id === id && text(org.name, 200)) {
				return { id, name: String(org.name) };
			}
		}
		return { id, name: id };
	};
	return {
		challengeId,
		clientName,
		clientTrusted: json.client.is_trusted === true,
		clientUri: liteConsentLink(json.client.client_uri),
		policyUri: liteConsentLink(json.client.policy_uri),
		tosUri: liteConsentLink(json.client.tos_uri),
		scopes,
		userEmail,
		userName: text(json.user.name, 200),
		organizations,
		defaultOrgId,
		targetOrg: named(defaultOrgId),
		actingAs,
		itemsEnabled: json.consent_management_enabled === true,
		items
	};
}

/** The consent answer for the challenge; `expired` when ar-auth no longer knows it. */
export async function fetchLiteConsent(
	backend: LiteBackendClient,
	challengeId: string
): Promise<{ ok: true; view: LiteConsentView } | { ok: false; reason: 'expired' | 'unavailable' }> {
	const answer = await backend
		.request(`/auth/consent?challenge_id=${encodeURIComponent(challengeId)}`)
		.catch(() => null);
	if (!answer) return { ok: false, reason: 'unavailable' };
	if (answer.status === 400 || answer.status === 404) return { ok: false, reason: 'expired' };
	const view = answer.status === 200 ? readLiteConsent(answer.json) : null;
	return view && view.challengeId === challengeId
		? { ok: true, view }
		: { ok: false, reason: 'unavailable' };
}

/**
 * What the page showed, kept in the transaction when it is drawn (`data.consent`): a decision is
 * made from it, never from the consent answer read again (a document updated after the page was
 * drawn is not accepted in its place: ar-auth sees the shown version and answers that it changed),
 * nor from the form beyond the person's choices.
 */
export interface LiteConsentShown {
	/** The form (its nonce) it was drawn with: only that form decides from it. */
	op: string;
	challengeId: string;
	itemsEnabled: boolean;
	/** [statement ID, version ID, content hash, checkbox mode, blocks]. */
	items: Array<[string, string, string | null, 'none' | 'required' | 'optional', boolean]>;
	orgs: string[];
	defaultOrgId: string | null;
	actingAsId: string | null;
}

export function liteConsentShown(view: LiteConsentView, op: string): LiteConsentShown {
	return {
		op,
		challengeId: view.challengeId,
		itemsEnabled: view.itemsEnabled,
		items: view.items.map((item) => [
			item.statementId,
			item.versionId,
			item.contentHash,
			item.checkboxMode,
			item.blocks
		]),
		orgs: view.organizations.map((org) => org.id),
		defaultOrgId: view.defaultOrgId,
		actingAsId: view.actingAs?.id ?? null
	};
}

/** The shown consent the transaction keeps for the challenge; null when it keeps none for it. */
export function readLiteConsentShown(
	data: Record<string, unknown>,
	challengeId: string,
	op: string
): LiteConsentShown | null {
	const shown = data.consent;
	if (!isRecord(shown) || shown.challengeId !== challengeId || shown.op !== op) return null;
	if (!Array.isArray(shown.items) || !Array.isArray(shown.orgs)) return null;
	const items: LiteConsentShown['items'] = [];
	for (const raw of shown.items as unknown[]) {
		if (
			!Array.isArray(raw) ||
			raw.length !== 5 ||
			typeof raw[0] !== 'string' ||
			typeof raw[1] !== 'string' ||
			(raw[2] !== null && typeof raw[2] !== 'string') ||
			(raw[3] !== 'none' && raw[3] !== 'required' && raw[3] !== 'optional') ||
			typeof raw[4] !== 'boolean'
		) {
			return null;
		}
		items.push([raw[0], raw[1], raw[2] as string | null, raw[3], raw[4]]);
	}
	return {
		op,
		challengeId,
		itemsEnabled: shown.itemsEnabled === true,
		items,
		orgs: (shown.orgs as unknown[]).filter((org): org is string => typeof org === 'string'),
		defaultOrgId: typeof shown.defaultOrgId === 'string' ? shown.defaultOrgId : null,
		actingAsId: typeof shown.actingAsId === 'string' ? shown.actingAsId : null
	};
}

/**
 * The submission an Allow makes (the SPA's `handleAllow`) from what the page showed, or `blocked`
 * when a required item the person must accept is not accepted.
 */
export function liteConsentAllow(
	shown: LiteConsentShown,
	fields: ReadonlyMap<string, string>
): { ok: true; body: Record<string, unknown> } | { ok: false; reason: 'blocked' } {
	const decisions = Object.fromEntries(
		shown.items.map(([id, , , mode]) => [
			id,
			mode === 'none' || fields.get(`item:${id}`) === 'granted' ? 'granted' : 'denied'
		])
	);
	if (
		shown.itemsEnabled &&
		shown.items.some(([id, , , , blocks]) => blocks && decisions[id] !== 'granted')
	) {
		return { ok: false, reason: 'blocked' };
	}
	const chosenOrg = fields.get('org');
	const selectedOrg = chosenOrg && shown.orgs.includes(chosenOrg) ? chosenOrg : shown.defaultOrgId;
	return {
		ok: true,
		body: {
			challenge_id: shown.challengeId,
			approved: true,
			...(selectedOrg ? { selected_org_id: selectedOrg } : {}),
			...(shown.actingAsId ? { acting_as_user_id: shown.actingAsId } : {}),
			consent_item_versions: Object.fromEntries(
				shown.items.map(([id, versionId, hash]) => [
					id,
					{ version_id: versionId, content_hash: hash }
				])
			),
			...(shown.itemsEnabled && shown.items.length > 0 ? { consent_item_decisions: decisions } : {})
		}
	};
}

/** Where a decision goes next, as ar-auth answered it. */
export type LiteConsentOutcome =
	| { kind: 'redirect'; url: string }
	| { kind: 'form_post'; action: string; fields: Array<[string, string]> }
	/** The documents changed: the page is drawn again (for a new challenge, when there is one). */
	| { kind: 'changed'; challengeId: string | null }
	| { kind: 'expired' }
	| { kind: 'failed'; status: number };

function absoluteHttpUrl(value: unknown): string | null {
	const raw = text(value, 8192);
	if (!raw) return null;
	try {
		const url = new URL(raw);
		return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password
			? url.toString()
			: null;
	} catch {
		return null;
	}
}

/** Sends the decision; the outcome the page relays or draws. */
export async function submitLiteConsent(
	backend: LiteBackendClient,
	body: Record<string, unknown>,
	publicOrigin: string
): Promise<LiteConsentOutcome> {
	const answer = await backend
		.request('/auth/consent', {
			method: 'POST',
			json: body,
			headers: { 'X-Authrim-Relay': 'structured' }
		})
		.catch(() => null);
	if (!answer) return { kind: 'failed', status: 503 };
	const json = isRecord(answer.json) ? answer.json : {};
	if (answer.status === 200) {
		if (typeof json.redirect_url === 'string') {
			// A relative continuation (the issuer's own /authorize) is resolved on the public origin.
			let url: string | null = null;
			try {
				url = absoluteHttpUrl(new URL(json.redirect_url, publicOrigin).toString());
			} catch {
				url = null;
			}
			return url ? { kind: 'redirect', url } : { kind: 'failed', status: 502 };
		}
		if (isRecord(json.form_post)) {
			const action = absoluteHttpUrl(json.form_post.action);
			const fields = Array.isArray(json.form_post.fields)
				? json.form_post.fields.filter(
						(field): field is [string, string] =>
							Array.isArray(field) &&
							field.length === 2 &&
							typeof field[0] === 'string' &&
							typeof field[1] === 'string'
					)
				: [];
			return action && fields.length > 0 && fields.length <= 20
				? { kind: 'form_post', action, fields }
				: { kind: 'failed', status: 502 };
		}
		return { kind: 'failed', status: 502 };
	}
	if (json.error === 'document_changed') {
		const details = isRecord(json.error_details) ? json.error_details : {};
		const replacement = text(details.consent_challenge_id, 512);
		if (replacement) return { kind: 'changed', challengeId: replacement };
		if (details.refresh_consent === true) return { kind: 'changed', challengeId: null };
		return { kind: 'expired' };
	}
	if (answer.status === 400 || answer.status === 404) return { kind: 'expired' };
	return { kind: 'failed', status: answer.status };
}
