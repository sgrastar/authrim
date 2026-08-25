import { describe, expect, it } from 'vitest';
import type { AccountLauncher } from '$lib/api/account';
import { launcherMatchesSearch } from './account-launcher-filter';

const launcher: AccountLauncher = {
	id: 'launcher-1',
	name: 'IRMAK Portal',
	description: 'Engineering tools',
	category: 'Internal',
	launch_type: 'bookmark',
	open_in_new_tab: false,
	icon_type: 'phosphor',
	icon_value: 'rocket-launch',
	icon_color: '#ffffff',
	background_color: '#2563eb',
	grid_width: 2,
	sort_order: 0,
	enabled: true,
	allow_favorite: true,
	created_at: 1,
	updated_at: 1,
	favorite: false,
	launch_href: '/api/account/launchers/launcher-1/launch'
};

describe('launcherMatchesSearch', () => {
	it('uses the selected locale for locale-sensitive case folding', () => {
		expect(launcherMatchesSearch(launcher, 'ırmak', 'tr')).toBe(true);
		expect(launcherMatchesSearch(launcher, 'ırmak', 'en')).toBe(false);
	});

	it('searches the description and category', () => {
		expect(launcherMatchesSearch(launcher, 'engineering', 'en')).toBe(true);
		expect(launcherMatchesSearch(launcher, 'internal', 'en')).toBe(true);
	});
});
