<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { get } from 'svelte/store';
	import { expect, fn, userEvent, within } from 'storybook/test';
	import { LL } from '$i18n/i18n-svelte';
	import LoginUIFrame from '$lib/storybook/LoginUIFrame.svelte';
	import AccountDevicesWidget from './AccountDevicesWidget.svelte';
	import { device } from './fixtures';

	const { Story } = defineMeta({
		title: 'Account/Devices',
		component: AccountDevicesWidget,
		tags: ['autodocs'],
		args: {
			devices: [
				device({ current: true }),
				device({ id: 'device-2', display_name: 'Living room TV', platform: 'tvOS' })
			],
			headingLevel: 2,
			loading: false,
			refreshing: false,
			error: '',
			reauthNeeded: false,
			onRefresh: fn(),
			onReauthenticate: fn()
		},
		parameters: {
			docs: {
				description: {
					component:
						'Apps and devices linked to the account (device grants), separate from browser sign-ins. The account page loads them and passes per-widget loading, refresh and error state.'
				}
			}
		}
	});
</script>

{#snippet widget(args: Parameters<typeof AccountDevicesWidget>[1])}
	<LoginUIFrame><AccountDevicesWidget {...args} /></LoginUIFrame>
{/snippet}

<Story
	name="Default"
	play={async ({ args, canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(canvas.getByRole('button', { name: get(LL).account_refresh() }));
		await expect(args.onRefresh).toHaveBeenCalled();
	}}
>
	{#snippet template(args)}{@render widget(args)}{/snippet}
</Story>

<Story name="Empty" args={{ devices: [] }}>
	{#snippet template(args)}{@render widget(args)}{/snippet}
</Story>

<Story name="Loading" args={{ devices: [], loading: true }}>
	{#snippet template(args)}{@render widget(args)}{/snippet}
</Story>

<Story name="Refreshing" args={{ refreshing: true }}>
	{#snippet template(args)}{@render widget(args)}{/snippet}
</Story>

<Story name="Error" args={{ error: 'Could not load account data' }}>
	{#snippet template(args)}{@render widget(args)}{/snippet}
</Story>

<Story
	name="Reauthentication needed"
	args={{
		error: 'Recent authentication is required. Re-authenticate and retry.',
		reauthNeeded: true
	}}
	play={async ({ args, canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(canvas.getByRole('button', { name: get(LL).account_reauth() }));
		await expect(args.onReauthenticate).toHaveBeenCalled();
	}}
>
	{#snippet template(args)}{@render widget(args)}{/snippet}
</Story>
