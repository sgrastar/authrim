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
	import PlaceholderPage from './PlaceholderPage.svelte';
	import { expect, userEvent, waitFor, within } from 'storybook/test';
	import ShellDemo from './ShellDemo.svelte';

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
