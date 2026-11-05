/**
 * The palettes a sign-in screen can use: the colours it falls back to and the shape of its form
 * area (corner radius, shadow, frosted glass). A palette is data: it combines freely with any
 * template, and adding one is one entry in `THEME_PALETTES` (plus its two labels in the
 * messages, `th.palette.<id>` and `th.palette.<id>.d`).
 *
 * Mirrors the Login UI's own registry (`ar-login-ui/src/lib/palettes.ts`): an id here must be a
 * palette it knows, or the real screens fall back to the default.
 */

export type PaletteId = 'meridian' | 'classic' | 'glass' | 'flat';

/** The colours that apply while a colour field is empty (the fields show these). */
export interface PaletteColours {
	background: string;
	card: string;
	accent: string;
	title: string;
	text: string;
	copy: string;
}

export type PaletteShadow = 'none' | 'soft' | 'deep';

/** How the form area is shaped. */
export interface PaletteShape {
	/** Corner radius of the form area, in px. */
	cardRadius: number;
	/** Corner radius of buttons and fields, in px. */
	controlRadius: number;
	shadow: PaletteShadow;
	/** The form area is frosted glass over the page (best with a background picture). */
	frost: boolean;
}

export interface ThemePalette {
	id: PaletteId;
	light: PaletteColours;
	dark: PaletteColours;
	shape: PaletteShape;
}

export const DEFAULT_PALETTE: PaletteId = 'meridian';

export const THEME_PALETTES: readonly ThemePalette[] = [
	{
		id: 'meridian',
		light: {
			background: '#eef1f6',
			card: '#ffffff',
			accent: '#2f52c4',
			title: '#182238',
			text: '#182238',
			copy: '#55617c'
		},
		dark: {
			background: '#0b0e16',
			card: '#131a2a',
			accent: '#93aef2',
			title: '#eef2fa',
			text: '#eef2fa',
			copy: '#aeb9d0'
		},
		shape: { cardRadius: 20, controlRadius: 12, shadow: 'soft', frost: false }
	},
	{
		id: 'classic',
		light: {
			background: '#eeeae3',
			card: '#fefdfa',
			accent: '#2c2724',
			title: '#333333',
			text: '#333333',
			copy: '#4d4d4d'
		},
		dark: {
			background: '#0f0d0c',
			card: '#2d2824',
			accent: '#c8b8a8',
			title: '#f5f3f0',
			text: '#f5f3f0',
			copy: '#d4cfc8'
		},
		shape: { cardRadius: 16, controlRadius: 10, shadow: 'soft', frost: false }
	},
	{
		id: 'glass',
		light: {
			background: '#ecdfd3',
			card: '#fffdfa',
			accent: '#b0301b',
			title: '#221b17',
			text: '#221b17',
			copy: '#5c524c'
		},
		dark: {
			background: '#0d0908',
			card: '#0e0a09',
			accent: '#e8623f',
			title: '#f6efe9',
			text: '#f6efe9',
			copy: '#cfc3ba'
		},
		shape: { cardRadius: 0, controlRadius: 0, shadow: 'deep', frost: true }
	},
	{
		id: 'flat',
		light: {
			background: '#ffffff',
			card: '#ffffff',
			accent: '#2f52c4',
			title: '#111827',
			text: '#374151',
			copy: '#6b7280'
		},
		dark: {
			background: '#0a0a0b',
			card: '#0a0a0b',
			accent: '#93aef2',
			title: '#f4f4f5',
			text: '#d4d4d8',
			copy: '#a1a1aa'
		},
		shape: { cardRadius: 8, controlRadius: 8, shadow: 'none', frost: false }
	}
];

export const PALETTE_IDS: readonly PaletteId[] = THEME_PALETTES.map((palette) => palette.id);

/** The palette with this id; an unknown one is the default (as the real screens do). */
export function paletteOf(id: string): ThemePalette {
	return (
		THEME_PALETTES.find((palette) => palette.id === id) ??
		THEME_PALETTES.find((palette) => palette.id === DEFAULT_PALETTE)!
	);
}

/** The colours that apply in this colour scheme while a field is empty. */
export function paletteColours(id: string, scheme: 'light' | 'dark'): PaletteColours {
	return paletteOf(id)[scheme];
}
