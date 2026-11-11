import type { ScreenField, ScreenKind, ScreenListItem } from '#lib/api/screens.js';
import { t } from '#lib/i18n/i18n.svelte.js';
import { kindOfField } from '#lib/pages/customization/screens/screen-layout.js';
import { INPUT_KINDS } from '#lib/pages/customization/screens/screen-model.js';

/** One thing a screen asks the person to enter, as the flow's table of it shows it. */
export interface ScreenFieldRow {
	id: string;
	label: string;
	/** The profile attribute it is kept in, or the answer's own key. */
	key: string;
	required: boolean;
	/** Where the answer goes, in the admin's words. */
	target: string;
}

/**
 * What a screen asks for: its input parts (an identity field, a choice, a checkbox), in order. A
 * part never shown (itself hidden, or in a hidden row) asks for nothing.
 */
export function screenFieldRows(fields: readonly ScreenField[]): ScreenFieldRow[] {
	const rows: ScreenFieldRow[] = [];
	let rowHidden = false;
	for (const [index, field] of fields.entries()) {
		if (field.block_type === 'layout_row') {
			rowHidden = field.display_condition?.mode === 'hidden';
			continue;
		}
		if (rowHidden || field.display_condition?.mode === 'hidden') continue;
		if (!INPUT_KINDS.has(kindOfField(field))) continue;
		const onProfile = field.store_to_profile !== false;
		const targets = field.answer_targets?.length ? field.answer_targets : ['flow_event'];
		rows.push({
			id: field.block_id ?? `${field.field}-${index}`,
			label: field.label,
			key: field.field,
			required: field.required === true,
			target: onProfile
				? t('af.fields.profile')
				: targets
						.map((target) => t(target === 'record' ? 'af.fields.record' : 'af.fields.answer'))
						.join('・')
		});
	}
	return rows;
}

/**
 * The screens a flow step can show, of the kinds given: not the built-in templates (`…_template`),
 * which are copied to make a screen and are shown by no flow.
 */
export function offeredScreens(
	screens: readonly ScreenListItem[],
	kinds: readonly ScreenKind[]
): ScreenListItem[] {
	return screens.filter(
		(screen) =>
			kinds.includes(screen.screen_kind) &&
			!(screen.is_system && screen.screen_key.endsWith('_template'))
	);
}

/**
 * The screen a step goes on with once the screens are read: the one chosen while it is still
 * there; else, when there is just one to choose, that one; else none (to be chosen). `undefined`:
 * nothing to change.
 */
export function settledScreen(
	value: string,
	offered: readonly ScreenListItem[]
): string | undefined {
	if (value && offered.some((screen) => screen.screen_key === value)) return undefined;
	const only = offered.length === 1 ? offered[0].screen_key : '';
	return only === value ? undefined : only;
}
