import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import AccountMenu from './AccountMenu.svelte';

afterEach(cleanup);

describe('the account menu, for the first-steps guide', () => {
	const open = () =>
		render(AccountMenu, { props: { name: 'Ada', initials: 'A', onsignout: () => {} } });

	it('marks the trigger button itself, which is what a keyboard press clicks', () => {
		const view = open();
		const marked = view.container.querySelector('[data-guide="account-menu"]');
		expect(marked?.tagName).toBe('BUTTON');
		expect(marked?.getAttribute('aria-expanded')).toBe('false');
	});

	it('marks personal settings once the menu is open, and only then', async () => {
		const view = open();
		expect(view.container.querySelector('[data-guide="account-settings"]')).toBeNull();

		await fireEvent.click(view.container.querySelector('[data-guide="account-menu"]') as Element);

		// The mark wraps the link (a link-styled button passes no attributes on).
		const settings = view.container.querySelector('[data-guide="account-settings"]');
		expect(settings?.querySelector('a')?.getAttribute('href')).toBe('/admin/me');
	});
});
