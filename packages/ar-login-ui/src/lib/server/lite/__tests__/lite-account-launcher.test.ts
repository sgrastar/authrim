/**
 * The lite account page's launcher (account-launcher.ts): the applications listed, only by
 * ar-management's own launch link, filtered by the page's query as the SPA's widget filters.
 */
import { describe, expect, it } from 'vitest';
import { liteAccountLaunchers } from '../account-launcher';

const launcher = (id: string, extra: Record<string, unknown> = {}) => ({
	id,
	name: `App ${id}`,
	description: null,
	category: null,
	open_in_new_tab: false,
	favorite: false,
	allow_favorite: true,
	launch_href: `/api/account/launchers/${id}/launch`,
	...extra
});

const json = {
	launchers: [
		launcher('a', { name: 'Mail', category: 'Work', favorite: true }),
		launcher('b', { name: 'Chat', category: 'Work', description: 'Talk to the team' }),
		launcher('c', { name: 'Photos', category: 'Home' }),
		// Not ar-management's own link: never drawn.
		launcher('d', { launch_href: 'https://evil.example/' }),
		launcher('e', { launch_href: 'javascript:alert(1)' }),
		launcher('bad id')
	]
};

describe('the lite launcher', () => {
	it('lists the applications by their own launch link, with their categories', () => {
		const view = liteAccountLaunchers(json, new URL('https://id.example/account'), 'en');
		expect(view.launchers.map((item) => item.id)).toEqual(['a', 'b', 'c']);
		expect(view.total).toBe(3);
		expect(view.categories).toEqual(['Home', 'Work']);
		expect(view.launchers[0]).toMatchObject({
			href: '/api/account/launchers/a/launch',
			initial: 'M',
			favorite: true
		});
	});

	it('filters as the query asks (search, a category it has, favourites)', () => {
		const filter = (query: string) =>
			liteAccountLaunchers(
				json,
				new URL(`https://id.example/account?${query}`),
				'en'
			).launchers.map((item) => item.id);
		expect(filter('launcher_q=TEAM')).toEqual(['b']);
		expect(filter('launcher_category=Work')).toEqual(['a', 'b']);
		// A category it does not have filters nothing.
		expect(filter('launcher_category=Nope')).toEqual(['a', 'b', 'c']);
		expect(filter('launcher_favorites=1')).toEqual(['a']);
		expect(filter('launcher_q=home&launcher_category=Home')).toEqual(['c']);
	});

	it('shows only the launchers the slot was given, and counts and filters among them', () => {
		const url = new URL('https://id.example/account');
		const slot = liteAccountLaunchers(json, url, 'en', ['b', 'c', 'gone']);
		expect(slot.launchers.map((item) => item.id)).toEqual(['b', 'c']);
		expect(slot.total).toBe(2);
		expect(slot.categories).toEqual(['Home', 'Work']);
		// An empty choice shows none; no choice shows every one.
		expect(liteAccountLaunchers(json, url, 'en', []).launchers).toEqual([]);
		expect(liteAccountLaunchers(json, url, 'en', null).total).toBe(3);
		// A launcher not drawn for its own link is not made drawable by being chosen.
		expect(liteAccountLaunchers(json, url, 'en', ['d']).launchers).toEqual([]);
		// The page's filters apply within the choice.
		const favourites = new URL('https://id.example/account?launcher_favorites=1');
		expect(liteAccountLaunchers(json, favourites, 'en', ['b', 'c']).launchers).toEqual([]);
	});
});
