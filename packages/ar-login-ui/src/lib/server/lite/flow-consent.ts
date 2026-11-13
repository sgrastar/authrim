/**
 * A Flow step's consent on the lite sign-in page (plan §8, PR5d): the step's consent policy
 * (`content.consent_policy`, drawn where its screen has a `consent_widget`) and the destination's
 * field consent (`content.destination_field_consent`), as the SPA draws and submits them
 * (RuntimeScreen's consent widget, login +page.svelte `getRuntimeConsentItemDecisionPayload`).
 *
 * - What is drawn is checked here: every item and field is drawn in full (its words through the
 *   SPA's own consent HTML sanitizer), or the step is not drawn at all.
 * - A decision is built from the step the post is on (the Flow resumed by the post), the form giving
 *   only the person's choices: a checkbox granted, a radio option offered, a field agreed to.
 * - Nothing is started (a sign-in, the step's Continue) until the required items and fields are
 *   accepted, as the SPA disables its buttons until then. The decision goes with the step's own
 *   submit, which a sign-in may make in a later post: it is kept in the transaction for the step
 *   (`data.flowConsent`).
 */
import type { FlowRuntimeStep } from '#lib/api/flow-runtime.js';
import { sanitizeRuntimeConsentHtml } from '#lib/consent/runtime-consent-html.js';
import { statementPresentation } from '#lib/consent/statement-display.js';
import {
	consentStepKey,
	type ConsentPresentationDestination,
	type ConsentPresentationItem
} from '@authrim/ar-lib-core/utils/consent-presentation-key';

/**
 * The most items and fields together: they are posted with the sign-in form, which the lite form
 * reader takes up to 32 fields of (its hidden fields, the address, the proof among them).
 */
const MAX_PARTS = 20;
const MAX_OPTIONS = 10;
const MAX_TEXT = 8000;
/** The most steps whose decisions the transaction keeps (a choice step and a code step, say). */
const MAX_KEPT_STEPS = 4;
/**
 * The most a step's decision may take as kept, in UTF-8 bytes (at its largest: every radio item on
 * its option of the most bytes, its ids at their longest): a step whose decision could be larger is
 * not drawn. The transaction keeps
 * decisions up to `MAX_KEPT_BYTES` in all (the newest first), within its 8 KB of data.
 */
const MAX_STEP_INPUT_BYTES = 1536;
const MAX_KEPT_BYTES = 3072;

const utf8Bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function key(value: unknown): string | null {
	return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/u.test(value) ? value : null;
}

/** A text drawn in full when given; `undefined` when it is too long to. */
function words(value: unknown): string | null | undefined {
	if (typeof value !== 'string' || value.length === 0) return null;
	return value.length <= MAX_TEXT ? value : undefined;
}

/** An https link a document is opened at; null when there is none, undefined when unusable. */
function documentLink(value: unknown): string | null | undefined {
	if (value === null || value === undefined || value === '') return null;
	if (typeof value !== 'string' || value.length > 2048) return undefined;
	try {
		const url = new URL(value);
		return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : undefined;
	} catch {
		return undefined;
	}
}

export interface LiteFlowConsentItem {
	id: string;
	/** The item's title, as text (the name of a radio item's choices). */
	title: string;
	/** The item's description, through the SPA's consent HTML sanitizer (null when none). */
	descriptionHtml: string | null;
	/**
	 * How the statement's text is shown (as the SPA's StatementConsentItem): its statement page
	 * `embedded` in a frame (`frame`), a link to its `external` document (`link`), or `plain`.
	 */
	display: 'embedded' | 'inline' | 'external' | 'plain';
	/** The text itself, sanitized, for a statement whose key cannot be a page path (`inline`). */
	html: string | null;
	/** The statement page's text alone, framed in the screen. */
	frame: string | null;
	/** The statement page, or the external document, opened in a new tab. */
	link: string | null;
	documentUrl: string | null;
	required: boolean;
	kind: 'display' | 'checkbox' | 'radio';
	defaultChecked: boolean;
	/** A shown item's decision (the SPA's: granted only without a checkbox, or checked by default). */
	shownGranted: boolean;
	options: Array<{ value: string; html: string }>;
}

export interface LiteFlowConsentField {
	key: string;
	label: string;
	required: boolean;
}

export interface LiteFlowConsent {
	/**
	 * What was shown, as one key (the step and the Flow runtime's own presentation key): a decision
	 * is taken only for the key its form was drawn with, and kept only for it (both by its digest,
	 * `liteConsentDigest`, which a form field and the transaction hold within their limits).
	 */
	key: string;
	title: string | null;
	items: LiteFlowConsentItem[];
	fields: LiteFlowConsentField[];
}

