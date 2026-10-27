<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { named, subcomponents } from '../ui/stories/subcomponents';
	import AppShell from './AppShell.svelte';
	import Header from './Header.svelte';
	import TopNav from './TopNav.svelte';
	import SubNav from './SubNav.svelte';
	import NavDrawer from './NavDrawer.svelte';
	import ScopeSwitcher from './ScopeSwitcher.svelte';
	import AccountMenu from './AccountMenu.svelte';
	import DisplayMenu from './DisplayMenu.svelte';
	import LanguageSwitch from './LanguageSwitch.svelte';
	import NotificationArea from './NotificationArea.svelte';
	import type { ShellNotification } from './notifications';
	import PlaceholderPage from './PlaceholderPage.svelte';
	import { expect, userEvent, waitFor, within } from 'storybook/test';
	import ShellDemo from './ShellDemo.svelte';

	const many: ShellNotification[] = [
		{
			id: 'n1',
			severity: 'high',
			text: 'Directory connection "Acme AD" has failed for 12 minutes; sign-ins with directory passwords are failing.',
			time: '12:04'
		},
		{ id: 'n2', severity: 'info', text: 'Weekly backup of Globex Inc. finished.', time: '09:30' },
		{
			id: 'n3',
			severity: 'critical',
			text: 'The signing certificate of "Journal Publisher" expires in 6 days.',
			time: '08:15'
		},
		{
			id: 'n4',
			severity: 'info',
			text: 'A new administrator joined Acme Corporation.',
			time: 'Yesterday'
		},
		{
			id: 'n5',
			severity: 'caution',
			text: 'The sync with the secondary system is 40 minutes behind.',
			time: 'Yesterday'
		},
		{
			id: 'n6',
			severity: 'critical',
			text: 'A sign-in flow of Acme Corporation has no published version.',
			time: 'Yesterday'
		}
	];
	// No critical item: the red circle shows 0 and is drawn faint.
	const noCritical = many.filter((item) => item.severity !== 'critical');
	const busy: ShellNotification[] = Array.from({ length: 24 }, (_, index) => ({
		id: `b${index}`,
		severity: (['info', 'caution', 'high', 'critical'] as const)[index % 4],
		text: `Notification ${index + 1}`,
		time: `${index + 1} min ago`
	}));

	// The props table's main tab (see named()).
	named(ShellDemo, 'ShellDemo');

	const { Story } = defineMeta({
		title: 'Shell/App shell',
		component: ShellDemo,
		subcomponents: subcomponents({
			AppShell,
			Header,
			TopNav,
			SubNav,
			NavDrawer,
			ScopeSwitcher,
			AccountMenu,
			DisplayMenu,
			LanguageSwitch,
			NotificationArea,
			PlaceholderPage
		}),
		tags: ['autodocs'],
		parameters: {
			layout: 'fullscreen',
			docs: {
				description: {
					component:
						'The console frame: header with the scope switcher, header categories, left nav and the phone drawer. Click categories to see the left nav turn over (click several quickly to see the turn abandoned for the new rows); switch the scope to the platform to see the category bar flip.'
				}
			}
		}
	});
</script>

<Story name="Tenant scope" args={{ path: '/admin/users/all' }} />

<Story name="Platform scope" args={{ path: '/admin/platform/users/all' }} />

<Story
	name="Category turn"
	args={{ path: '/admin/users/all' }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const nav = canvas.getAllByRole('navigation')[0];
		await userEvent.click(within(nav).getAllByRole('link')[2]);
		// The category lands on its first item, and the left nav now lists its items.
		await waitFor(() =>
			expect(
				canvas.getAllByRole('link', { current: 'page' }).map((link) => link.getAttribute('href'))
			).toContain('/admin/access/apis')
		);
	}}
/>

<Story name="Notifications: none" args={{ path: '/admin/users/all', notifications: [] }} />

<Story name="Notifications: many" args={{ path: '/admin/users/all', notifications: busy }} />

