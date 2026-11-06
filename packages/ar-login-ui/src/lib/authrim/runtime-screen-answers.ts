/**
 * The answers of a runtime screen's input parts, as a Flow `screen` step submits them
 * (`input.fields`), and which parts keep their answers off the profile.
 *
 * The parts are read as the server reads them (ar-auth runtime-screen-answers.ts): the input
 * parts the screen shows, not hidden themselves nor in a hidden row. The server checks the answers
 * against its own copy of the screen; this only sends what the person entered.
 */

type JsonObject = Record<string, unknown>;

const INPUT_BLOCK_TYPES: ReadonlySet<string> = new Set([
	'identity_field',
	'select',
	'radio',
	'checkbox'
]);

function isRecord(value: unknown): value is JsonObject {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown): string | null {
	return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function blockTypeOf(part: JsonObject): string {
	return text(part.block_type) ?? 'identity_field';
}

function isHidden(part: JsonObject): boolean {
	return isRecord(part.display_condition) && part.display_condition.mode === 'hidden';
}

/** A checkbox part, or the legacy yes/no form (an identity field of value type boolean). */
export function isCheckboxPart(part: JsonObject): boolean {
	const blockType = blockTypeOf(part);
	return (
		blockType === 'checkbox' ||
		(blockType === 'identity_field' && text(part.value_type) === 'boolean')
	);
}

/** The input parts a screen shows, in order. */
export function shownScreenInputParts(screen: unknown): JsonObject[] {
	if (!isRecord(screen) || !Array.isArray(screen.fields)) return [];
	const parts: JsonObject[] = [];
	let rowHidden = false;
	for (const raw of screen.fields) {
		if (!isRecord(raw)) continue;
		const blockType = blockTypeOf(raw);
		if (blockType === 'layout_row') {
			rowHidden = isHidden(raw);
			continue;
		}
		if (rowHidden || isHidden(raw) || !INPUT_BLOCK_TYPES.has(blockType)) continue;
		if (!text(raw.field)) continue;
		parts.push(raw);
	}
	return parts;
}

function isConditional(part: JsonObject): boolean {
	return isRecord(part.display_condition) && part.display_condition.mode === 'feature_enabled';
}

/**
 * The required parts the server requires an answer to: not shown only for a sign-in method,
 * themselves or by their row (the server does not judge a method's availability).
 */
export function requiredScreenInputParts(screen: unknown): JsonObject[] {
	if (!isRecord(screen) || !Array.isArray(screen.fields)) return [];
	const shown = new Set(shownScreenInputParts(screen));
	const parts: JsonObject[] = [];
	let rowConditional = false;
	for (const raw of screen.fields) {
		if (!isRecord(raw)) continue;
		if (blockTypeOf(raw) === 'layout_row') {
			rowConditional = isConditional(raw);
			continue;
		}
		if (shown.has(raw) && raw.required === true && !rowConditional && !isConditional(raw)) {
			parts.push(raw);
		}
	}
	return parts;
}

/** The fields of the parts whose answers are kept off the profile (never a profile attribute). */
export function offProfileFieldKeys(screen: unknown): Set<string> {
	return new Set(
		shownScreenInputParts(screen)
			.filter((part) => part.store_to_profile === false)
			.map((part) => text(part.field) as string)
	);
}

/** Whether a value counts as an answer to a part (a ticked box, a non-empty text or choice). */
export function hasScreenAnswer(part: JsonObject, value: unknown): boolean {
	if (isCheckboxPart(part)) return value === true || value === 'true';
	return typeof value === 'string' && value.trim() !== '';
}

/** The parts a person signs in with: a screen that has one is a sign-in, not a form to answer. */
const SIGN_IN_BLOCK_TYPES: ReadonlySet<string> = new Set([
	'auth_widget',
	'code_input_widget',
	'guest_login_widget'
]);

/** Whether a step is a screen to answer: a `screen` step that is not a sign-in screen. */
export function isAnswerScreenStep(step: { component?: string } | null, screen: unknown): boolean {
	return step?.component === 'screen' && !isSignInScreen(screen);
}

/** Whether a screen is one a person signs in on (the server reads no answers on it). */
export function isSignInScreen(screen: unknown): boolean {
	if (!isRecord(screen) || !Array.isArray(screen.fields)) return false;
	return screen.fields.some((part) => isRecord(part) && SIGN_IN_BLOCK_TYPES.has(blockTypeOf(part)));
}

/**
 * `input.fields` for a screen step (none for a sign-in screen): each shown input part's answer,
 * a checkbox as a boolean, any other part as its text. A part the person did not answer (an empty
 * text, a box never touched, a part the page did not draw) is null, which changes nothing stored.
 * `valueOf` reads what the page holds for a part.
 */
export function screenAnswerFields(
	screen: unknown,
	valueOf: (field: string) => string | boolean | undefined
): Record<string, string | boolean | null> {
	const fields: Record<string, string | boolean | null> = {};
	if (isSignInScreen(screen)) return fields;
	for (const part of shownScreenInputParts(screen)) {
		const field = text(part.field) as string;
		const value = valueOf(field);
		if (isCheckboxPart(part)) {
			fields[field] = value === undefined ? null : value === true || value === 'true';
		} else {
			fields[field] = typeof value === 'string' && value.trim() ? value : null;
		}
	}
	return fields;
}