/**
 * The step's consent as the page draws it: null when the step has none; `unsupported` when it has
 * one the page cannot draw in full.
 */
export function readLiteFlowConsent(
	step: FlowRuntimeStep | null
): LiteFlowConsent | null | 'unsupported' {
	const content = isRecord(step?.content) ? step.content : {};
	const policy = isRecord(content.consent_policy) ? content.consent_policy : null;
	const destination = isRecord(content.destination_field_consent)
		? content.destination_field_consent
		: null;
	const rawItems = policy && Array.isArray(policy.items) ? policy.items : [];
	// The language the step is drawn in: its statements' frames and pages show their text in it.
	const language = typeof policy?.language === 'string' ? policy.language : null;
	const rawFields = destination && Array.isArray(destination.fields) ? destination.fields : [];
	if (!policy && !destination) return null;
	if (policy && !Array.isArray(policy.items)) return 'unsupported';
	if (destination && !Array.isArray(destination.fields)) return 'unsupported';
	if (rawItems.length + rawFields.length > MAX_PARTS) return 'unsupported';
	const items: LiteFlowConsentItem[] = [];
	for (const raw of rawItems) {
		if (!isRecord(raw)) return 'unsupported';
		const id = key(raw.statement_id);
		const title = words(raw.title);
		const description = words(raw.description);
		const inline = words(raw.inline_content);
		const documentUrl = documentLink(raw.document_url);
		if (!id || !title || description === undefined || inline === undefined) return 'unsupported';
		if (documentUrl === undefined) return 'unsupported';
		// As the SPA's StatementConsentItem shows it.
		const presentation = statementPresentation(
			{
				slug: typeof raw.slug === 'string' ? raw.slug : '',
				title,
				version: typeof raw.version === 'string' ? raw.version : '',
				document_url: documentUrl,
				inline_content: inline
			},
			language
		);
		const display = presentation.kind;
		const frame = presentation.kind === 'embedded' ? presentation.src : null;
		const link =
			presentation.kind === 'external'
				? presentation.href
				: presentation.kind === 'embedded'
					? presentation.pageHref
					: null;
		const html =
			presentation.kind === 'inline' ? sanitizeRuntimeConsentHtml(presentation.content) : null;
		const mode = raw.content_mode;
		const options: LiteFlowConsentItem['options'] = [];
		if (mode === 'radio') {
			if (!Array.isArray(raw.options) || raw.options.length === 0) return 'unsupported';
			if (raw.options.length > MAX_OPTIONS) return 'unsupported';
			for (const option of raw.options) {
				if (!isRecord(option) || typeof option.value !== 'string' || !option.value) {
					return 'unsupported';
				}
				if (option.value.length > 256) return 'unsupported';
				// Words too long to draw are never left out for shorter ones (the SPA draws them).
				const description = words(option.description);
				const label = words(option.label);
				if (description === undefined || label === undefined) return 'unsupported';
				const body = description ?? label ?? option.value;
				options.push({ value: option.value, html: sanitizeRuntimeConsentHtml(body) });
			}
		}
		const kind =
			mode === 'radio'
				? 'radio'
				: mode === 'display_only' || raw.checkbox_mode === 'none'
					? 'display'
					: 'checkbox';
		const defaultChecked = raw.checkbox_default_checked === true;
		items.push({
			id,
			title,
			descriptionHtml: description ? sanitizeRuntimeConsentHtml(description) : null,
			display,
			html,
			frame,
			link,
			documentUrl,
			// Held to `is_required` only, as the SPA (`canSubmitRuntimeConsent`) and the Flow runtime
			// (`consentItemInputSatisfied`) are: a checkbox in a required mode is not required by it.
			required: raw.is_required === true,
			kind,
			defaultChecked,
			shownGranted: raw.checkbox_mode === 'none' || defaultChecked,
			options
		});
	}
	const fields: LiteFlowConsentField[] = [];
	for (const raw of rawFields) {
		if (!isRecord(raw)) return 'unsupported';
		const fieldKey = key(raw.key);
		const label = words(raw.label);
		if (!fieldKey || !label) return 'unsupported';
		fields.push({ key: fieldKey, label, required: raw.required === true });
	}
	const title = policy ? words(policy.display_name) : null;
	if (title === undefined) return 'unsupported';
	// What was shown, all of it: the Flow runtime's key of the terms (statements, versions, terms of
	// agreeing), and what the page draws and decides from (words, choices, defaults).
	const terms = consentStepKey(
		policy ? { items: rawItems as ConsentPresentationItem[] } : null,
		destination
			? ({
					profile_id: typeof destination.profile_id === 'string' ? destination.profile_id : null,
					profile_version_id: String(destination.profile_version_id ?? ''),
					consent_version:
						typeof destination.consent_version === 'string' ? destination.consent_version : null,
					fields: rawFields as ConsentPresentationDestination['fields']
				} satisfies ConsentPresentationDestination)
			: null
	);
	// The screen's consent parts as configured (their heading and words), with the screen's words
	// in every language (what the page localizes them with).
	const widgets = [step?.config?.screen, step?.content?.screen].map((screen) =>
		isRecord(screen)
			? [
					Array.isArray(screen.fields)
						? screen.fields.filter(
								(field) => isRecord(field) && field.block_type === 'consent_widget'
							)
						: [],
					screen.localizations ?? null
				]
			: null
	);
	const consent: LiteFlowConsent = {
		key: JSON.stringify([step?.id ?? null, terms, title, items, fields, widgets]),
		title,
		items,
		fields
	};
	// The decision as kept, at its largest (its ids at their longest): within the step's bytes.
	const largest = {
		interactionId: 'i'.repeat(128),
		steps: {
			[step?.id ?? '']: { digest: 'd'.repeat(43), input: largestInput(consent) }
		}
	};
	if (utf8Bytes(largest) > MAX_STEP_INPUT_BYTES) return 'unsupported';
	return consent;
}

