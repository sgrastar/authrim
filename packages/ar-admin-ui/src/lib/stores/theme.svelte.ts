/**
 * Theme Store - Manages Admin UI theme state
 *
 * Features:
 * - Light/Dark mode toggle
 * - 4 Admin UI skins, each with light/dark tokens
 * - localStorage persistence
 * - SSR-safe initialization
 */

import { browser } from '$app/environment';

// Theme types
export type ThemeMode = 'light' | 'dark';
export type AdminSkin = 'classic' | 'admin' | 'paper-beige' | 'frosted';

type ThemeOption = {
	id: AdminSkin;
};

export const ADMIN_SKINS: ThemeOption[] = [
	{
		id: 'classic'
	},
	{
		id: 'admin'
	},
	{
		id: 'paper-beige'
	},
	{
		id: 'frosted'
	}
];

// Storage keys
const STORAGE_KEY_THEME = 'authrim-admin-color-scheme';
const STORAGE_KEY_SKIN = 'authrim-admin-skin';

// Legacy storage keys read once during migration.
const LEGACY_STORAGE_KEY_THEME = 'authrim-theme';
const LEGACY_STORAGE_KEY_LIGHT_VARIANT = 'authrim-light-variant';
const LEGACY_STORAGE_KEY_DARK_VARIANT = 'authrim-dark-variant';

// Default values
const DEFAULT_THEME: ThemeMode = 'light';
const DEFAULT_SKIN: AdminSkin = 'classic';
const THEME_TRANSITION_DURATION_MS = 2460;
const THEME_TRANSITION_CLASSES = [
	'theme-transitioning',
	'theme-transition-to-dark',
	'theme-transition-to-light'
] as const;

function isThemeMode(value: string | null): value is ThemeMode {
	return value === 'light' || value === 'dark';
}

function isAdminSkin(value: string | null): value is AdminSkin {
	return ADMIN_SKINS.some((skin) => skin.id === value);
}

function normalizeAdminSkin(value: string | null): AdminSkin | null {
	if (value === 'swiss-grid') return 'admin';
	return isAdminSkin(value) ? value : null;
}

// Create reactive state
function createThemeStore() {
	// Initialize state with defaults
	let mode = $state<ThemeMode>(DEFAULT_THEME);
	let skin = $state<AdminSkin>(DEFAULT_SKIN);
	let isInitialized = $state(false);
	let themeTransitionCleanupTimer: number | null = null;

	const currentSkin = $derived(skin);
	const currentSkinOption = $derived(
		ADMIN_SKINS.find((option) => option.id === skin) ?? ADMIN_SKINS[0]
	);

	// Initialize from localStorage (browser only)
	function init() {
		if (!browser) return;

		const savedTheme =
			localStorage.getItem(STORAGE_KEY_THEME) ?? localStorage.getItem(LEGACY_STORAGE_KEY_THEME);
		const savedSkin = normalizeAdminSkin(localStorage.getItem(STORAGE_KEY_SKIN));

		// Validate and apply saved values
		if (isThemeMode(savedTheme)) {
			mode = savedTheme;
		}

		if (savedSkin) {
			skin = savedSkin;
		} else if (
			localStorage.getItem(LEGACY_STORAGE_KEY_LIGHT_VARIANT) ||
			localStorage.getItem(LEGACY_STORAGE_KEY_DARK_VARIANT)
		) {
			skin = DEFAULT_SKIN;
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
		html.setAttribute('data-admin-skin', skin);
		html.removeAttribute('data-variant');
	}

	function clearThemeTransition(root: HTMLElement) {
		root.classList.remove(...THEME_TRANSITION_CLASSES);
	}

	function prefersReducedMotion() {
		return (
			typeof window.matchMedia === 'function' &&
			window.matchMedia('(prefers-reduced-motion: reduce)').matches
		);
	}

	// Save to localStorage
	function persist() {
		if (!browser) return;

		localStorage.setItem(STORAGE_KEY_THEME, mode);
		localStorage.setItem(STORAGE_KEY_SKIN, skin);
	}

	function applyThemeChange(nextMode: ThemeMode, nextSkin: AdminSkin, useTransition: boolean) {
		const previousMode = mode;
		const commit = () => {
			mode = nextMode;
			skin = nextSkin;
			applyTheme();
			persist();
		};

		if (!browser || !isInitialized || !useTransition || previousMode === nextMode) {
			commit();
			return;
		}

		const root = document.documentElement;
		if (themeTransitionCleanupTimer) window.clearTimeout(themeTransitionCleanupTimer);
		clearThemeTransition(root);

		if (prefersReducedMotion()) {
			commit();
			return;
		}

		void root.offsetWidth;
		root.classList.add(
			'theme-transitioning',
			nextMode === 'dark' ? 'theme-transition-to-dark' : 'theme-transition-to-light'
		);

		const applyAfterTransitionFrame = () => commit();
		if (typeof window.requestAnimationFrame === 'function') {
			window.requestAnimationFrame(applyAfterTransitionFrame);
		} else {
			applyAfterTransitionFrame();
		}

		themeTransitionCleanupTimer = window.setTimeout(() => {
			clearThemeTransition(root);
			themeTransitionCleanupTimer = null;
		}, THEME_TRANSITION_DURATION_MS);
	}

	// Toggle between light and dark mode
	function toggleMode() {
		applyThemeChange(mode === 'light' ? 'dark' : 'light', skin, true);
	}

	// Set specific theme mode
	function setMode(newMode: ThemeMode) {
		applyThemeChange(newMode, skin, true);
	}

	function setSkin(newSkin: AdminSkin) {
		if (!isAdminSkin(newSkin)) return;
		applyThemeChange(mode, newSkin, false);
	}

	function setTheme(newMode: ThemeMode, newSkin?: AdminSkin) {
		applyThemeChange(newMode, newSkin && isAdminSkin(newSkin) ? newSkin : skin, true);
	}

	return {
		// Getters
		get mode() {
			return mode;
		},
		get skin() {
			return skin;
		},
		get currentSkin() {
			return currentSkin;
		},
		get currentSkinOption() {
			return currentSkinOption;
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
		setSkin,
		setTheme
	};
}

// Export singleton instance
export const themeStore = createThemeStore();
