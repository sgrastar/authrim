import { hasMessage, t } from '#lib/i18n/i18n.svelte.js';
import { fetchLoginUiPresets, type LoginUiPreset } from '#lib/api/login-ui-themes.js';
import type { PickerGroup } from '#lib/ui/patterns/PickerDialog.svelte';

/**
 * Background pictures shared by every tenant. The setup tool places them in the public assets
 * (`packages/ar-management/assets/login-ui-presets/backgrounds/<category>/<name>.webp`), and a
 * theme uses one by storing its path: no copy is uploaded, and the picture is the same one for
 * every tenant that picks it.
 */
export type BgPreset = LoginUiPreset;

/** Where the presets come from: the Admin API, or (Storybook) a fixed list. */
export type BgPresetSource = () => Promise<readonly BgPreset[]>;

export const apiBgPresets: BgPresetSource = fetchLoginUiPresets;

/** The categories offered first, in this order; any other category follows. */
const CATEGORIES = ['nature', 'interiors', 'paper', 'fabric', 'materials'];

/** "misty-japanese-forest-deer" → "Misty japanese forest deer", for a name without a message. */
const readable = (name: string) => {
	const words = name.replaceAll('-', ' ');
	return words.charAt(0).toUpperCase() + words.slice(1);
};

const label = (key: string, name: string) => (hasMessage(key) ? t(key) : readable(name));

/** The presets as picker groups, labelled in the console's language. */
export function bgPresetGroups(presets: readonly BgPreset[]): PickerGroup[] {
	const found = [...new Set(presets.map((p) => p.category))];
	const order = [
		...CATEGORIES.filter((c) => found.includes(c)),
		...found.filter((c) => !CATEGORIES.includes(c)).sort()
	];
	return order.map((category) => ({
		id: category,
		label: label(`th.bg.cat.${category}`, category),
		icon: 'folder' as const,
		items: presets
			.filter((p) => p.category === category)
			.map((p) => ({
				value: p.url,
				label: label(`th.bg.img.${p.name}`, p.name),
				keywords: p.name.replaceAll('-', ' ')
			}))
	}));
}
