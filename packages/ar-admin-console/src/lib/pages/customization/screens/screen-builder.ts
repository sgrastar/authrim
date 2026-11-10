/**
 * What the screen builder shows around the layout: the palette of parts (by group), what each
 * placed part is called, the texts there are to translate, and the settings a new part starts with.
 */
import type { LayoutPart, LayoutRow } from '#lib/ui/builder/layout-model.js';
import type { PaletteEntry } from '#lib/ui/builder/PartPalette.svelte';
import type { TranslationRow } from '#lib/ui/builder/TranslationTable.svelte';
import { t } from '#lib/i18n/i18n.svelte.js';
import { groupName, methodName, partDescription, partName, setting } from './screen-copy';
import {
	ACCOUNT_KINDS,
	CHOICE_KINDS,
	INPUT_KINDS,
	PART_KINDS,
	defaultSettings,
	fieldFits,
	type PartGroup,
	type PartSettings,
	type SchemaField
} from './screen-model';

const GROUPS: readonly PartGroup[] = ['content', 'input', 'signin', 'account', 'security'];

/** The parts a screen of a kind offers: the account page its widgets, the others the rest. */
export function kindsFor(screenKind: string): readonly string[] {
	const account = screenKind === 'account';
	return PART_KINDS.filter((def) =>
		account ? ACCOUNT_KINDS.has(def.kind) || def.group === 'content' : !ACCOUNT_KINDS.has(def.kind)
	).map((def) => def.kind);
}

export function paletteGroups(kinds: readonly string[]) {
	const used = new Set(
		PART_KINDS.filter((def) => kinds.includes(def.kind)).map((def) => def.group)
	);
	return GROUPS.filter((group) => used.has(group)).map((id) => ({ id, label: groupName(id) }));
}

export function paletteEntries(kinds: readonly string[]): PaletteEntry[] {
	return PART_KINDS.filter((def) => kinds.includes(def.kind)).map((def) => ({
		kind: def.kind,
		label: partName(def.kind),
		description: partDescription(def.kind),
		icon: def.icon,
		group: def.group
	}));
}

/** What a placed part is: an auth widget by its method ("Passkey"), others by their kind. */
export function roleOf(part: LayoutPart, settings: PartSettings | undefined): string {
	return part.kind === 'auth_widget' && settings
		? methodName(settings.method)
		: partName(part.kind);
}

/** The id of a part's text in the translations: the label by the part's id, others after a dot. */
export const textId = {
	label: (partId: string) => partId,
	text: (partId: string) => `${partId}.text`,
	placeholder: (partId: string) => `${partId}.placeholder`,
	helpText: (partId: string) => `${partId}.helpText`,
	option: (partId: string, value: string) => `${partId}.option.${value}`
};

/** Every text of the page to translate: labels, and the other texts a part has. */
export function translationRows(
	rows: readonly LayoutRow[],
	settings: Readonly<Record<string, PartSettings>>
): TranslationRow[] {
	return rows.flatMap((row) =>
		row.columns.flat().flatMap((part) => {
			const extra = settings[part.id];
			const name = roleOf(part, extra);
			/** "Input field · Placeholder": which text of the part this is. */
			const of = (what: string) => `${name} · ${what}`;
			const texts: TranslationRow[] = [];
			if (part.label) texts.push({ id: textId.label(part.id), label: name, source: part.label });
			// A divider's words are its label (one text, one row).
			if (extra?.text && part.kind !== 'divider') {
				texts.push({ id: textId.text(part.id), label: of(setting('body')), source: extra.text });
			}
			if (extra?.placeholder) {
				texts.push({
					id: textId.placeholder(part.id),
					label: of(setting('placeholder')),
					source: extra.placeholder
				});
			}
			if (extra?.helpText) {
				texts.push({
					id: textId.helpText(part.id),
					label: of(setting('helpText')),
					source: extra.helpText
				});
			}
			// A linked part's choices are translated on the schema, with the values they label.
			if (extra && !extra.linked && CHOICE_KINDS.has(part.kind)) {
				for (const option of extra.options) {
					if (!option.label) continue;
					texts.push({
						id: textId.option(part.id, option.value),
						label: of(t('options.legend')),
						source: option.label
					});
				}
			}
			return texts;
		})
	);
}

/**
 * The settings a new part starts with. Inputs always use an Identity Schema attribute. When
 * none fits yet, the attribute stays empty until the admin chooses or creates one.
 */
export function newPartSettings(kind: string, schemaFields: readonly SchemaField[]): PartSettings {
	if (!INPUT_KINDS.has(kind)) return defaultSettings({ field: '' });
	const fitting = schemaFields.find((field) => fieldFits(kind, field));
	return defaultSettings({ field: fitting?.key ?? '' });
}
