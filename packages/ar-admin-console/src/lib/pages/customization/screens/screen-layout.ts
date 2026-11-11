/**
 * A saved screen's parts (`ScreenField[]`) as the builder works with them (rows of columns, each
 * part's settings, each row's display condition), and back.
 *
 * How a screen is saved: its parts in order, with `layout_row` parts between them. A layout row
 * starts a row of `layout_columns` columns (1–3) that runs until the next layout row; a part in it
 * names its column (`layout_column`, from 1), or is placed in the next column in turn. Parts before
 * the first layout row have no explicit grouping and the builder presents each in its own
 * one-column row. The Login UI (RuntimeScreen.svelte) displays those parts vertically as well.
 *
 * What the builder does not edit is kept: each part (and row) is saved over the field it was read
 * from, so properties it does not know survive a save.
 */
import type { ScreenBlockType, ScreenField } from '@authrim/ar-lib-core/types/screens';
import { MAX_COLUMNS, type LayoutPart, type LayoutRow } from '#lib/ui/builder/layout-model.js';
import {
	CHOICE_KINDS,
	CONDITION_KINDS,
	INPUT_KINDS,
	LABEL_KINDS,
	LINK_ACTIONS,
	METHODS,
	defaultCondition,
	defaultSettings,
	type AnswerTarget,
	type DisplayCondition,
	type LinkAction,
	type Method,
	type PartSettings
} from './screen-model';

export interface BuilderScreen {
	rows: LayoutRow[];
	settings: Record<string, PartSettings>;
	rowSettings: Record<string, DisplayCondition>;
	/** The field each part and row was read from, by id (none for one added in the builder). */
	origins: Record<string, ScreenField>;
}

type Field = ScreenField & Record<string, unknown>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === 'string' ? value : '');

function columnsOf(value: unknown): number {
	return typeof value === 'number' && Number.isInteger(value) && value >= 1
		? Math.min(value, MAX_COLUMNS)
		: 1;
}

function columnOf(value: unknown, columns: number): number | null {
	return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= columns
		? value - 1
		: null;
}

function readCondition(value: unknown): DisplayCondition {
	if (!isRecord(value)) return defaultCondition();
	const mode = value.mode === 'feature_enabled' || value.mode === 'hidden' ? value.mode : 'always';
	const feature = METHODS.includes(value.feature as Method) ? (value.feature as Method) : 'passkey';
	return { mode, feature };
}

/**
 * The parts whose placeholder the builder edits. A checkbox's is the text beside the box of a
 * legacy yes/no question (edited as such, see PartSettingsPanel); a checkbox part ignores it.
 */
const PLACEHOLDER_KINDS: ReadonlySet<string> = new Set(['identity_field', 'select', 'checkbox']);
/** The parts whose `text` the builder edits (a divider's is its label). */
const TEXT_KINDS: ReadonlySet<string> = new Set([
	'heading',
	'text',
	'code_input_widget',
	'consent_widget',
	'security_verification'
]);

/** The legacy name a divider is saved under, never shown (the Login UI shows its `text`). */
export const DIVIDER_LABEL = 'Divider';

function dividerText(field: ScreenField): string {
	return field.text && field.text !== DIVIDER_LABEL ? field.text : '';
}

/** The legacy yes/no question (an identity field of value type boolean) is a checkbox. */
export function kindOfField(field: ScreenField): string {
	const kind = field.block_type ?? 'identity_field';
	return kind === 'identity_field' && field.value_type === 'boolean' ? 'checkbox' : kind;
}

function readTargets(value: unknown): AnswerTarget[] {
	const targets = Array.isArray(value)
		? value.filter(
				(target): target is AnswerTarget => target === 'flow_event' || target === 'record'
			)
		: [];
	return targets.length > 0 ? [...new Set(targets)] : ['flow_event'];
}

/** A code input's kind of code; an older part named it by `auth_method`, as the Login UI reads. */
function readCodeMode(field: Field): PartSettings['codeMode'] {
	const mode = field.code_input_mode ?? field.auth_method;
	return mode === 'mail_otp' || mode === 'totp' ? mode : 'auto';
}

function readSettings(field: Field, kind: string): PartSettings {
	const method = METHODS.includes(field.auth_method as Method)
		? (field.auth_method as Method)
		: 'passkey';
	const linked = INPUT_KINDS.has(kind) ? field.store_to_profile !== false : true;
	return defaultSettings({
		condition: readCondition(field.display_condition),
		linked,
		field: text(field.field),
		answerTargets: readTargets(field.answer_targets),
		showLabel: field.show_label !== false,
		placeholder: text(field.placeholder),
		options:
			CHOICE_KINDS.has(kind) && !linked && Array.isArray(field.options)
				? field.options
						.filter((option) => isRecord(option) && typeof option.value === 'string')
						.map((option) => ({ value: option.value, label: text(option.label) }))
				: [],
		helpText: text(field.help_text),
		required: field.required === true,
		method,
		actionText: field.external_idp_show_action_text === true,
		codeMode: readCodeMode(field),
		// A divider's words are edited as its label (see fieldsToBuilder).
		text: kind === 'divider' ? '' : text(field.text),
		href: text(field.href),
		linkAction: LINK_ACTIONS.includes(field.link_action as LinkAction)
			? (field.link_action as LinkAction)
			: 'url',
		linkExit: text(field.link_exit),
		linkStyle: field.link_style === 'button' ? 'button' : 'text',
		timing: field.human_verification_timing === 'submit' ? 'submit' : 'initial'
	});
}