/** The step's decision at its largest (every radio item on its option of the most bytes). */
function largestInput(consent: LiteFlowConsent): Record<string, unknown> {
	const longest = (item: LiteFlowConsentItem) =>
		item.options.reduce(
			(value, option) => (utf8Bytes(option.value) > utf8Bytes(value) ? option.value : value),
			''
		);
	return {
		consent_item_decisions: Object.fromEntries(consent.items.map((item) => [item.id, 'selected'])),
		consent_item_selected_values: Object.fromEntries(
			consent.items.filter((item) => item.kind === 'radio').map((item) => [item.id, longest(item)])
		),
		destination_field_decisions: Object.fromEntries(
			consent.fields.map((field) => [field.key, false])
		)
	};
}

/**
 * The digest of what was shown to an interaction (SHA-256 of the interaction and `key`, base64url):
 * what the form and the txn hold. A form drawn for another interaction (an older tab's, before the
 * transaction started afresh) is never taken for this one.
 */
export async function liteConsentDigest(
	consent: LiteFlowConsent,
	interactionId: string
): Promise<string> {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(JSON.stringify([interactionId, consent.key]))
	);
	let binary = '';
	for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

/** How many fields the consent adds to its form (its key among them; none without parts). */
export function liteFlowConsentFormFields(consent: LiteFlowConsent | null): number {
	if (!consent) return 0;
	const parts =
		consent.items.filter((item) => item.kind !== 'display').length + consent.fields.length;
	return consent.items.length + consent.fields.length > 0 ? parts + 1 : 0;
}

/** A consent with nothing to choose (no items, no fields): its decision is the same however drawn. */
export function liteFlowConsentHasParts(consent: LiteFlowConsent | null): boolean {
	return Boolean(consent && consent.items.length + consent.fields.length > 0);
}

/**
 * The step's consent input from the form (the SPA's decision payload): `changed` when the form was
 * drawn with other terms than the step has now, `required` when an item or a field the person must
 * accept is not accepted. Null when the step has no consent.
 */
export function liteFlowConsentInput(
	consent: LiteFlowConsent | null,
	fields: ReadonlyMap<string, string>,
	digest: string
): { input: Record<string, unknown> } | { required: true } | { changed: true } | null {
	if (!consent) return null;
	if (liteFlowConsentHasParts(consent) && fields.get('consent-key') !== digest) {
		return { changed: true };
	}
	const decisions: Record<string, 'granted' | 'denied' | 'selected'> = {};
	const selected: Record<string, string> = {};
	for (const item of consent.items) {
		if (item.kind === 'radio') {
			const value = fields.get(`consent-value:${item.id}`);
			const offered = value && item.options.some((option) => option.value === value);
			decisions[item.id] = offered ? 'selected' : 'denied';
			selected[item.id] = offered ? value : '';
			if (item.required && !offered) return { required: true };
		} else if (item.kind === 'display') {
			decisions[item.id] = item.shownGranted ? 'granted' : 'denied';
			if (item.required && !item.shownGranted) return { required: true };
		} else {
			const granted = fields.get(`consent:${item.id}`) === 'granted';
			decisions[item.id] = granted ? 'granted' : 'denied';
			if (item.required && !granted) return { required: true };
		}
	}
	const destination: Record<string, boolean> = {};
	for (const field of consent.fields) {
		const agreed = fields.get(`consent-field:${field.key}`) === 'granted';
		destination[field.key] = agreed;
		if (field.required && !agreed) return { required: true };
	}
	return {
		input: {
			consent_item_decisions: decisions,
			consent_item_selected_values: selected,
			destination_field_decisions: destination
		}
	};
}

