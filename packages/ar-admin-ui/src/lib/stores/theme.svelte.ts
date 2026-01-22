/**
 * Theme Store - Manages Admin UI theme state
 *
 * Features:
 * - Light/Dark mode toggle
 * - 6 variant options (3 light, 3 dark)
 * - localStorage persistence
 * - SSR-safe initialization
 */

import { browser } from '$app/environment';

// Theme types
export type ThemeMode = 'light' | 'dark';
export type LightVariant = 'beige' | 'blue-gray' | 'green';
export type DarkVariant = 'brown' | 'navy' | 'slate';
export type ThemeVariant = LightVariant | DarkVariant;

// Light variants with their colors for UI display
export const LIGHT_VARIANTS: { id: LightVariant; name: string; color: string }[] = [
	{ id: 'beige', name: 'Warm Beige', color: '#EEEAE3' },
	{ id: 'blue-gray', name: 'Blue Gray', color: '#E8EDF2' },
	{ id: 'green', name: 'Fresh Green', color: '#E8F2E8' }
];

// Dark variants with their colors for UI display
export const DARK_VARIANTS: { id: DarkVariant; name: string; color: string }[] = [
	{ id: 'brown', name: 'Dark Brown', color: '#1E1B19' },
	{ id: 'navy', name: 'Navy Blue', color: '#1C2530' },
	{ id: 'slate', name: 'Slate Gray', color: '#262A30' }
];

// Storage keys
const STORAGE_KEY_THEME = 'authrim-theme';
const STORAGE_KEY_LIGHT_VARIANT = 'authrim-light-variant';
const STORAGE_KEY_DARK_VARIANT = 'authrim-dark-variant';

// Default values
const DEFAULT_THEME: ThemeMode = 'light';
const DEFAULT_LIGHT_VARIANT: LightVariant = 'beige';
const DEFAULT_DARK_VARIANT: DarkVariant = 'brown';

// Create reactive state
function createThemeStore() {
	// Initialize state with defaults
	let mode = $state<ThemeMode>(DEFAULT_THEME);
	let lightVariant = $state<LightVariant>(DEFAULT_LIGHT_VARIANT);
	let darkVariant = $state<DarkVariant>(DEFAULT_DARK_VARIANT);
	let isInitialized = $state(false);

	// Get the current variant based on mode
	const currentVariant = $derived(mode === 'light' ? lightVariant : darkVariant);

	// Initialize from localStorage (browser only)
	function init() {
		if (!browser) return;

		const savedTheme = localStorage.getItem(STORAGE_KEY_THEME) as ThemeMode | null;
		const savedLightVariant = localStorage.getItem(
			STORAGE_KEY_LIGHT_VARIANT
		) as LightVariant | null;
		const savedDarkVariant = localStorage.getItem(STORAGE_KEY_DARK_VARIANT) as DarkVariant | null;

		// Validate and apply saved values
		if (savedTheme === 'light' || savedTheme === 'dark') {
			mode = savedTheme;
		}

		if (savedLightVariant && LIGHT_VARIANTS.some((v) => v.id === savedLightVariant)) {
			lightVariant = savedLightVariant;
		}

		if (savedDarkVariant && DARK_VARIANTS.some((v) => v.id === savedDarkVariant)) {
			darkVariant = savedDarkVariant;
		}

		// Apply theme to document
		applyTheme();
		isInitialized = true;
	}

	// Apply theme to document element
	function applyTheme() {
		if (!browser) return;

		const html = document.documentElement;
		html.setAttribute('data-theme', mode);
		html.setAttribute('data-variant', currentVariant);
	}

	// Save to localStorage
	function persist() {
		if (!browser) return;

		localStorage.setItem(STORAGE_KEY_THEME, mode);
		localStorage.setItem(STORAGE_KEY_LIGHT_VARIANT, lightVariant);
		localStorage.setItem(STORAGE_KEY_DARK_VARIANT, darkVariant);
	}

	// Toggle between light and dark mode
	function toggleMode() {
		mode = mode === 'light' ? 'dark' : 'light';
		applyTheme();
		persist();
	}

	// Set specific theme mode
	function setMode(newMode: ThemeMode) {
		mode = newMode;
		applyTheme();
		persist();
	}

	// Set light variant
	function setLightVariant(variant: LightVariant) {
		if (!LIGHT_VARIANTS.some((v) => v.id === variant)) return;
		lightVariant = variant;
		if (mode === 'light') {
			applyTheme();
		}
		persist();
	}

	// Set dark variant
	function setDarkVariant(variant: DarkVariant) {
		if (!DARK_VARIANTS.some((v) => v.id === variant)) return;
		darkVariant = variant;
		if (mode === 'dark') {
			applyTheme();
		}
		persist();
	}

	// Set theme and variant at once
	function setTheme(newMode: ThemeMode, variant?: ThemeVariant) {
		mode = newMode;
		if (variant) {
			if (newMode === 'light' && LIGHT_VARIANTS.some((v) => v.id === variant)) {
				lightVariant = variant as LightVariant;
			} else if (newMode === 'dark' && DARK_VARIANTS.some((v) => v.id === variant)) {
				darkVariant = variant as DarkVariant;
			}
		}
		applyTheme();
		persist();
	}

	return {
		// Getters
		get mode() {
			return mode;
		},
		get lightVariant() {
			return lightVariant;
		},
		get darkVariant() {
			return darkVariant;
		},
		get currentVariant() {
			return currentVariant;
		},
		get isInitialized() {
			return isInitialized;
		},
		get isDark() {
			return mode === 'dark';
		},
		get isLight() {
			return mode === 'light';
		},

		// Methods
		init,
		toggleMode,
		setMode,
		setLightVariant,
		setDarkVariant,
		setTheme
	};
}

// Export singleton instance
export const themeStore = createThemeStore();
