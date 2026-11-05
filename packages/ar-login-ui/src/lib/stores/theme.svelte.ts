/**
 * Theme Store - Manages the Login UI's light / dark mode
 *
 * Features:
 * - Light/Dark mode toggle
 * - localStorage persistence
 * - SSR-safe initialization
 * - Tenant theme default (from authentication methods API)
 *
 * Mode Resolution Order:
 * 1. User local preference (localStorage), unless the tenant fixed the mode
 * 2. Tenant theme (authentication methods API -> ui.theme); `auto` names no mode
 * 3. System preference (prefers-color-scheme)
 *
 * A fixed mode (ui.themeFixed, light or dark only) is the tenant's default for every visitor: a
 * saved preference is ignored and the mode cannot be switched. `auto` cannot be fixed.
 *
 * The colours come from the theme template (`data-login-theme`) and the mode; there are no
 * colour variants any more.
 */

import { browser } from '$app/env';
import {
	LOGIN_UI_THEME_HINT_COOKIE,
	LOGIN_UI_THEME_HINT_MAX_AGE_SECONDS
} from '#lib/theme-bootstrap.js';
import { syncLoginUIDocumentSurface } from '#lib/document-surface.js';

// Theme types
export type ThemeMode = 'light' | 'dark';

// Storage keys
const STORAGE_KEY_THEME = 'authrim-theme';
const PERSISTED_THEME_HINT_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

function getSavedTheme(): ThemeMode | null {
	if (!browser) return null;
	const saved = localStorage.getItem(STORAGE_KEY_THEME);
	return saved === 'light' || saved === 'dark' ? saved : null;
}

// Detect system preference
function getSystemTheme(): ThemeMode {
	if (!browser) return 'light';
	return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function getCookieAttributes(maxAgeSeconds: number): string {
	const secure = window.location.protocol === 'https:' ? '; Secure' : '';
	return `Path=/; Max-Age=${maxAgeSeconds}; SameSite=Lax${secure}`;
}

function setThemeHintCookie(name: string, value: string, maxAgeSeconds: number): void {
	document.cookie = `${name}=${encodeURIComponent(value)}; ${getCookieAttributes(maxAgeSeconds)}`;
}

// Create reactive state
export function createThemeStore() {
	// Initialize state with system preference as default
	let mode = $state<ThemeMode>(getSystemTheme());
	let isInitialized = $state(false);

	// Tenant default (set from authentication methods API)
	let tenantMode: ThemeMode | null = null;
	let fixed = $state(false);

	/** The visitor's saved choice; none while the tenant has fixed the mode. */
	function visitorPreference(): ThemeMode | null {
		return fixed ? null : getSavedTheme();
	}

	function applyTenantDefaultIfNeeded() {
		if (!browser || !isInitialized) return;
		const wanted = visitorPreference() ?? tenantMode ?? getSystemTheme();
		if (mode !== wanted) {
			mode = wanted;
			applyTheme();
		}
	}

	/**
	 * Set the tenant's theme mode from the authentication methods API response, used when the
	 * user has no localStorage preference. Call this before init() for correct resolution order.
	 */
	function setTenantDefaults(themeMode?: string | null, themeFixed = false) {
		// Only a light or dark mode can be fixed; with `auto` the device decides.
		fixed = themeFixed === true && (themeMode === 'light' || themeMode === 'dark');
		if (themeMode === 'light' || themeMode === 'dark') {
			tenantMode = themeMode;
			if (!isInitialized) {
				mode = themeMode;
			}
		} else {
			// `auto` (or anything else) names no mode: the visitor's system setting decides.
			tenantMode = null;
		}
		applyTenantDefaultIfNeeded();
	}

	/**
	 * Open in the mode the visitor's last page resolved to, for a tenant that names no mode
	 * (`auto`) and has not fixed it. Server and browser both call this with the same hint, so the
	 * first render matches; `init()` then resolves the real mode (saved choice, else system).
	 */
	function primeFromHint(hint?: string | null) {
		if (isInitialized || fixed || tenantMode) return;
		if (hint === 'light' || hint === 'dark') mode = hint;
	}

	// Initialize from localStorage (browser only)
	// Resolution order: localStorage → tenant → system
	function init() {
		if (!browser) return;
		mode = visitorPreference() ?? tenantMode ?? getSystemTheme();
		applyTheme();
		isInitialized = true;
	}

	// Apply theme to document element
	function applyTheme() {
		if (!browser) return;

		document.documentElement.setAttribute('data-theme', mode);
		syncLoginUIDocumentSurface();
		setThemeHintCookie(LOGIN_UI_THEME_HINT_COOKIE, mode, LOGIN_UI_THEME_HINT_MAX_AGE_SECONDS);
	}

	// Save to localStorage
	function persist() {
		if (!browser) return;

		localStorage.setItem(STORAGE_KEY_THEME, mode);
		setThemeHintCookie(LOGIN_UI_THEME_HINT_COOKIE, mode, PERSISTED_THEME_HINT_MAX_AGE_SECONDS);
	}

	// Toggle between light and dark mode
	function toggleMode() {
		if (fixed) return;
		mode = mode === 'light' ? 'dark' : 'light';
		applyTheme();
		persist();
	}

	// Set specific theme mode
	function setMode(newMode: ThemeMode) {
		if (fixed) return;
		mode = newMode;
		applyTheme();
		persist();
	}

	return {
		// Getters
		get mode() {
			return mode;
		},
		get isInitialized() {
			return isInitialized;
		},
		/** The tenant fixed the mode: the visitor cannot change it. */
		get isFixed() {
			return fixed;
		},
		get isDark() {
			return mode === 'dark';
		},
		get isLight() {
			return mode === 'light';
		},

		// Methods
		init,
		primeFromHint,
		setTenantDefaults,
		toggleMode,
		setMode
	};
}
