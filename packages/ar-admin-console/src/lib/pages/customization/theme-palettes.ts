/**
 * The palettes a sign-in screen can use: the colours it falls back to and the shape of its form
 * area (corner radius, shadow, frosted glass). A palette is data: it combines freely with any
 * template, and adding one is one entry in `THEME_PALETTES` (plus its two labels in the
 * messages, `th.palette.<id>` and `th.palette.<id>.d`).
 *
 * Mirrors the Login UI's own registry (`ar-login-ui/src/lib/palettes.ts`): an id here must be a
 * palette it knows, or the real screens fall back to the default.
 */

export type PaletteId = 'meridian' | 'classic' | 'swiss-grid' | 'glass' | 'clear-glass' | 'flat';

/** The colours that apply while a colour field is empty (the fields show these). */
export interface PaletteColours {
	background: string;
	card: string;
	accent: string;
	title: string;
	text: string;
	copy: string;
}

/**
 * How the form area is lifted: not at all, a soft shadow, a 1px ring in ink (Swiss Grid draws
 * rings in place of shadows), frosted glass (a light rim and a soft shadow), or clear glass (an
 * iridescent rim, a reflection and a halo).
 */
export type PaletteShadow = 'none' | 'soft' | 'ring' | 'glass' | 'clear';

/** How the form area is shaped. */
export interface PaletteShape {
	/** Corner radius of the form area, in px. */
	cardRadius: number;
	/** Corner radius of buttons and fields, in px. */
	controlRadius: number;
	/** Corner radius of buttons, when they differ from fields (Clear glass buttons are pills). */
	buttonRadius?: number;
	/** Corner radius of fields, when it differs from the rest. */
	fieldRadius?: number;
	shadow: PaletteShadow;
	/** The form area is blurred, translucent glass over the page. */
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
		id: 'swiss-grid',
		light: {
			background: '#f6f5f1',
			card: '#f6f5f1',
			accent: '#141412',
			title: '#141412',
			text: '#141412',
			copy: '#4f4e4a'
		},
		dark: {
			background: '#121210',
			card: '#181816',
			accent: '#e9e7e0',
			title: '#e9e7e0',
			text: '#e9e7e0',
			copy: '#bdbbb4'
		},
		shape: { cardRadius: 0, controlRadius: 0, shadow: 'ring', frost: false }
	},
	{
		id: 'glass',
		// Frosted glass. The form area is a translucent pane: its colour carries an alpha (#rrggbbaa),
		// which the admin can change, or replace with a colour of their own, in the Design tab.
		light: {
			background: '#e9ecf2',
			card: '#ffffff61',
			accent: '#3a5cb8',
			title: '#1c1e24',
			text: '#1c1e24',
			copy: '#444955'
		},
		dark: {
			background: '#14161b',
			card: '#ffffff12',
			accent: '#a4bdf2',
			title: '#f2f3f6',
			text: '#f2f3f6',
			copy: '#c9ccd4'
		},
		shape: {
			cardRadius: 20,
			controlRadius: 14,
			fieldRadius: 12,
			shadow: 'glass',
			frost: true
		}
	},
	{
		id: 'clear-glass',
		// Clear glass: nearly clear (a low alpha), seen by its rim and its reflection.
		light: {
			background: '#dce3e9',
			card: '#ffffff1a',
			accent: '#284f97',
			title: '#15191f',
			text: '#15191f',
			copy: '#3a4049'
		},
		dark: {
			background: '#111419',
			card: '#ffffff08',
			accent: '#9dbcf0',
			title: '#eef1f5',
			text: '#eef1f5',
			copy: '#c9ced6'
		},
		shape: {
			cardRadius: 24,
			controlRadius: 16,
			buttonRadius: 999,
			fieldRadius: 999,
			shadow: 'clear',
			frost: true
		}
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
