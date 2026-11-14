/**
 * What a step's "shown to" field can compare, from what the tenant has: its attributes (the
 * standard profile ones a Flow condition reads, then the schema's own), the choices made on the
 * flow's screens (parts kept off the profile and sent to the Flow), and the Login UI languages.
 */
import type { Schema } from '#lib/api/schema-setting.js';
import type { ScreenField, ScreenListItem } from '#lib/api/screens.js';
import { schemaChoicesOf } from '#lib/pages/customization/screens/schema-choices.svelte.js';
import {
	getLoginUILanguageDisplayName,
	LOGIN_UI_LOCALES
} from '@authrim/ar-lib-core/types/login-ui-languages';
import {
	STANDARD_CONDITION_ATTRIBUTES,
	type ConditionAnswer,
	type ConditionAttribute
} from './step-condition-model';

/** The kind of value each standard attribute holds. */
const STANDARD_TYPES: Record<string, ConditionAttribute['type']> = { birthdate: 'date' };

/**
 * The attributes a rule can compare: the standard ones first (named by `standardLabel`), then
 * the schema's active ones by their label (one with a standard key is the standard one).
 */
export function conditionAttributesOf(
	schemas: readonly Schema[],
	locale: string,
	standardLabel: (key: string) => string
): ConditionAttribute[] {
	const standard = STANDARD_CONDITION_ATTRIBUTES.map((key) => ({
		key,
		label: standardLabel(key),
		type: STANDARD_TYPES[key] ?? ('string' as const)
	}));
	const taken = new Set(STANDARD_CONDITION_ATTRIBUTES.map((key) => key.toLowerCase()));
	const own = schemas.flatMap((schema): ConditionAttribute[] => {
		const key = schema.fieldKey;
		if (!schema.isActive || schema.status !== 'active' || taken.has(key.toLowerCase())) return [];
		taken.add(key.toLowerCase());
		const choices = schema.type === 'enum' ? schemaChoicesOf(schema, locale) : [];
		return [
			{
				key,
				label: schema.label || key,
				type: schema.type,
				...(schema.cardinality === 'multi' ? { multi: true } : {}),
				...(choices.length > 0 ? { choices } : {})
			}
		];
	});
	return [...standard, ...own];
}

const CHOICE_PARTS: ReadonlySet<string> = new Set(['select', 'radio', 'checkbox']);

/** Whether a part's answer is a choice sent to the Flow (what a screen answer condition reads). */
function sentToFlow(field: ScreenField): boolean {
	if (!CHOICE_PARTS.has(field.block_type ?? '') || field.store_to_profile !== false) return false;
	const targets = field.answer_targets;
	// None named: the answer goes to the Flow.
	return !Array.isArray(targets) || targets.length === 0 || targets.includes('flow_event');
}

/** The parts a person signs in with: the Flow keeps no answers of a screen that has one. */
const SIGN_IN_PARTS: ReadonlySet<string> = new Set([
	'auth_widget',
	'code_input_widget',
	'guest_login_widget'
]);

function isHidden(field: ScreenField): boolean {
	const condition = (field as { display_condition?: unknown }).display_condition;
	return (
		condition !== null &&
		typeof condition === 'object' &&
		(condition as { mode?: unknown }).mode === 'hidden'
	);
}

/** The parts a screen shows (as the runtime reads them): not hidden, nor in a hidden row. */
function shownParts(screen: ScreenListItem): ScreenField[] {
	let rowHidden = false;
	return screen.fields.filter((field) => {
		if (field.block_type === 'layout_row') {
			rowHidden = isHidden(field);
			return false;
		}
		return !rowHidden && !isHidden(field);
	});
}

/** Whether a screen is a sign-in (as the runtime reads it: an untyped part is an input). */
function isSignInScreen(screen: ScreenListItem): boolean {
	return screen.fields.some((field) => SIGN_IN_PARTS.has(field.block_type ?? 'identity_field'));
}

/**
 * The answers a rule can compare: the choice parts sent to the Flow on the screens `keys` names
 * (each key once, the first screen's part where two share it). A checkbox is ticked or not.
 */
export function conditionAnswersOf(
	screens: readonly ScreenListItem[],
	keys: readonly string[]
): ConditionAnswer[] {
	// The Flow reads the latest answer to a key, from whichever screen: its choices are those of
	// every screen that asks it. A key a checkbox asks on one screen and a choice on another
	// cannot be compared one way, so it is not offered.
	const byKey = new Map<string, ConditionAnswer | null>();
	for (const screenKey of keys) {
		const screen = screens.find((candidate) => candidate.screen_key === screenKey);
		if (!screen || isSignInScreen(screen)) continue;
		for (const field of shownParts(screen)) {
			if (!sentToFlow(field) || !field.field) continue;
			const checkbox = field.block_type === 'checkbox';
			const choices = checkbox
				? []
				: (field.options ?? []).map((option) => ({
						value: option.value,
						label: option.label || option.value
					}));
			const seen = byKey.get(field.field);
			if (seen === null) continue;
			if (seen === undefined) {
				const label = field.label || field.field;
				byKey.set(
					field.field,
					checkbox
						? { key: field.field, label, checkbox, choices }
						: { key: field.field, label, choices }
				);
			} else if (Boolean(seen.checkbox) !== checkbox) {
				byKey.set(field.field, null);
			} else {
				const known = new Set(seen.choices.map((choice) => choice.value));
				seen.choices = [...seen.choices, ...choices.filter((choice) => !known.has(choice.value))];
			}
		}
	}
	return [...byKey.values()].filter((answer): answer is ConditionAnswer => answer !== null);
}

/** The Login UI languages, each by its own name. */
export function localeChoices(): { value: string; label: string }[] {
	return LOGIN_UI_LOCALES.map((locale) => ({
		value: locale,
		label: getLoginUILanguageDisplayName(locale, true)
	}));
}
