import { hasMessage, t } from '#lib/i18n/i18n.svelte.js';
import type { PickerGroup } from '#lib/ui/patterns/PickerDialog.svelte';

/**
 * Background pictures that ship with the console, one folder per category
 * (`bg-presets/<category>/<name>.webp`). Vite fingerprints each file and gives its URL.
 * Choosing one fetches it and hands it over as a File, so it is uploaded on Save exactly
 * like a picture the admin chose from disk.
 */
const FILES = import.meta.glob<string>('./bg-presets/*/*.webp', {
	eager: true,
	query: '?url',
	import: 'default'
});

/** The categories, in the order they are offered. */
const CATEGORIES = ['nature', 'interiors', 'paper', 'fabric', 'materials'] as const;

export interface BgPreset {
	/** `<category>/<name>`. */
	id: string;
	category: string;
	name: string;
	url: string;
}

export const BG_PRESETS: readonly BgPreset[] = Object.entries(FILES)
	.map(([path, url]) => {
		const [, category, file] = path.match(/^\.\/bg-presets\/([^/]+)\/([^/]+)\.webp$/) ?? [];
		return { id: `${category}/${file}`, category, name: file, url };
	})
	.filter((preset) => preset.category && preset.name)
	.sort((a, b) => a.id.localeCompare(b.id));

const label = (key: string, fallback: string) => (hasMessage(key) ? t(key) : fallback);

/** The presets as picker groups, labelled in the console's language. */
export function bgPresetGroups(): PickerGroup[] {
	const known: readonly string[] = CATEGORIES;
	const extra = [...new Set(BG_PRESETS.map((p) => p.category))].filter((c) => !known.includes(c));
	return [...CATEGORIES, ...extra]
		.map((category) => ({
			id: category,
			label: label(`th.bg.cat.${category}`, category),
			icon: 'folder' as const,
			items: BG_PRESETS.filter((p) => p.category === category).map((p) => ({
				value: p.id,
				label: label(`th.bg.img.${p.name}`, p.name),
				keywords: p.name.replaceAll('-', ' ')
			}))
		}))
		.filter((group) => group.items.length > 0);
}

export const bgPresetUrl = (id: string) => BG_PRESETS.find((p) => p.id === id)?.url;

/** The preset as a File, ready to go through the same upload as a picture from disk. */
export async function bgPresetFile(id: string): Promise<File> {
	const preset = BG_PRESETS.find((p) => p.id === id);
	if (!preset) throw new Error(`Unknown background preset: ${id}`);
	const response = await fetch(preset.url);
	if (!response.ok) throw new Error(`Background preset ${id}: HTTP ${response.status}`);
	const blob = await response.blob();
	return new File([blob], `${preset.name}.webp`, { type: blob.type || 'image/webp' });
}
