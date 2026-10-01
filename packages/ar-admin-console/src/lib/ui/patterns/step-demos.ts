import type { TransformId } from './mapping-model';
import { asciiDigits, stripAccents } from './text-fold';
import { toFullwidth, toHalfwidth } from './text-width';

/**
 * The picker's little animations: what each mapping step does to a sample value, as data.
 * StepDemo plays any of them — every step has one (the Record makes a missing one a type
 * error).
 *
 * A value is a row of parts, each kept, removed (struck through, then folded away), added
 * (unfolds, highlighted) or swapped for other text (turns over). Several values are chips;
 * a whole chip can go or come, which is how splitting, joining and choosing among values look.
 * Samples are plain English (John Smith), readable anywhere.
 */

export interface DemoPart {
	text: string;
	/** Nothing: kept as it is. */
	as?: 'drop' | 'add' | 'swap';
	/** What a swapped part becomes. */
	to?: string;
	/** Spaces, drawn as dots. */
	space?: boolean;
}

export interface DemoChip {
	parts: DemoPart[];
	/** The whole value goes, or arrives. */
	as?: 'drop' | 'add';
}

export interface Demo {
	chips: DemoChip[];
	/** Draw the values as chips (several values), not as one line of text. */
	list?: boolean;
}

const keep = (text: string): DemoPart => ({ text });
const drop = (text: string): DemoPart => ({ text, as: 'drop' });
const add = (text: string): DemoPart => ({ text, as: 'add' });
const swap = (text: string, to: string): DemoPart => ({ text, as: 'swap', to });
const spaces = (n: number): DemoPart => ({ text: ' '.repeat(n), as: 'drop', space: true });

/** One value, made of parts. */
const one = (...parts: DemoPart[]): Demo => ({ chips: [{ parts }] });

/** One value where each character may turn into another (upper → lower, full → half width). */
function perChar(text: string, change: (c: string) => string): Demo {
	return one(
		...[...text].map((c) => {
			const to = change(c);
			return to === c ? keep(c) : swap(c, to);
		})
	);
}

/** Several values as chips. */
const chips = (...list: DemoChip[]): Demo => ({ chips: list, list: true });
const chip = (text: string, as?: DemoChip['as']): DemoChip => ({ parts: [keep(text)], as });

export const DEMOS: Record<TransformId, Demo> = {
	// Tidy text
	trim: one(spaces(3), keep('John Smith'), spaces(3)),
	normalize: one(keep('John'), spaces(3), keep(' Smith')),
	case: perChar('John.SMITH@Example.COM', (c) => c.toLowerCase()),
	to_halfwidth: perChar('ＡＢＣ－１２３', (c) => toHalfwidth(c, true)),
	to_fullwidth: perChar('ABC-123', (c) => toFullwidth(c, true)),
	strip_accents: perChar('José Müller', stripAccents),
	ascii_digits: perChar('٤٢٠١', asciiDigits),

	// Edit text
	affix_text: one(add('emp-'), keep('1024')),
	keep_part: one(keep('john.smith'), drop('@example.com')),
	remove_text: one(keep('+1'), drop('-'), keep('555'), drop('-'), keep('0142')),
	replace_text: one(keep('Sales '), swap('&', 'and'), keep(' Marketing')),
	regex_replace: one(drop('John Smith <'), keep('john@example.com'), drop('>')),

	// Convert values
	value_map: one(swap('SLS', 'Sales')),
	text_to_boolean: one(swap('Active', 'true')),
	text_to_number: one(drop('"'), keep('42'), drop('"')),
	date_format: one(swap('1700000000', '2023-11-15T07:13:20+09:00')),
	conditional: chips(chip('type = contract', 'drop'), chip('contractor', 'add')),
	has_value: one(swap('john@example.com', 'true')),
	normalize_empty: one(spaces(3), add('null')),
	json_extract_or: one(drop('{"name":"John"}'), add('https://…/default.png')),

	// Several values
	as_array: one(add('['), keep('admins'), add(']')),
	split: chips(
		chip('sales,admins,staff', 'drop'),
		chip('sales', 'add'),
		chip('admins', 'add'),
		chip('staff', 'add')
	),
	join: chips(
		chip('sales', 'drop'),
		chip('admins', 'drop'),
		chip('staff', 'drop'),
		chip('sales,admins,staff', 'add')
	),
	first: chips(chip('sales'), chip('admins', 'drop'), chip('staff', 'drop')),
	filter_values: chips(chip('app-crm'), chip('staff', 'drop'), chip('app-hr')),

	// Combine attributes
	concat: chips(chip('John', 'drop'), chip('Smith', 'drop'), chip('John Smith', 'add')),
	fallback: chips(chip('—', 'drop'), chip('Smith')),
	array_build: chips(chip('sales', 'drop'), chip('admins', 'drop'), chip('[sales, admins]', 'add')),

	// Generate a value (nothing yet → the value)
	constant_text: one(drop('—'), add('Engineering')),
	constant_boolean: one(drop('—'), add('true')),
	constant_number: one(drop('—'), add('100')),
	default_if_empty: one(drop('—'), add('en')),

	// Identifiers: the user's ID becomes one only this app (or SP) sees
	oidc_pairwise_sub: one(swap('usr_01J8Z4', '7f3a9c2e1b04')),
	saml_edu_person_targeted_id: one(swap('usr_01J8Z4', 'idp!sp!9b2e41')),
	hash: one(swap('john@example.com', '5e884898da28')),

	// JSON
	json_build: chips(
		chip('john@example.com', 'drop'),
		chip('Sales', 'drop'),
		chip('{"mail":"john@…","dept":"Sales"}', 'add')
	),
	json_extract_text: one(drop('{"address":{"city":"'), keep('Paris'), drop('"}}')),
	json_extract_boolean: one(drop('{"verified":'), keep('true'), drop('}')),
	json_extract_integer: one(drop('{"age":"'), keep('42'), drop('"}')),
	json_extract_array: one(drop('{"groups":'), keep('["sales","admins"]'), drop('}'))
};
