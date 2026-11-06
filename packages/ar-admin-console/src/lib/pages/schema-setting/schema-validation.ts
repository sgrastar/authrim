import type { EnumOption, FieldType, ValidationRules } from '#lib/api/schema-setting.js';
import type { ChoiceItem } from '#lib/ui/builder/OptionListEditor.svelte';

/**
 * What the Admin API refuses, checked before sending. Its answer to every refused value is the
 * same fixed sentence ("The field format is invalid."): a reserved key, a key already in use, an
 * unsafe pattern all read alike. So the page finds out first, and says which it is.
 *
 * These mirror the API's own rules (`admin-custom-claims.ts`); the API stays the judge, this only
 * saves the round trip and gives the reason.
 */

/** snake_case, starts with a letter, up to 64 characters. */
export const FIELD_KEY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

export const LABEL_MAX = 255;
export const DESCRIPTION_MAX = 2000;
export const NAMESPACE_MAX = 255;
export const ENUM_VALUES_MAX = 100;
export const ENUM_VALUE_MAX = 128;
export const ENUM_LABEL_MAX = 100;
export const PATTERN_MAX = 128;
export const RULES_MAX_CHARS = 4096;
/** Enum rules carry every choice's labels in every language (UTF-8 bytes, as the API counts). */
export const ENUM_RULES_MAX_BYTES = 64 * 1024;

export type KeyProblem = 'empty' | 'pattern' | 'reserved' | 'taken' | 'same';

/**
 * A key for a new attribute, or the new key of a rename (`current` is then the key it has now).
 * `taken` is the keys of the active attributes: the API only refuses a key another active one has.
 */
export function checkKey(
	key: string,
	options: { reserved: ReadonlySet<string>; taken: ReadonlySet<string>; current?: string }
): KeyProblem | null {
	if (key === '') return 'empty';
	if (options.current !== undefined && key === options.current) return 'same';
	if (!FIELD_KEY_PATTERN.test(key)) return 'pattern';
	if (options.reserved.has(key)) return 'reserved';
	if (options.taken.has(key)) return 'taken';
	return null;
}

export type TextProblem = 'empty' | 'too_long';

export function checkLabel(label: string): TextProblem | null {
	const trimmed = label.trim();
	if (trimmed === '') return 'empty';
	return trimmed.length > LABEL_MAX ? 'too_long' : null;
}

export function checkLength(value: string, max: number): 'too_long' | null {
	return value.length > max ? 'too_long' : null;
}

export type NamespaceProblem = 'scheme' | 'too_long';

/** Empty means none. Otherwise an http(s) address. */
export function checkNamespace(value: string): NamespaceProblem | null {
	const trimmed = value.trim();
	if (trimmed === '') return null;
	if (trimmed.length > NAMESPACE_MAX) return 'too_long';
	return /^https?:\/\//.test(trimmed) ? null : 'scheme';
}

/**
 * A pattern that cannot make the check hang: short, valid, and without the shapes that make a
 * regular expression take exponential time (nested or adjacent quantifiers, a quantified
 * alternation).
 */
export function isSafeRegex(pattern: string): boolean {
	if (pattern.length > PATTERN_MAX) return false;
	if (/\([^)]*[+*][^)]*\)[+*?{]/.test(pattern)) return false;
	if (/\(\?:[^)]*[+*][^)]*\)[+*?{]/.test(pattern)) return false;
	if (/\([^)]*\|[^)]*\)[+*{]/.test(pattern)) return false;
	if (/[+*]{2,}/.test(pattern) || /\}\{/.test(pattern)) return false;
	try {
		new RegExp(pattern);
	} catch {
		return false;
	}
	return true;
}

/** The rules as typed in the form: text for a number, so that a half-typed one can be shown. */
export interface RulesForm {
	minLength: string;
	maxLength: string;
	pattern: string;
	min: string;
	max: string;
	/** The choices: value and default label, each with a stable key (see `enumLabels`). */
	enumOptions: ChoiceItem[];
	/** The choices' labels by language, by the choice's key. */
	enumLabels: Record<string, Record<string, string>>;
	minDate: string;
	maxDate: string;
}

export function emptyRulesForm(): RulesForm {
	return {
		minLength: '',
		maxLength: '',
		pattern: '',
		min: '',
		max: '',
		enumOptions: [],
		enumLabels: {},
		minDate: '',
		maxDate: ''
	};
}

const text = (value: number | undefined) => (value === undefined ? '' : String(value));

/** The choices of stored rules: their options, else their bare values. */
function enumOptionsOf(rules: ValidationRules | null): EnumOption[] {
	if (rules?.enum_options?.length) return rules.enum_options;
	return (rules?.enum_values ?? []).map((value) => ({ value }));
}

export function formFromRules(rules: ValidationRules | null): RulesForm {
	const options = enumOptionsOf(rules);
	return {
		minLength: text(rules?.min_length),
		maxLength: text(rules?.max_length),
		pattern: rules?.pattern ?? '',
		min: text(rules?.min),
		max: text(rules?.max),
		enumOptions: options.map((option, index) => ({
			key: `choice-${index}`,
			value: option.value,
			label: option.label ?? ''
		})),
		enumLabels: Object.fromEntries(
			options.map((option, index) => [`choice-${index}`, { ...(option.labels ?? {}) }])
		),
		minDate: rules?.min_date ?? '',
		maxDate: rules?.max_date ?? ''
	};
}

