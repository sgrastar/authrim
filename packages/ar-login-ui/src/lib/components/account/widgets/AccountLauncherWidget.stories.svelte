<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { get } from 'svelte/store';
	import { expect, fn, userEvent, within } from 'storybook/test';
	import { LL } from '$i18n/i18n-svelte';
	import LoginUIFrame from '$lib/storybook/LoginUIFrame.svelte';
	import AccountLauncherWidget from './AccountLauncherWidget.svelte';
	import { launchers } from './fixtures';

	const { Story } = defineMeta({
		title: 'Account/Launcher',
		component: AccountLauncherWidget,
		tags: ['autodocs'],
		args: {
			launchers: launchers(),
			loading: false,
			error: '',
			favoriteError: '',
			favoriteLoading: [],
			headingLevel: 2,
			onRetry: fn(),
			onToggleFavorite: fn()
		},
		parameters: {
			docs: {
				description: {
					component:
						'The applications the account can open, as tiles sized by the admin (grid width 1–8). Search, the category filter and "favourites only" filter the tiles in place; marking a favourite and loading the list are the caller\'s.'
				}
			}
		}
	});

	const favoriteName = (name: string) => `${name}: ${get(LL).account_launcherFavorites()}`;
</script>

{#snippet widget(args: Parameters<typeof AccountLauncherWidget>[1])}
	<LoginUIFrame><AccountLauncherWidget {...args} /></LoginUIFrame>
{/snippet}

<Story
	name="Default"
	play={async ({ args, canvasElement }) => {
		const canvas = within(canvasElement);
		const favorite = canvas.getByRole('button', { name: favoriteName('Team calendar') });
		await expect(favorite).toHaveAttribute('aria-pressed', 'true');
		await userEvent.click(canvas.getByRole('button', { name: favoriteName('Expenses') }));
		await expect(args.onToggleFavorite).toHaveBeenCalledWith(
			expect.objectContaining({ id: 'launcher-expenses', favorite: false })
		);
	}}
>
	{#snippet template(args)}{@render widget(args)}{/snippet}
</Story>

<Story
	name="Filtered"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.type(
			canvas.getByRole('searchbox', { name: get(LL).account_launcherSearch() }),
			'pay'
		);
		await expect(canvas.getByText('Payroll (legacy portal)')).toBeVisible();
		await expect(canvas.queryByText('Team calendar')).toBeNull();
		await userEvent.selectOptions(
			canvas.getByRole('combobox', { name: get(LL).account_launcherAllCategories() }),
			'Productivity'
		);
		await expect(canvas.getByText(get(LL).account_launcherNoMatches())).toBeVisible();
	}}
>
	{#snippet template(args)}{@render widget(args)}{/snippet}
</Story>

<Story
	name="Favourites only"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(
			canvas.getByRole('checkbox', { name: get(LL).account_launcherFavorites() })
		);
		await expect(canvas.getByText('Team calendar')).toBeVisible();
		await expect(canvas.queryByText('Expenses')).toBeNull();
	}}
>
	{#snippet template(args)}{@render widget(args)}{/snippet}
</Story>

<Story
	name="Favourite toggling"
	args={{ favoriteLoading: ['launcher-calendar'] }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(
			canvas.getByRole('button', { name: favoriteName('Team calendar') })
		).toBeDisabled();
	}}
>
	{#snippet template(args)}{@render widget(args)}{/snippet}
</Story>

<Story
	name="Favourite failed"
	args={{ favoriteError: 'Could not update the favorite status. Please try again.' }}
>
	{#snippet template(args)}{@render widget(args)}{/snippet}
</Story>

<Story name="Empty" args={{ launchers: [] }}>
	{#snippet template(args)}{@render widget(args)}{/snippet}
</Story>

<Story name="Loading" args={{ launchers: [], loading: true }}>
	{#snippet template(args)}{@render widget(args)}{/snippet}
</Story>

<Story
	name="Error"
	args={{ launchers: [], error: 'Applications could not be loaded.' }}
	play={async ({ args, canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(canvas.getByRole('button', { name: get(LL).account_refresh() }));
		await expect(args.onRetry).toHaveBeenCalled();
	}}
>
	{#snippet template(args)}{@render widget(args)}{/snippet}
</Story>