/** Reads a saved screen into rows; `newId` names a part or row that has no id of its own. */
export function fieldsToBuilder(
	fields: readonly ScreenField[],
	newId: (prefix: string) => string
): BuilderScreen {
	const screen: BuilderScreen = { rows: [], settings: {}, rowSettings: {}, origins: {} };
	const used = new Set<string>();
	const idOf = (field: ScreenField, prefix: string) => {
		const own = typeof field.block_id === 'string' && field.block_id ? field.block_id : '';
		const id = own && !used.has(own) ? own : newId(prefix);
		used.add(id);
		return id;
	};

	const ordered = [...fields].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
	let row: LayoutRow | null = null;
	let placed = 0;
	let explicitRow = false;
	for (const field of ordered) {
		if (!isRecord(field)) continue;
		if (field.block_type === 'layout_row') {
			explicitRow = true;
			const id = idOf(field, 'row');
			row = {
				id,
				columns: Array.from({ length: columnsOf(field.layout_columns) }, (): LayoutPart[] => [])
			};
			placed = 0;
			screen.rows.push(row);
			screen.rowSettings[id] = readCondition(field.display_condition);
			screen.origins[id] = field;
			continue;
		}
		if (!row || !explicitRow) {
			const id = newId('row');
			row = { id, columns: [[]] };
			placed = 0;
			screen.rows.push(row);
			screen.rowSettings[id] = defaultCondition();
		}
		const kind = kindOfField(field);
		const id = idOf(field, kind.replace(/_widget$/u, ''));
		const columns = row.columns.length;
		const column = columnOf(field.layout_column, columns) ?? placed % columns;
		placed += 1;
		// A divider shows its `text` (its `label` is a name of its own, "Divider"): the builder
		// edits what it shows.
		const label = kind === 'divider' ? dividerText(field) : text(field.label);
		row.columns[column].push({ id, kind, label });
		screen.settings[id] = readSettings(field as Field, kind);
		screen.origins[id] = field;
	}
	return screen;
}

/**
 * What a part of `kind` writes from its settings. A property left undefined is not the part's to
 * edit: it keeps what was read (a link's display condition, say), and `removed` names the ones that
 * must go (where an answer goes, once it is stored to the profile).
 */
function writeSettings(
	kind: string,
	settings: PartSettings,
	label: string,
	ownKey: string
): Partial<ScreenField> {
	const input = INPUT_KINDS.has(kind);
	const keptOff = input && !settings.linked;
	return {
		label,
		// Only an input part's key is an attribute or an answer; the others keep their own.
		field: input ? settings.field : ownKey,
		required: input || kind === 'consent_widget' ? settings.required : undefined,
		display_condition: CONDITION_KINDS.has(kind)
			? settings.condition.mode === 'feature_enabled'
				? { mode: 'feature_enabled', feature: settings.condition.feature }
				: { mode: settings.condition.mode, feature: null }
			: undefined,
		placeholder: PLACEHOLDER_KINDS.has(kind) ? settings.placeholder || null : undefined,
		help_text: input ? settings.helpText || null : undefined,
		text: TEXT_KINDS.has(kind) ? settings.text || null : undefined,
		href: kind === 'link' && settings.linkAction === 'url' ? settings.href || null : undefined,
		link_action: kind === 'link' && settings.linkAction !== 'url' ? settings.linkAction : undefined,
		link_exit:
			kind === 'link' && settings.linkAction === 'exit'
				? settings.linkExit.trim() || null
				: undefined,
		link_style: kind === 'link' && settings.linkStyle === 'button' ? 'button' : undefined,
		auth_method: kind === 'auth_widget' ? settings.method : undefined,
		external_idp_show_action_text: kind === 'auth_widget' ? settings.actionText : undefined,
		code_input_mode: kind === 'code_input_widget' ? settings.codeMode : undefined,
		human_verification_timing: kind === 'security_verification' ? settings.timing : undefined,
		show_label: LABEL_KINDS.has(kind) ? settings.showLabel : undefined,
		store_to_profile: input ? settings.linked : undefined,
		answer_targets: keptOff ? [...settings.answerTargets] : undefined,
		options:
			keptOff && CHOICE_KINDS.has(kind)
				? settings.options.map((option) => ({ value: option.value, label: option.label }))
				: undefined
	};
}

