/**
 * Theme state: brightness mode (system / light / dark) and look (standard / swiss-grid / frosted).
 * The first paint is handled by the boot script in app.html; this store takes over afterwards.
 */
import {
	applyThemeAttributes,
	DEFAULT_LOOK,
	DEFAULT_MODE,
	isThemeLook,
	isThemeMode,
	STORAGE_KEYS,
	type ColorScheme,
	type ThemeLook,
	type ThemeMode
} from './theme-config';

export type { ThemeLook, ThemeMode } from './theme-config';

const DARK_QUERY = '(prefers-color-scheme: dark)';

function readStored(key: string): string | null {
	try {
		return localStorage.getItem(key);
	} catch {
		return null;
	}
}

function writeStored(key: string, value: string): void {
	try {
		localStorage.setItem(key, value);
	} catch {
		// Private mode or blocked storage: the choice lasts for this page only.
	}
}

function systemScheme(): ColorScheme {
	return typeof window !== 'undefined' && window.matchMedia?.(DARK_QUERY).matches
		? 'dark'
		: 'light';
}

function motionReduced(): boolean {
	return (
		typeof window !== 'undefined' &&
		window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
	);
}

let mode = $state<ThemeMode>(DEFAULT_MODE);
let look = $state<ThemeLook>(DEFAULT_LOOK);
let osScheme = $state<ColorScheme>('light');
let washTimer: ReturnType<typeof setTimeout> | undefined;
let started = false;

function resolved(): ColorScheme {
	return mode === 'system' ? osScheme : mode;
}

function apply(): void {
	if (typeof document === 'undefined') return;
	applyThemeAttributes(document.documentElement, mode, resolved(), look);
}

/**
 * Plays the brightness transition on `root`: colour tokens interpolate while a light wash covers
 * the screen once, so elements reaching their final colour at slightly different times read as
 * one change. `change` applies the new scheme. Re-adding the class alone does not restart the
 * animation, so layout is read in between. Exported so Storybook can demonstrate it.
 */
export function playSchemeTransition(root: HTMLElement, to: ColorScheme, change: () => void): void {
	if (motionReduced()) {
		change();
		return;
	}
	root.classList.remove('theme-transitioning', 'theme-to-light');
	void root.offsetWidth;
	root.classList.add('theme-transitioning');
	if (to === 'light') root.classList.add('theme-to-light');
	change();
	clearTimeout(washTimer);
	const duration = parseFloat(getComputedStyle(root).getPropertyValue('--theme-wash')) || 2280;
	washTimer = setTimeout(() => {
		root.classList.remove('theme-transitioning', 'theme-to-light');
	}, duration + 60);
}

function applyWithTransition(before: ColorScheme): void {
	if (typeof document === 'undefined') return;
	const after = resolved();
	if (before === after) apply();
	else playSchemeTransition(document.documentElement, after, apply);
}

export const theme = {
	get mode(): ThemeMode {
		return mode;
	},
	get look(): ThemeLook {
		return look;
	},
	get scheme(): ColorScheme {
		return resolved();
	},

	/** Reads the stored choice and follows OS changes. Safe to call more than once. */
	start(): void {
		if (started || typeof window === 'undefined') return;
		started = true;
		const storedMode = readStored(STORAGE_KEYS.mode);
		const storedLook = readStored(STORAGE_KEYS.look);
		mode = isThemeMode(storedMode) ? storedMode : DEFAULT_MODE;
		look = isThemeLook(storedLook) ? storedLook : DEFAULT_LOOK;
		osScheme = systemScheme();
		window.matchMedia?.(DARK_QUERY).addEventListener('change', (event) => {
			const before = resolved();
			osScheme = event.matches ? 'dark' : 'light';
			applyWithTransition(before);
		});
		apply();
	},

	setMode(next: ThemeMode): void {
		const before = resolved();
		mode = next;
		writeStored(STORAGE_KEYS.mode, next);
		applyWithTransition(before);
	},

	setLook(next: ThemeLook): void {
		look = next;
		writeStored(STORAGE_KEYS.look, next);
		apply();
	}
};
