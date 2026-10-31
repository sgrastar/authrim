import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LOGIN_UI_LOCALE_OPTIONS } from '../../login-ui/locales';

const source = readFileSync(
	resolve(__dirname, '../../../routes/admin/account-page/+page.svelte'),
	'utf8'
);

describe('Account page editor', () => {
	it('uses the shared English-name alphabetical locale options', () => {
		const labels = LOGIN_UI_LOCALE_OPTIONS.map((locale) => locale.label);

		expect(labels).toEqual(
			[...labels].sort((left, right) => left.localeCompare(right, 'en', { sensitivity: 'base' }))
		);
		expect(source).toContain('{#each LOGIN_UI_LOCALE_OPTIONS as locale (locale.code)}');
		expect(source).not.toContain('const PAGE_LOCALES');
	});

	it('configures guest visibility for every Account Page widget and defaults it on', () => {
		expect(source).toContain('show_for_guests: boolean;');
		expect(source).toContain('show_for_guests: item.show_for_guests !== false');
		expect(source).toContain('checked={placement.show_for_guests}');
		expect(source).toContain("t('ゲストアカウントでも表示', 'Show for guest accounts')");
	});
});
