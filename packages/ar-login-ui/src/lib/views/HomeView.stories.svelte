<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, within } from 'storybook/test';
	import LoginUIFrame from '$lib/storybook/LoginUIFrame.svelte';
	import HomeView from './HomeView.svelte';

	const { Story } = defineMeta({
		title: 'Screens/Home',
		component: HomeView,
		tags: ['autodocs'],
		args: {
			brandName: 'Acme ID',
			isAuthenticated: false,
			accountPageEnabled: true,
			accountPagePath: '/account',
			mounted: true
		},
		parameters: {
			layout: 'fullscreen',
			docs: {
				description: {
					component:
						'The landing page at `/`, shown when nothing sends the visitor straight to sign-in. The route (`src/routes/+page.svelte`) reads the session and the account-page setting; this view draws the actions they allow.'
				}
			}
		}
	});
</script>

{#snippet page(args: Parameters<typeof HomeView>[1])}
	<LoginUIFrame fit="page"><HomeView {...args} /></LoginUIFrame>
{/snippet}

<Story
	name="Signed out"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		// Links, not buttons inside links: one control per action.
		await expect(canvasElement.querySelector('a button')).toBeNull();
		await expect(canvas.getAllByRole('link', { name: /./ }).length).toBeGreaterThan(2);
	}}
>
	{#snippet template(args)}{@render page(args)}{/snippet}
</Story>

<Story name="Signed in" args={{ isAuthenticated: true }}>
	{#snippet template(args)}{@render page(args)}{/snippet}
</Story>

<Story
	name="Signed in, no account page"
	args={{ isAuthenticated: true, accountPageEnabled: false }}
>
	{#snippet template(args)}{@render page(args)}{/snippet}
</Story>
