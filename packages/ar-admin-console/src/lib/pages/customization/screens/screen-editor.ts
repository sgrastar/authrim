/**
 * What a screen's page holds while it is edited: the screen's basics, its parts in rows with
 * their settings, and its translations. The SaveScope compares it with what was saved, field by
 * field, to mark what changed.
 */
import type { Screen, ScreenKind } from '#lib/api/screens.js';
import type { LayoutRow } from '#lib/ui/builder/layout-model.js';
import type { Translations } from '#lib/ui/builder/TranslationTable.svelte';
import type { BuilderScreen } from './screen-layout';
import type { DisplayCondition, PartSettings } from './screen-model';

export interface EditorValue {
	name: string;
	description: string;
	key: string;
	kind: ScreenKind;
	canvas: 'narrow' | 'wide';
	active: boolean;
	rows: LayoutRow[];
	settings: Record<string, PartSettings>;
	rowSettings: Record<string, DisplayCondition>;
	translations: Translations;
}

/** A new screen: empty, custom, active, narrow. */
export function newScreenValue(): EditorValue {
	return {
		name: '',
		description: '',
		key: '',
		kind: 'custom',
		canvas: 'narrow',
		active: true,
		rows: [],
		settings: {},
		rowSettings: {},
		translations: {}
	};
}

/** A saved screen as the page edits it. */
export function editorValue(
	screen: Screen,
	read: BuilderScreen,
	translations: Translations
): EditorValue {
	return {
		name: screen.display_name,
		description: screen.description ?? '',
		key: screen.screen_key,
		kind: screen.screen_kind,
		canvas: screen.settings.canvas_layout === 'wide' ? 'wide' : 'narrow',
		active: screen.is_active,
		rows: read.rows,
		settings: read.settings,
		rowSettings: read.rowSettings,
		translations
	};
}
