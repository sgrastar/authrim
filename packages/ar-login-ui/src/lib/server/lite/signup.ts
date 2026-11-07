/**
 * A lite sign-up's profile (PR6a): what a sign-up method sends with the account it makes, read from
 * the step's form as the SPA's sign-up page reads it (signup +page.svelte `getSubmittedCustomFields`,
 * `getSubmittedDisplayName`).
 *
 * - Only the parts the screen shows and stores to the profile are sent (`profileFieldKeys`): a part
 *   kept off the profile (`store_to_profile: false`) never is; the server checks the sign-up
 *   against the screen (ar-auth signup-screen-check).
 * - The fixed attributes (the address, the name, whether the address is checked) are sent as
 *   themselves, never among the custom fields.
 * - A required part not answered stops the post before anything is sent: the server would only
 *   leave the code unsent behind an answer that says it was sent.
 */
import type { FlowRuntimeStep } from '#lib/api/flow-runtime.js';
import {
	hasScreenAnswer,
	isCheckboxPart,
	profileFieldKeys,
	requiredScreenInputParts,
	shownScreenInputParts
} from '#lib/authrim/runtime-screen-answers.js';
import { rawScreenOf } from './flow-driver';

const NAME_KEYS: ReadonlySet<string> = new Set(['name', 'field.canonical.name']);
const EMAIL_KEYS: ReadonlySet<string> = new Set(['email', 'field.canonical.email']);
const GIVEN_NAME_KEYS: ReadonlySet<string> = new Set([
	'given_name',
	'first_name',
	'field.canonical.given_name',
	'field.canonical.first_name'
]);
const FAMILY_NAME_KEYS: ReadonlySet<string> = new Set([
	'family_name',
	'last_name',
	'field.canonical.family_name',
	'field.canonical.last_name'
]);
const FIXED_KEYS: ReadonlySet<string> = new Set([
	...NAME_KEYS,
	...EMAIL_KEYS,
	'email_verified',
	'field.canonical.email_verified'
]);

const normalized = (key: string) => key.trim().toLowerCase();

/** A name part, as the SPA's runtime screen tells it (`name`, or a key ending in `.name`). */
function isNamePart(field: string): boolean {
	const key = normalized(field);
	return NAME_KEYS.has(key) || key.endsWith('.name');
}

function isEmailPart(field: string): boolean {
	const key = normalized(field);
	return EMAIL_KEYS.has(key) || key.endsWith('.email');
}

export interface LiteSignupProfile {
	/** The name the account is made with (the SPA's: the name, else given and family, else none). */
	displayName: string | null;
	/** The profile parts' answers, by their keys (a checkbox as `true` / `false`). */
	customFields: Record<string, string>;
}

/**
 * The profile a sign-up sends, from the form; `required` when a part the server requires is not
 * answered (the address is the method's own to check).
 */
export function readLiteSignupProfile(
	fields: ReadonlyMap<string, string>,
	step: FlowRuntimeStep,
	/** What the page drew (a part it left out, its condition not met, is never answered). */
	decision: { kind: string; fields?: Array<{ field: string }> }
): LiteSignupProfile | { required: true } {
	const screen = rawScreenOf(step);
	const drawn = new Set(
		decision.kind === 'screen' ? (decision.fields ?? []).map((field) => field.field) : []
	);
	for (const part of requiredScreenInputParts(screen)) {
		const field = String(part.field).trim();
		if (isEmailPart(field) || !drawn.has(field)) continue;
		if (!hasScreenAnswer(part, fields.get(field))) return { required: true };
	}

	const asked = profileFieldKeys(screen);
	const customFields: Record<string, string> = {};
	let name = '';
	for (const part of shownScreenInputParts(screen)) {
		const field = String(part.field).trim();
		if (!drawn.has(field)) continue;
		const value = fields.get(field);
		if (isNamePart(field)) {
			name = value?.trim() ?? '';
			continue;
		}
		if (FIXED_KEYS.has(normalized(field)) || isEmailPart(field) || !asked.has(field)) continue;
		if (isCheckboxPart(part)) {
			customFields[field] = value === 'true' ? 'true' : 'false';
		} else if (value !== undefined && value.trim() !== '') {
			customFields[field] = value;
		}
	}
	const byKeys = (keys: ReadonlySet<string>) =>
		Object.entries(customFields)
			.find(([key, value]) => keys.has(normalized(key)) && value.trim())?.[1]
			?.trim() ?? '';
	const composite = [byKeys(GIVEN_NAME_KEYS), byKeys(FAMILY_NAME_KEYS)].filter(Boolean).join(' ');
	return { displayName: name || composite || null, customFields };
}