/**
 * The consent input a step's submit carries, as the transaction keeps it: only for the terms it
 * was accepted for (their digest); null when none.
 */
export function readKeptFlowConsent(
	data: Record<string, unknown>,
	interactionId: string,
	stepId: string,
	digest: string
): Record<string, unknown> | null {
	const kept = data.flowConsent;
	if (!isRecord(kept) || kept.interactionId !== interactionId || !isRecord(kept.steps)) return null;
	const entry = kept.steps[stepId];
	if (!isRecord(entry) || entry.digest !== digest) return null;
	return isRecord(entry.input) ? entry.input : null;
}

/**
 * Choices a post made without accepting them (a code sent again from the entry drawing the terms),
 * kept for the page to draw them again for the same terms: never a decision.
 */
export function liteConsentDraft(
	interactionId: string,
	stepId: string,
	digest: string,
	fields: ReadonlyMap<string, string>
): Record<string, unknown> {
	const choices: Record<string, string> = {};
	for (const [name, value] of fields) {
		if (/^consent(?:-value|-field)?:/u.test(name)) choices[name] = value;
	}
	return { interactionId, stepId, digest, choices };
}

/** The choices a draft keeps for these terms; null when none. */
export function readLiteConsentDraft(
	data: Record<string, unknown>,
	interactionId: string,
	stepId: string,
	digest: string
): Record<string, string> | null {
	const draft = data.consentDraft;
	if (
		!isRecord(draft) ||
		draft.interactionId !== interactionId ||
		draft.stepId !== stepId ||
		draft.digest !== digest ||
		!isRecord(draft.choices)
	) {
		return null;
	}
	const choices: Record<string, string> = {};
	for (const [name, value] of Object.entries(draft.choices)) {
		if (typeof value === 'string') choices[name] = value;
	}
	return choices;
}

/**
 * A kept decision as the form's choices (its field names and values): what the page draws again
 * when it draws the terms it was taken for.
 */
export function liteConsentChoices(input: Record<string, unknown>): Record<string, string> {
	const choices: Record<string, string> = {};
	const decisions = isRecord(input.consent_item_decisions) ? input.consent_item_decisions : {};
	const selected = isRecord(input.consent_item_selected_values)
		? input.consent_item_selected_values
		: {};
	const fields = isRecord(input.destination_field_decisions)
		? input.destination_field_decisions
		: {};
	for (const [id, decision] of Object.entries(decisions)) {
		if (decision === 'granted') choices[`consent:${id}`] = 'granted';
	}
	for (const [id, value] of Object.entries(selected)) {
		if (typeof value === 'string' && value) choices[`consent-value:${id}`] = value;
	}
	for (const [field, agreed] of Object.entries(fields)) {
		if (agreed === true) choices[`consent-field:${field}`] = 'granted';
	}
	return choices;
}

/**
 * What the transaction keeps once a step's decision is added (the interaction's others with it,
 * the newest few): for the patch of the move that records what the decision went with.
 */
export function keptFlowConsentWith(
	data: Record<string, unknown>,
	interactionId: string,
	stepId: string,
	digest: string,
	input: Record<string, unknown>
): Record<string, unknown> {
	const kept = data.flowConsent;
	const others =
		isRecord(kept) && kept.interactionId === interactionId && isRecord(kept.steps)
			? Object.entries(kept.steps).filter(([id]) => id !== stepId)
			: [];
	// The newest first: older steps' decisions give way (to the most steps, and bytes, kept).
	const entries: Array<[string, unknown]> = [[stepId, { digest, input }]];
	for (const entry of others.slice().reverse()) {
		if (entries.length >= MAX_KEPT_STEPS) break;
		const candidate = [entry, ...entries];
		if (utf8Bytes({ interactionId, steps: Object.fromEntries(candidate) }) > MAX_KEPT_BYTES) break;
		entries.unshift(entry);
	}
	return { interactionId, steps: Object.fromEntries(entries) };
}
