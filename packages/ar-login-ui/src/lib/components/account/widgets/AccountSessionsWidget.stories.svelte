<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { get } from 'svelte/store';
	import { expect, fn, userEvent, within } from 'storybook/test';
	import { LL } from '$i18n/i18n-svelte';
	import LoginUIFrame from '$lib/storybook/LoginUIFrame.svelte';
	import AccountSessionsWidget from './AccountSessionsWidget.svelte';
	import { session } from './fixtures';

	const sessions = () => [
		session({
			id: 'session-current',
			current: true,
			browser: 'Safari',
			os: 'iOS',
			device_type: 'mobile',
			country_code: 'JP'
		}),
		session(),
		session({ id: 'session-unknown', browser: null, os: null, country_code: null })
	];

	const { Story } = defineMeta({
		title: 'Account/Sessions',
		component: AccountSessionsWidget,
		tags: ['autodocs'],
		args: {
			sessions: sessions(),
			actionLoading: '',
			headingLevel: 2,
			loading: false,
			refreshing: false,
			error: '',
			reauthNeeded: false,
			onRefresh: fn(),
			onReauthenticate: fn(),
			onRevokeSession: fn()
		},
		parameters: {
			docs: {
				description: {
					component:
						'Browsers and devices signed in to the account. Logging out the current one is drawn as a destructive action; the country is named in English and the session ID is never shown.'
				}
			}
		}
	});
</script>

{#snippet widget(args: Parameters<typeof AccountSessionsWidget>[1])}
	<LoginUIFrame><AccountSessionsWidget {...args} /></LoginUIFrame>
{/snippet}

<Story
	name="Current and other sessions"
	play={async ({ args, canvasElement }) => {
		const canvas = within(canvasElement);
		const row = canvas.getByText('Chrome / Windows').closest('li');
		await expect(row).not.toBeNull();
		await userEvent.click(
			within(row as HTMLElement).getByRole('button', { name: get(LL).account_logoutSession() })
		);
		await expect(args.onRevokeSession).toHaveBeenCalledWith('session-other');
	}}
>
	{#snippet template(args)}{@render widget(args)}{/snippet}
</Story>

<Story name="Only this device" args={{ sessions: [sessions()[0]] }}>
	{#snippet template(args)}{@render widget(args)}{/snippet}
</Story>

<Story name="Empty" args={{ sessions: [] }}>
	{#snippet template(args)}{@render widget(args)}{/snippet}
</Story>

<Story name="Loading" args={{ sessions: [], loading: true }}>
	{#snippet template(args)}{@render widget(args)}{/snippet}
</Story>

<Story name="Logging out a session" args={{ actionLoading: 'session:session-other' }}>
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
>
	{#snippet template(args)}{@render widget(args)}{/snippet}
</Story>
