<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { get } from 'svelte/store';
	import { expect, within } from 'storybook/test';
	import { LL } from '$i18n/i18n-svelte';
	import LoginUIFrame from '$lib/storybook/LoginUIFrame.svelte';
	import AccountActivityWidget from './AccountActivityWidget.svelte';
	import { FIXTURE_NOW, operation } from './fixtures';

	const HOUR = 60 * 60 * 1000;

	const { Story } = defineMeta({
		title: 'Account/Activity',
		component: AccountActivityWidget,
		tags: ['autodocs'],
		args: {
			operations: [
				operation(),
				operation({
					id: 'operation-2',
					action: 'account.totp.backup_codes_regenerated',
					created_at: FIXTURE_NOW - 26 * HOUR
				}),
				operation({
					id: 'operation-3',
					action: 'account.email.changed',
					created_at: FIXTURE_NOW - 72 * HOUR
				}),
				operation({
					id: 'operation-4',
					action: 'account.custom.audit_event',
					created_at: FIXTURE_NOW - 96 * HOUR
				})
			],
			loading: false,
			headingLevel: 2
		},
		parameters: {
			docs: {
				description: {
					component:
						'Recent changes made to the account, newest first. Known audit actions are described in the UI language; any other action is shown as recorded.'
				}
			}
		}
	});
</script>

{#snippet widget(args: Parameters<typeof AccountActivityWidget>[1])}
	<LoginUIFrame><AccountActivityWidget {...args} /></LoginUIFrame>
{/snippet}

<Story
	name="Default"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.getByText(get(LL).account_operationPasskeyCreated())).toBeVisible();
		await expect(
			canvas.getByText(get(LL).account_operationTotpBackupCodesRegenerated())
		).toBeVisible();
		await expect(canvas.getByText('account.custom.audit_event')).toBeVisible();
	}}
>
	{#snippet template(args)}{@render widget(args)}{/snippet}
</Story>

<Story name="Empty" args={{ operations: [] }}>
	{#snippet template(args)}{@render widget(args)}{/snippet}
</Story>

<Story name="Loading" args={{ operations: [], loading: true }}>
	{#snippet template(args)}{@render widget(args)}{/snippet}
</Story>