/** What a part no longer has: the answer's targets and options of one stored to the profile. */
function removed(kind: string, settings: PartSettings): string[] {
	// A link opens a URL or leaves by a way out, never both; only an exit has a name, and a text
	// link saves no style.
	if (kind === 'link') {
		return [
			...(settings.linkAction === 'url' ? ['link_action'] : ['href']),
			...(settings.linkAction === 'exit' ? [] : ['link_exit']),
			...(settings.linkStyle === 'button' ? [] : ['link_style'])
		];
	}
	if (!INPUT_KINDS.has(kind)) return [];
	if (settings.linked) return ['answer_targets', 'options'];
	return CHOICE_KINDS.has(kind) ? [] : ['options'];
}

/** The legacy yes/no form, as read: an identity field of value type boolean. */
/** The parts read in the legacy yes/no form (saved back in it while stored to the profile). */
export function legacyYesNoIds(origins: BuilderScreen['origins']): Set<string> {
	return new Set(
		Object.entries(origins)
			.filter(([, field]) => isLegacyYesNo(field))
			.map(([id]) => id)
	);
}

export function isLegacyYesNo(field: ScreenField | undefined): boolean {
	return (
		!!field &&
		(field.block_type ?? 'identity_field') === 'identity_field' &&
		field.value_type === 'boolean'
	);
}

/** Drops what is undefined, so a property a kind does not use is not sent at all. */
function defined(field: Record<string, unknown>): ScreenField {
	return Object.fromEntries(
		Object.entries(field).filter(([, value]) => value !== undefined)
	) as unknown as ScreenField;
}

/**
 * Writes the builder's rows as a saved screen: a layout row before every row but a leading plain
 * one (one column, always shown, not read as a layout row), each part with its column, and an
 * `order` that keeps them in place. A legacy yes/no field stays in its form while it is stored to
 * the profile.
 */
export function builderToFields(screen: BuilderScreen): ScreenField[] {
	const fields: ScreenField[] = [];
	const next = () => (fields.length + 1) * 10;
	screen.rows.forEach((row, index) => {
		const condition = screen.rowSettings[row.id] ?? defaultCondition();
		const origin = screen.origins[row.id];
		const plainLead =
			index === 0 && !origin && row.columns.length === 1 && condition.mode === 'always';
		if (!plainLead) {
			fields.push(
				defined({
					...(origin ?? {}),
					field: origin?.field || row.id,
					// The API asks every part for a label; a row's is never shown.
					label: origin?.label || 'Layout row',
					required: false,
					block_type: 'layout_row',
					block_id: row.id,
					layout_columns: row.columns.length,
					layout_column: undefined,
					display_condition:
						condition.mode === 'feature_enabled'
							? { mode: 'feature_enabled', feature: condition.feature }
							: { mode: condition.mode, feature: null },
					order: next()
				})
			);
		}
		// Row by row across the columns (the first part of each column, then the second…): the
		// Login UI places them in a grid in this order, each in the column it names.
		const depth = Math.max(...row.columns.map((column) => column.length));
		const across = Array.from({ length: depth }, (_, index) =>
			row.columns.flatMap((column, columnIndex) =>
				index < column.length ? [{ part: column[index], columnIndex }] : []
			)
		).flat();
		{
			for (const { part, columnIndex } of across) {
				const settings = screen.settings[part.id] ?? defaultSettings();
				const read = screen.origins[part.id];
				const origin: Field = { ...((read ?? {}) as Field) };
				const written = writeSettings(
					part.kind,
					settings,
					part.label,
					text(origin.field) || part.id
				);
				for (const [key, value] of Object.entries(written)) {
					if (value !== undefined) origin[key] = value;
				}
				for (const key of removed(part.kind, settings)) delete origin[key];
				if (typeof origin.required !== 'boolean') origin.required = false;
				// A legacy yes/no question stays in that form while it is stored to the profile: the
				// lite Login UI renders only that form until it takes checkbox parts, and its box may
				// have words of its own (its placeholder) a checkbox cannot hold. One kept off the
				// profile is a checkbox (the API reads it as one).
				const keepsLegacy = isLegacyYesNo(read) && settings.linked;
				if (!keepsLegacy) delete origin.value_type;
				fields.push(
					defined({
						...origin,
						...(part.kind === 'divider'
							? { label: text(read?.label) || DIVIDER_LABEL, text: part.label || null }
							: {}),
						block_type: (keepsLegacy ? 'identity_field' : part.kind) as ScreenBlockType,
						block_id: part.id,
						layout_column: row.columns.length > 1 ? columnIndex + 1 : undefined,
						order: next()
					})
				);
			}
		}
	});
	return fields;
}
