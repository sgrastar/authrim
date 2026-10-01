import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyThemeAttributes, STORAGE_KEYS, THEME_LOOKS, THEME_MODES } from './theme-config';

const appHtml = readFileSync(join(import.meta.dirname, '../../../app.html'), 'utf8');

describe('theme boot script in app.html', () => {
	it('reads the same storage keys as the theme store', () => {
		expect(appHtml).toContain(`'${STORAGE_KEYS.mode}'`);
		expect(appHtml).toContain(`'${STORAGE_KEYS.look}'`);
	});

	it('accepts exactly the shipped modes and looks', () => {
		for (const mode of THEME_MODES) expect(appHtml).toContain(`m === '${mode}'`);
		for (const look of THEME_LOOKS) expect(appHtml).toContain(`l === '${look}'`);
		expect(appHtml.match(/l === '/g)).toHaveLength(THEME_LOOKS.length);
	});
});

describe('applyThemeAttributes', () => {
	it('drops data-theme when following the system', () => {
		const root = document.createElement('html');
		applyThemeAttributes(root, 'dark', 'dark', 'swiss-grid');
		expect(root.dataset).toMatchObject({ theme: 'dark', scheme: 'dark', adminTheme: 'swiss-grid' });
		applyThemeAttributes(root, 'system', 'light', 'standard');
		expect(root.dataset.theme).toBeUndefined();
		expect(root.dataset.scheme).toBe('light');
	});
});
