import type { ScreenInput, ScreenKind, ScreenListItem } from '#lib/api/screens.js';
import type { BrowserItem } from '#lib/ui/patterns/ColumnBrowser.svelte';

export type ScreenCategory = 'registration' | 'login' | 'account' | 'consent' | 'other';

export const SCREEN_CATEGORIES: readonly ScreenCategory[] = [
	'registration',
	'login',
	'account',
	'consent',
	'other'
];

export interface ScreenTemplate extends BrowserItem {
	groupId: ScreenCategory;
	kind: ScreenKind;
	source: ScreenListItem | null;
}

export function screenCategory(kind: ScreenKind): ScreenCategory {
	switch (kind) {
		case 'registration':
		case 'profile_completion':
			return 'registration';
		case 'login':
		case 'code_input':
			return 'login';
		case 'account':
			return 'account';
		case 'consent':
			return 'consent';
		case 'custom':
			return 'other';
	}
}

const BLANK_KIND: Record<ScreenCategory, ScreenKind> = {
	registration: 'registration',
	login: 'login',
	account: 'account',
	consent: 'consent',
	other: 'custom'
};

/** The catalogue uses saved system screens. A category without one gets a valid starter. */
export function screenTemplates(
	screens: readonly ScreenListItem[],
	blankLabel: string
): ScreenTemplate[] {
	const presets: ScreenTemplate[] = screens
		.filter((screen) => screen.is_system && screen.fields.length > 0)
		.map((screen) => ({
			id: screen.id,
			groupId: screenCategory(screen.screen_kind),
			label: screen.display_name,
			kind: screen.screen_kind,
			source: screen
		}));
	return SCREEN_CATEGORIES.flatMap((category) => {
		const inCategory = presets.filter((item) => item.groupId === category);
		return inCategory.length
			? inCategory
			: [
					{
						id: `blank:${category}`,
						groupId: category,
						label: blankLabel,
						kind: BLANK_KIND[category],
						source: null
					}
				];
	});
}

export const screenKeyIsValid = (key: string) => /^[a-z0-9_-]{1,96}$/u.test(key.trim());

/** The copy's fields and translations are independent of its source. */
export function screenInputFromTemplate(
	template: ScreenTemplate,
	basics: { name: string; key: string; description: string }
): ScreenInput {
	const source = template.source;
	const name = basics.name.trim();
	const localizations = source ? structuredClone(source.localizations) : {};
	// The new name and description are entered in step 2; inherited translations would still
	// describe the source screen. Keep translations of the actual parts.
	for (const localization of Object.values(localizations)) {
		delete localization.display_name;
		delete localization.description;
	}
	return {
		display_name: name,
		screen_key: basics.key.trim(),
		description: basics.description.trim() || null,
		screen_kind: template.kind,
		fields: source
			? structuredClone(source.fields)
			: [
					{ field: 'title', label: name, required: false, block_type: 'heading', block_id: 'title' }
				],
		localizations,
		settings: source
			? {
					...structuredClone(source.settings),
					base_preset_key: source.screen_key,
					base_preset_version: 1
				}
			: { canvas_layout: 'narrow' },
		is_active: true
	};
}