<Story
	name="Notifications: no critical"
	args={{ path: '/admin/users/all', notifications: noCritical }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const trigger = canvas.getByRole('button', { name: /Notifications|通知/ });
		// Red has no item: its count is 0 and its pill is neutral; the others keep their colour.
		await expect(trigger).toHaveAccessibleName(/(Critical|クリティカル) 0/);
		const counts = trigger.querySelectorAll<HTMLElement>('.notify__count');
		await expect(counts).toHaveLength(4);
		await expect(counts[0]).toHaveClass('is-zero');
		for (const count of [counts[1], counts[2], counts[3]])
			await expect(count).not.toHaveClass('is-zero');
		const pill = (count: HTMLElement) => getComputedStyle(count.querySelector('.notify__pill')!);
		await expect(pill(counts[0]).color).not.toBe(pill(counts[1]).color);
		await expect(pill(counts[0]).backgroundColor).toBe('rgba(0, 0, 0, 0)');
	}}
/>

<!-- One tenant only: the scope is a plain label, which has to shrink on a phone like the menu does. -->
<Story
	name="Notifications: single scope"
	args={{ path: '/admin/users/all', notifications: many, singleScope: true }}
/>

<!-- For looking at: nothing runs on load, so a reload shows the sheet closed and still. -->
<Story name="Notifications: several" args={{ path: '/admin/users/all', notifications: many }} />

<!-- The same data with the interaction checks. Storybook plays them on every load, so the sheet
     opens and closes by itself here; keep it out of the story you are looking at. -->
<Story
	name="Notifications: interaction"
	args={{ path: '/admin/users/all', notifications: many }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		// Closed: four circles with counts, no text; the list is not reachable.
		const trigger = canvas.getByRole('button', { name: /Notifications|通知/ });
		await expect(trigger).toHaveAttribute('aria-expanded', 'false');
		await expect(trigger).toHaveTextContent('2');
		// A click opens the list, most urgent first, and every row is a link to its page.
		await userEvent.click(trigger);
		await expect(trigger).toHaveAttribute('aria-expanded', 'true');
		const list = canvas.getByRole('list', { name: /Notifications|通知/ });
		await expect(within(list).getAllByRole('listitem')).toHaveLength(6);
		const links = within(list).getAllByRole('link');
		await expect(links[0]).toHaveTextContent(/signing certificate/);
		await expect(links[0]).toHaveAttribute('href', '/admin/integrations/notifications?id=n3');
		// The messages start in one column, however long the pills are (a language with longer names).
		list.querySelectorAll('.notify__pill--row').forEach((pill, index) => {
			pill.textContent = 'Ĉŕîţîçåļ ôñé ţŵö'.slice(0, 4 + ((index * 5) % 12));
		});
		const starts = [...list.querySelectorAll('.notify__item-body')].map((body) =>
			Math.round(body.getBoundingClientRect().left)
		);
		await expect(new Set(starts).size).toBe(1);
		// Only information can be dismissed on the spot (two items here).
		const dismiss = within(list).getAllByRole('button', { name: /Dismiss|消す/ });
		await expect(dismiss).toHaveLength(2);
		await userEvent.click(dismiss[0]);
		await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(5));
		await expect(within(list).getAllByRole('button', { name: /Dismiss|消す/ })).toHaveLength(1);
		// The icon at the top right closes the sheet. A click leaves focus alone (no ring that
		// the click did not ask for).
		await userEvent.click(canvas.getByRole('button', { name: /Close|閉じる/ }));
		await waitFor(() => expect(trigger).toHaveAttribute('aria-expanded', 'false'));
		await expect(trigger).not.toHaveFocus();
		// Esc closes it, and a keyboard user is taken back to the circles.
		await userEvent.click(trigger);
		await userEvent.keyboard('{Escape}');
		await waitFor(() => expect(trigger).toHaveAttribute('aria-expanded', 'false'));
		await expect(trigger).toHaveFocus();
		// Following a notification folds the sheet, so it does not cover the page it leads to.
		// (The navigation itself is held back here, so the story stays on its page.)
		await userEvent.click(trigger);
		canvasElement.addEventListener('click', (event) => event.preventDefault(), { once: true });
		const first = within(canvas.getByRole('list', { name: /Notifications|通知/ })).getAllByRole(
			'link'
		)[0];
		await userEvent.click(first);
		await waitFor(() => expect(trigger).toHaveAttribute('aria-expanded', 'false'));
	}}
/>
