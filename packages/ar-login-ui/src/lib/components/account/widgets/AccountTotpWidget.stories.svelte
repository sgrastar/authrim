<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { get } from 'svelte/store';
	import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
	import { LL } from '$i18n/i18n-svelte';
	import LoginUIFrame from '$lib/storybook/LoginUIFrame.svelte';
	import AccountTotpWidget from './AccountTotpWidget.svelte';
	import { backupCodes, totpCredential, totpEnrollment } from './fixtures';

	const { Story } = defineMeta({
		title: 'Account/Authenticator apps',
		component: AccountTotpWidget,
		tags: ['autodocs'],
		args: {
			credentials: [totpCredential()],
			backupCodes: { total: 10, remaining: 8 },
			enrollment: null,
			managementEnabled: true,
			actionLoading: '',
			headingLevel: 2,
			loading: false,
			refreshing: false,
			error: '',
			reauthNeeded: false,
			onRefresh: fn(),
			onReauthenticate: fn(),
			onStartEnrollment: fn(),
			onActivateEnrollment: fn(),
			onDeleteCredential: fn(),
			onRegenerateBackupCodes: fn(),
			onClearEnrollment: fn()
		},
		parameters: {
			docs: {
				description: {
					component:
						'Authenticator apps (TOTP): add one, scan the QR code and activate it with a code, keep the one-time backup codes, regenerate them, and delete an app with a current or backup code as proof.'
				}
			}
		}
	});
</script>

{#snippet widget(args: Parameters<typeof AccountTotpWidget>[1])}
	<LoginUIFrame><AccountTotpWidget {...args} /></LoginUIFrame>
{/snippet}

<Story
	name="Default"
	play={async ({ args, canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.type(canvas.getByLabelText(get(LL).account_totpName()), 'Tablet');
		await userEvent.click(canvas.getByRole('button', { name: get(LL).account_addTotp() }));
		await expect(args.onStartEnrollment).toHaveBeenCalledWith('Tablet');
	}}
>
	{#snippet template(args)}{@render widget(args)}{/snippet}
</Story>

<Story name="Empty" args={{ credentials: [], backupCodes: { total: 0, remaining: 0 } }}>
	{#snippet template(args)}{@render widget(args)}{/snippet}
</Story>

<Story name="Loading" args={{ credentials: [], loading: true }}>
	{#snippet template(args)}{@render widget(args)}{/snippet}
</Story>

<Story
	name="Enrollment in progress"
	args={{
		credentials: [
			totpCredential(),
			totpCredential({ id: 'totp-2', label: 'Tablet', status: 'pending', last_used_at: null })
		],
		enrollment: totpEnrollment()
	}}
	play={async ({ args, canvasElement }) => {
		const canvas = within(canvasElement);
		await waitFor(() => expect(canvas.getByAltText(get(LL).account_totpQrAlt())).toBeVisible());
		await userEvent.type(canvas.getByLabelText(get(LL).account_totpActivationCode()), '123456');
		await userEvent.click(canvas.getByRole('button', { name: get(LL).account_totpActivate() }));
		await expect(args.onActivateEnrollment).toHaveBeenCalledWith('123456');
	}}
>
	{#snippet template(args)}{@render widget(args)}{/snippet}
</Story>

<Story
	name="Backup codes after activation"
	args={{
		credentials: [totpCredential(), totpCredential({ id: 'totp-2', label: 'Tablet' })],
		backupCodes: { total: 6, remaining: 6 },
		enrollment: totpEnrollment({ backupCodes: backupCodes() })
	}}
	play={async ({ args, canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(canvas.getByRole('button', { name: get(LL).account_totpDone() }));
		await expect(args.onClearEnrollment).toHaveBeenCalled();
	}}
>
	{#snippet template(args)}{@render widget(args)}{/snippet}
</Story>

<Story
	name="Delete proof"
	play={async ({ args, canvasElement }) => {
		const canvas = within(canvasElement);
		const remove = canvas.getByRole('button', { name: get(LL).account_delete() });
		await expect(remove).toBeDisabled();
		await userEvent.type(
			canvas.getByLabelText(`Phone: ${get(LL).account_totpDeleteCode()}`),
			'123456'
		);
		await userEvent.click(remove);
		await expect(args.onDeleteCredential).toHaveBeenCalledWith('totp-1', '123456');
	}}
>
	{#snippet template(args)}{@render widget(args)}{/snippet}
</Story>

<Story
	name="Regenerating backup codes"
	args={{ actionLoading: 'totp:backup-codes', backupCodes: { total: 10, remaining: 1 } }}
>
	{#snippet template(args)}{@render widget(args)}{/snippet}
</Story>

<Story name="Error" args={{ error: 'The authenticator code is invalid.' }}>
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
