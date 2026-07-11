// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';

vi.mock('$app/environment', () => ({ browser: false }));

describe('theme store SSR defaults', () => {
	it('primes the rendered mode and variant from tenant settings before hydration', async () => {
		const { createThemeStore } = await import('./theme.svelte');
		const themeStore = createThemeStore();

		themeStore.setTenantDefaults('dark', 'navy');

		expect(themeStore.mode).toBe('dark');
		expect(themeStore.currentVariant).toBe('navy');
		expect(themeStore.isInitialized).toBe(false);
	});
});
