<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { get } from 'svelte/store';
	import { expect, within } from 'storybook/test';
	import { LL } from '$i18n/i18n-svelte';
	import LoginUIFrame from '$lib/storybook/LoginUIFrame.svelte';
	import AccountSocialAccountsWidget from './AccountSocialAccountsWidget.svelte';

	const { Story } = defineMeta({
		title: 'Account/Social accounts',
		component: AccountSocialAccountsWidget,
		tags: ['autodocs'],
		args: { headingLevel: 2 },
		parameters: {
			docs: {
				description: {
					component:
						'Connected social accounts. A placeholder until the account API lists linked identities.'
				}
			}
		}
	});
</script>

<Story
	name="Planned"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(
			canvas.getByRole('heading', { level: 2, name: get(LL).account_socialAccounts() })
		).toBeInTheDocument();
		await expect(canvas.getByText(get(LL).account_planned())).toBeInTheDocument();
	}}
>
	{#snippet template(args)}
		<LoginUIFrame><AccountSocialAccountsWidget {...args} /></LoginUIFrame>
	{/snippet}
</Story>
