import { describe, expect, it } from 'vitest';
import type { AccountLauncher } from '#lib/api/account.js';
import { launcherMatchesSearch, launcherPicture, launchersInSlot } from './account-launcher-filter';

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

describe('launcherPicture', () => {
	it('draws uploaded launcher backgrounds and HTTPS pictures only', () => {
		const uploaded =
			'/api/assets/_platform/login-ui/launcher-background/0f8fad5b-d9cb-469f-a165-70867728950e.webp';
		expect(launcherPicture(uploaded)).toBe(uploaded);
		expect(launcherPicture('https://images.example.com/a.png')).toBe(
			'https://images.example.com/a.png'
		);
		for (const value of [
			null,
			undefined,
			'',
			'http://images.example.com/a.png',
			'javascript:alert(1)',
			'data:image/png;base64,AAAA',
			'/api/assets/acme/login-ui/logo/a.png',
			'//evil.example/a.png'
		]) {
			expect(launcherPicture(value)).toBeNull();
		}
	});
});

describe('the launchers of a launcher slot', () => {
	const many = ['a', 'b', 'c'].map((id) => ({ ...launcher, id }));

	it('are the ones chosen, in the order the account gets them', () => {
		expect(launchersInSlot(many, ['c', 'a', 'gone']).map((item) => item.id)).toEqual(['a', 'c']);
	});

	it('are none for an empty choice and every one when nothing was chosen', () => {
		expect(launchersInSlot(many, [])).toEqual([]);
		expect(launchersInSlot(many, undefined).map((item) => item.id)).toEqual(['a', 'b', 'c']);
	});
});
