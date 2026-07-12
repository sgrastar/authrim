/**
 * Theme Store - Manages Login UI theme state
 *
 * Features:
 * - Light/Dark mode toggle
 * - 6 variant options (3 light, 3 dark)
 * - localStorage persistence
 * - SSR-safe initialization
 * - Tenant theme defaults (from authentication methods API)
 *
 * Theme Resolution Order:
 * 1. User local preference (localStorage)
 * 2. Tenant theme (authentication methods API -> ui.theme/ui.variant)
 * 3. System preference (prefers-color-scheme)
 * 4. Default: light / beige
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
const DEFAULT_LIGHT_VARIANT: LightVariant = 'beige';
const DEFAULT_DARK_VARIANT: DarkVariant = 'brown';

function getSavedPreferences() {
	if (!browser) {
		return {
			savedTheme: null as ThemeMode | null,
			savedLightVariant: null as LightVariant | null,
			savedDarkVariant: null as DarkVariant | null
		};
	}

	return {
		savedTheme: localStorage.getItem(STORAGE_KEY_THEME) as ThemeMode | null,
		savedLightVariant: localStorage.getItem(STORAGE_KEY_LIGHT_VARIANT) as LightVariant | null,
		savedDarkVariant: localStorage.getItem(STORAGE_KEY_DARK_VARIANT) as DarkVariant | null
	};
}

// Detect system preference
function getSystemTheme(): ThemeMode {
	if (!browser) return 'light';
	return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

// Create reactive state
export function createThemeStore() {
	// Initialize state with system preference as default
	let mode = $state<ThemeMode>(getSystemTheme());
	let lightVariant = $state<LightVariant>(DEFAULT_LIGHT_VARIANT);
	let darkVariant = $state<DarkVariant>(DEFAULT_DARK_VARIANT);
	let isInitialized = $state(false);

	// Get the current variant based on mode
	const currentVariant = $derived(mode === 'light' ? lightVariant : darkVariant);

	// Tenant defaults (set from authentication methods API)
	let tenantMode: ThemeMode | null = null;
	let tenantLightVariant: LightVariant | null = null;
	let tenantDarkVariant: DarkVariant | null = null;

	function applyTenantDefaultsIfNeeded() {
		if (!browser || !isInitialized) return;

		const { savedTheme, savedLightVariant, savedDarkVariant } = getSavedPreferences();
		let changed = false;

		if (savedTheme !== 'light' && savedTheme !== 'dark' && tenantMode && mode !== tenantMode) {
			mode = tenantMode;
			changed = true;
		}

		if (
			(!savedLightVariant || !LIGHT_VARIANTS.some((v) => v.id === savedLightVariant)) &&
			tenantLightVariant &&
			lightVariant !== tenantLightVariant
		) {
			lightVariant = tenantLightVariant;
			changed = true;
		}

		if (
			(!savedDarkVariant || !DARK_VARIANTS.some((v) => v.id === savedDarkVariant)) &&
			tenantDarkVariant &&
			darkVariant !== tenantDarkVariant
		) {
			darkVariant = tenantDarkVariant;
			changed = true;
		}

		if (changed) {
			applyTheme();
		}
	}

	/**
	 * Set tenant theme defaults from the authentication methods API response.
	 * These are used as fallback when the user has no localStorage preference.
	 * Call this before init() for correct resolution order.
	 */
	function setTenantDefaults(themeMode?: string | null, variant?: string | null) {
		if (themeMode === 'light' || themeMode === 'dark') {
			tenantMode = themeMode;
			if (!isInitialized) {
				mode = themeMode;
			}
		}
		if (variant) {
			if (LIGHT_VARIANTS.some((v) => v.id === variant)) {
				tenantLightVariant = variant as LightVariant;
				if (!isInitialized) {
					lightVariant = variant as LightVariant;
				}
			}
			if (DARK_VARIANTS.some((v) => v.id === variant)) {
				tenantDarkVariant = variant as DarkVariant;
				if (!isInitialized) {
					darkVariant = variant as DarkVariant;
				}
			}
		}

		applyTenantDefaultsIfNeeded();
	}

	// Initialize from localStorage (browser only)
	// Resolution order: localStorage → tenant → system → default
	function init() {
		if (!browser) return;

		const { savedTheme, savedLightVariant, savedDarkVariant } = getSavedPreferences();

		// Mode: localStorage → tenant → system
		if (savedTheme === 'light' || savedTheme === 'dark') {
			mode = savedTheme;
		} else if (tenantMode) {
			mode = tenantMode;
		} else {
			mode = getSystemTheme();
		}

		// Light variant: localStorage → tenant → default
		if (savedLightVariant && LIGHT_VARIANTS.some((v) => v.id === savedLightVariant)) {
			lightVariant = savedLightVariant;
		} else if (tenantLightVariant) {
			lightVariant = tenantLightVariant;
		}

		// Dark variant: localStorage → tenant → default
		if (savedDarkVariant && DARK_VARIANTS.some((v) => v.id === savedDarkVariant)) {
			darkVariant = savedDarkVariant;
		} else if (tenantDarkVariant) {
			darkVariant = tenantDarkVariant;
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
		setTenantDefaults,
		toggleMode,
		setMode,
		setLightVariant,
		setDarkVariant,
		setTheme
	};
}
