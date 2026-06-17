// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { adminBrandStore } from './admin-brand.svelte';
import { themeStore } from './theme.svelte';

vi.mock('$app/environment', () => ({
	browser: true,
	building: false,
	dev: true,
	version: 'test'
}));

function clearThemeDomState() {
	document.documentElement.removeAttribute('data-theme');
	document.documentElement.removeAttribute('data-admin-skin');
	document.documentElement.removeAttribute('data-variant');
	document.documentElement.removeAttribute('data-admin-brand');
	document.documentElement.classList.remove(
		'theme-transitioning',
		'theme-transition-to-dark',
		'theme-transition-to-light'
	);
}

describe('themeStore', () => {
	beforeEach(() => {
		localStorage.clear();
		clearThemeDomState();
		themeStore.setTheme('light', 'classic');
		localStorage.clear();
		clearThemeDomState();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
		clearThemeDomState();
	});

	it('initializes the persisted Admin UI skin and color scheme', () => {
		localStorage.setItem('authrim-admin-color-scheme', 'dark');
		localStorage.setItem('authrim-admin-skin', 'paper-beige');
		document.documentElement.setAttribute('data-variant', 'beige');

		themeStore.init();

		expect(themeStore.mode).toBe('dark');
		expect(themeStore.skin).toBe('paper-beige');
		expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
		expect(document.documentElement.getAttribute('data-admin-skin')).toBe('paper-beige');
		expect(document.documentElement.hasAttribute('data-variant')).toBe(false);
	});

	it('normalizes the legacy swiss-grid skin id to the admin skin id', () => {
		localStorage.setItem('authrim-admin-skin', 'swiss-grid');

		themeStore.init();

		expect(themeStore.skin).toBe('admin');
		expect(document.documentElement.getAttribute('data-admin-skin')).toBe('admin');
	});

	it('persists skin and mode changes with Admin UI specific storage keys', () => {
		themeStore.setTheme('dark', 'frosted');

		expect(localStorage.getItem('authrim-admin-color-scheme')).toBe('dark');
		expect(localStorage.getItem('authrim-admin-skin')).toBe('frosted');
		expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
		expect(document.documentElement.getAttribute('data-admin-skin')).toBe('frosted');
	});

	it('runs the setup sky transition when switching between light and dark after initialization', () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
			callback(0);
			return 1;
		});
		vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false }));

		localStorage.setItem('authrim-admin-color-scheme', 'light');
		localStorage.setItem('authrim-admin-skin', 'classic');
		themeStore.init();
		clearThemeDomState();

		themeStore.setMode('dark');

		expect(document.documentElement.classList.contains('theme-transitioning')).toBe(true);
		expect(document.documentElement.classList.contains('theme-transition-to-dark')).toBe(true);
		expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
		expect(localStorage.getItem('authrim-admin-color-scheme')).toBe('dark');

		vi.advanceTimersByTime(2460);

		expect(document.documentElement.classList.contains('theme-transitioning')).toBe(false);
		expect(document.documentElement.classList.contains('theme-transition-to-dark')).toBe(false);
	});

	it('does not run the sky transition for skin-only changes', () => {
		localStorage.setItem('authrim-admin-color-scheme', 'light');
		localStorage.setItem('authrim-admin-skin', 'classic');
		themeStore.init();
		clearThemeDomState();

		themeStore.setSkin('frosted');

		expect(document.documentElement.classList.contains('theme-transitioning')).toBe(false);
		expect(document.documentElement.getAttribute('data-theme')).toBe('light');
		expect(document.documentElement.getAttribute('data-admin-skin')).toBe('frosted');
	});
});

describe('adminBrandStore', () => {
	beforeEach(() => {
		localStorage.clear();
		clearThemeDomState();
		adminBrandStore.resetBrand();
		localStorage.clear();
		clearThemeDomState();
	});

	it('initializes a custom white-label brand from local storage', () => {
		localStorage.setItem('authrim-admin-brand-name', 'Example ID');
		localStorage.setItem('authrim-admin-brand-admin-label', 'OPS');
		localStorage.setItem('authrim-admin-brand-logo-url', 'https://example.com/logo.png');

		adminBrandStore.init();

		expect(adminBrandStore.name).toBe('Example ID');
		expect(adminBrandStore.adminLabel).toBe('OPS');
		expect(adminBrandStore.logoUrl).toBe('https://example.com/logo.png');
		expect(adminBrandStore.logoAlt).toBe('Example ID');
		expect(adminBrandStore.key).toBe('custom');
		expect(document.documentElement.getAttribute('data-admin-brand')).toBe('custom');
	});

	it('resets to the default Authrim brand and persists that state', () => {
		adminBrandStore.setBrand({
			name: 'Example ID',
			adminLabel: 'OPS',
			logoUrl: 'https://example.com/logo.png'
		});

		adminBrandStore.resetBrand();

		expect(adminBrandStore.name).toBe('Authrim');
		expect(adminBrandStore.adminLabel).toBe('ADMIN');
		expect(adminBrandStore.logoUrl).toBe('');
		expect(adminBrandStore.key).toBe('default');
		expect(document.documentElement.getAttribute('data-admin-brand')).toBe('default');
		expect(localStorage.getItem('authrim-admin-brand-name')).toBe('Authrim');
		expect(localStorage.getItem('authrim-admin-brand-admin-label')).toBe('ADMIN');
		expect(localStorage.getItem('authrim-admin-brand-logo-url')).toBe('');
	});
});
