<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { get } from 'svelte/store';
	import { expect, fn, userEvent, within } from 'storybook/test';
	import { LL } from '$i18n/i18n-svelte';
	import LoginUIFrame from '$lib/storybook/LoginUIFrame.svelte';
	import AccountPasskeysWidget from './AccountPasskeysWidget.svelte';
	import { passkey } from './fixtures';

	const passkeys = () => [
		passkey(),
		passkey({
			id: 'passkey-2',
			provider: {
				aaguid: '00000000-0000-0000-0000-000000000000',
				name: null,
				icon_light: null,
				icon_dark: null,
				known: false
			}
		})
	];

	const { Story } = defineMeta({
		title: 'Account/Passkeys',
		component: AccountPasskeysWidget,
		tags: ['autodocs'],
		args: {
			passkeys: passkeys(),
			passkeySupported: true,
			actionLoading: '',
			headingLevel: 2,
			loading: false,
			refreshing: false,
			error: '',
			reauthNeeded: false,
			onRefresh: fn(),
			onReauthenticate: fn(),
			onAddPasskey: fn(),
			onDeletePasskey: fn()
		},
		parameters: {
			docs: {
				description: {
					component:
						'Registered passkeys by authenticator provider (name, light / dark icon, registration date) and a form to register another. The page runs the WebAuthn ceremony; the widget only reports the chosen name.'
				}
			}
		}
	});
</script>

{#snippet widget(args: Parameters<typeof AccountPasskeysWidget>[1])}
	<LoginUIFrame><AccountPasskeysWidget {...args} /></LoginUIFrame>
{/snippet}

<Story
	name="Default"
	play={async ({ args, canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.type(canvas.getByLabelText(get(LL).account_passkeyName()), 'Work laptop');
		await userEvent.click(canvas.getByRole('button', { name: get(LL).account_addPasskey() }));
		await expect(args.onAddPasskey).toHaveBeenCalledWith('Work laptop');
	}}
>
	{#snippet template(args)}{@render widget(args)}{/snippet}
</Story>

<Story name="Empty" args={{ passkeys: [] }}>
	{#snippet template(args)}{@render widget(args)}{/snippet}
</Story>

<Story name="Browser without passkeys" args={{ passkeys: [], passkeySupported: false }}>
	{#snippet template(args)}{@render widget(args)}{/snippet}
</Story>

<Story name="Loading" args={{ passkeys: [], loading: true }}>
	{#snippet template(args)}{@render widget(args)}{/snippet}
</Story>

<Story name="Registering" args={{ actionLoading: 'passkey:add' }}>
	{#snippet template(args)}{@render widget(args)}{/snippet}
</Story>

<Story name="Deleting" args={{ actionLoading: 'passkey:passkey-1' }}>
	{#snippet template(args)}{@render widget(args)}{/snippet}
</Story>

<Story name="Error" args={{ error: 'Passkey registration failed. Please try again.' }}>
	{#snippet template(args)}{@render widget(args)}{/snippet}
</Story>

<Story
	name="Reauthentication needed"
	args={{
		error: 'Recent authentication is required. Re-authenticate and retry.',
		reauthNeeded: true
	}}
>
	{#snippet template(args)}{@render widget(args)}{/snippet}
</Story>