export type RulesProblem =
	| 'min_length_invalid'
	| 'max_length_invalid'
	| 'length_order'
	| 'pattern_unsafe'
	| 'min_invalid'
	| 'max_invalid'
	| 'range_order'
	| 'enum_empty'
	| 'enum_too_many'
	| 'enum_duplicate'
	| 'enum_value_empty'
	| 'enum_value_too_long'
	| 'enum_label_too_long'
	| 'date_order'
	| 'too_large';

const asNumber = (value: string): number | null => {
	if (value.trim() === '') return null;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : Number.NaN;
};

/** The rules the form describes, for the type: only the keys that type takes. */
export function rulesFromForm(type: FieldType, form: RulesForm): ValidationRules | null {
	const rules: ValidationRules = {};
	if (type === 'string') {
		const min = asNumber(form.minLength);
		const max = asNumber(form.maxLength);
		if (min !== null) rules.min_length = min;
		if (max !== null) rules.max_length = max;
		if (form.pattern !== '') rules.pattern = form.pattern;
	}
	if (type === 'number') {
		const min = asNumber(form.min);
		const max = asNumber(form.max);
		if (min !== null) rules.min = min;
		if (max !== null) rules.max = max;
	}
	if (type === 'enum') {
		rules.enum_values = form.enumOptions.map((option) => option.value.trim());
		const options = form.enumOptions.map((option) => {
			const labels = Object.fromEntries(
				Object.entries(form.enumLabels[option.key ?? ''] ?? {})
					.map(([locale, text]) => [locale, text.trim()])
					.filter(([, text]) => text !== '')
			);
			const label = option.label.trim();
			return {
				value: option.value.trim(),
				...(label ? { label } : {}),
				...(Object.keys(labels).length ? { labels } : {})
			};
		});
		// Choices with no label at all are stored as bare values, as before labels existed.
		if (options.some((option) => 'label' in option || 'labels' in option)) {
			rules.enum_options = options;
		}
	}
	if (type === 'date') {
		if (form.minDate !== '') rules.min_date = form.minDate;
		if (form.maxDate !== '') rules.max_date = form.maxDate;
	}
	return Object.keys(rules).length > 0 ? rules : null;
}

/** What is wrong with the rules in the form, for the type; none when they can be sent. */
export function checkRules(
	type: FieldType,
	form: RulesForm
): Partial<Record<string, RulesProblem>> {
	const problems: Partial<Record<string, RulesProblem>> = {};
	if (type === 'string') {
		const min = asNumber(form.minLength);
		const max = asNumber(form.maxLength);
		if (min !== null && (Number.isNaN(min) || min < 0 || !Number.isInteger(min)))
			problems.minLength = 'min_length_invalid';
		if (max !== null && (Number.isNaN(max) || max < 1 || !Number.isInteger(max)))
			problems.maxLength = 'max_length_invalid';
		if (!problems.minLength && !problems.maxLength && min !== null && max !== null && min > max)
			problems.maxLength = 'length_order';
		if (form.pattern !== '' && !isSafeRegex(form.pattern)) problems.pattern = 'pattern_unsafe';
	}
	if (type === 'number') {
		const min = asNumber(form.min);
		const max = asNumber(form.max);
		if (min !== null && Number.isNaN(min)) problems.min = 'min_invalid';
		if (max !== null && Number.isNaN(max)) problems.max = 'max_invalid';
		if (!problems.min && !problems.max && min !== null && max !== null && min > max)
			problems.max = 'range_order';
	}
	if (type === 'enum') {
		const values = form.enumOptions.map((option) => option.value.trim());
		const labels = form.enumOptions.flatMap((option) => [
			option.label,
			...Object.values(form.enumLabels[option.key ?? ''] ?? {})
		]);
		if (values.length === 0) problems.enumOptions = 'enum_empty';
		else if (values.length > ENUM_VALUES_MAX) problems.enumOptions = 'enum_too_many';
		else if (values.some((value) => value === '')) problems.enumOptions = 'enum_value_empty';
		else if (values.some((value) => value.length > ENUM_VALUE_MAX))
			problems.enumOptions = 'enum_value_too_long';
		else if (new Set(values).size !== values.length) problems.enumOptions = 'enum_duplicate';
		else if (labels.some((label) => label.trim().length > ENUM_LABEL_MAX))
			problems.enumLabels = 'enum_label_too_long';
	}
	if (type === 'date' && form.minDate !== '' && form.maxDate !== '' && form.minDate > form.maxDate)
		problems.maxDate = 'date_order';
	if (Object.keys(problems).length === 0) {
		const rules = rulesFromForm(type, form);
		// As the API measures them: the JSON sent, in UTF-8 bytes.
		const max = type === 'enum' ? ENUM_RULES_MAX_BYTES : RULES_MAX_CHARS;
		if (rules && new TextEncoder().encode(JSON.stringify(rules)).length > max)
			problems.rules = 'too_large';
	}
	return problems;
}
