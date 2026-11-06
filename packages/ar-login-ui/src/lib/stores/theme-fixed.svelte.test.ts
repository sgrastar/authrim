// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$app/env', () => ({ browser: true }));

function stubSystemTheme(dark: boolean) {
	vi.stubGlobal(
		'matchMedia',
		vi
			.fn()
			.mockReturnValue({ matches: dark, addEventListener: vi.fn(), removeEventListener: vi.fn() })
	);
}

async function createStore() {
	const { createThemeStore } = await import('./theme.svelte');
	return createThemeStore();
}

describe('theme store with a fixed mode', () => {
	beforeEach(() => {
		localStorage.clear();
		stubSystemTheme(false);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('uses the visitor’s saved mode when the tenant has not fixed it', async () => {
		localStorage.setItem('authrim-theme', 'dark');
		const themeStore = await createStore();

		themeStore.setTenantDefaults('light', false);
		themeStore.init();

		expect(themeStore.mode).toBe('dark');
		expect(themeStore.isFixed).toBe(false);
	});

	it('ignores the visitor’s saved mode when the tenant has fixed it', async () => {
		localStorage.setItem('authrim-theme', 'dark');
		const themeStore = await createStore();

		themeStore.setTenantDefaults('light', true);
		themeStore.init();

		expect(themeStore.mode).toBe('light');
		expect(themeStore.isFixed).toBe(true);
	});

	it('does not switch, and does not save, while the mode is fixed', async () => {
		const themeStore = await createStore();
		themeStore.setTenantDefaults('light', true);
		themeStore.init();

		themeStore.toggleMode();
		themeStore.setMode('dark');

		expect(themeStore.mode).toBe('light');
		expect(localStorage.getItem('authrim-theme')).toBeNull();
	});

	it('cannot fix auto: the visitor’s saved mode still decides', async () => {
		localStorage.setItem('authrim-theme', 'light');
		stubSystemTheme(true);
		const themeStore = await createStore();

		themeStore.setTenantDefaults('auto', true);
		themeStore.init();

		expect(themeStore.isFixed).toBe(false);
		expect(themeStore.mode).toBe('light');
		themeStore.toggleMode();
		expect(themeStore.mode).toBe('dark');
	});

	it('lets the visitor switch again once the mode is no longer fixed', async () => {
		const themeStore = await createStore();
		themeStore.setTenantDefaults('light', true);
		themeStore.init();
		themeStore.setTenantDefaults('light', false);

		themeStore.toggleMode();

		expect(themeStore.mode).toBe('dark');
		expect(localStorage.getItem('authrim-theme')).toBe('dark');
	});

	it('treats auto as no tenant mode: the saved choice, then the system setting', async () => {
		stubSystemTheme(true);
		const themeStore = await createStore();
		themeStore.setTenantDefaults('auto');
		themeStore.init();
		expect(themeStore.mode).toBe('dark');

		localStorage.setItem('authrim-theme', 'light');
		const saved = await createStore();
		saved.setTenantDefaults('auto');
		saved.init();
		expect(saved.mode).toBe('light');
	});

	it('returns to the system setting when the tenant mode changes to auto after init', async () => {
		stubSystemTheme(false);
		const themeStore = await createStore();
		themeStore.setTenantDefaults('dark');
		themeStore.init();
		expect(themeStore.mode).toBe('dark');

		themeStore.setTenantDefaults('auto');

		expect(themeStore.mode).toBe('light');
	});
});

describe('theme store opening in the last mode', () => {
	beforeEach(() => {
		localStorage.clear();
		stubSystemTheme(false);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('opens in the hinted mode for a tenant that names none, then follows the system', async () => {
		const themeStore = await createStore();
		themeStore.setTenantDefaults('auto');
		themeStore.primeFromHint('dark');
		expect(themeStore.mode).toBe('dark');

		themeStore.init();
		expect(themeStore.mode).toBe('light');
	});

	it('does not use the hint when the tenant names a mode, or fixes it', async () => {
		const named = await createStore();
		named.setTenantDefaults('light');
		named.primeFromHint('dark');
		expect(named.mode).toBe('light');

		const fixed = await createStore();
		fixed.setTenantDefaults('light', true);
		fixed.primeFromHint('dark');
		expect(fixed.mode).toBe('light');
	});

	it('ignores a hint that is not a mode, and one that comes after init', async () => {
		const themeStore = await createStore();
		themeStore.setTenantDefaults('auto');
		themeStore.primeFromHint('sepia');
		themeStore.primeFromHint(null);
		expect(themeStore.mode).toBe('light');

		themeStore.init();
		themeStore.primeFromHint('dark');
		expect(themeStore.mode).toBe('light');
	});
});
