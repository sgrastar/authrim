<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, userEvent, within } from 'storybook/test';
	import LoginUIFrame from '$lib/storybook/LoginUIFrame.svelte';
	import LanguageSwitcher from './LanguageSwitcher.svelte';

	const { Story } = defineMeta({
		title: 'Components/LanguageSwitcher',
		component: LanguageSwitcher,
		tags: ['autodocs'],
		parameters: {
			docs: {
				description: {
					component:
						"The top bar: a light/dark toggle and a language select. The tenant chooses which of the two appear and where the bar sits (below the card, in the card, or pinned to a corner); see **Page shell / Settings / Top bar position**. The language list is the tenant's supported languages, with its main languages first when it has more than a few."
				}
			}
		}
	});
</script>

<Story name="Both controls">
	{#snippet template()}
		<LoginUIFrame><LanguageSwitcher /></LoginUIFrame>
	{/snippet}
</Story>

<Story name="Toggle only">
	{#snippet template()}
		<LoginUIFrame><LanguageSwitcher showLanguageSelect={false} /></LoginUIFrame>
	{/snippet}
</Story>

<Story name="Language only">
	{#snippet template()}
		<LoginUIFrame><LanguageSwitcher showThemeToggle={false} /></LoginUIFrame>
	{/snippet}
</Story>

<Story
	name="Toggle flips the colour scheme"
	play={async ({ canvasElement }) => {
		const boundary = canvasElement.querySelector('.login-ui-theme-boundary');
		const before = boundary?.getAttribute('data-theme');
		await userEvent.click(within(canvasElement).getAllByRole('button')[0]);
		await expect(boundary?.getAttribute('data-theme')).not.toBe(before);
	}}
>
	{#snippet template()}
		<LoginUIFrame><LanguageSwitcher /></LoginUIFrame>
	{/snippet}
</Story>
