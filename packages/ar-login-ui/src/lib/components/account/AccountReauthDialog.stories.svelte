<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { get } from 'svelte/store';
	import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
	import { LL } from '$i18n/i18n-svelte';
	import { Button } from '$lib/components';
	import LoginUIFrame from '$lib/storybook/LoginUIFrame.svelte';
	import AccountReauthDialog from './AccountReauthDialog.svelte';

	const { Story } = defineMeta({
		title: 'Account/Reauthentication dialog',
		component: AccountReauthDialog,
		tags: ['autodocs'],
		args: {
			open: true,
			passkeyAvailable: true,
			emailCodeAvailable: true,
			totpAvailable: true,
			pending: null,
			emailCodeSent: false,
			maskedEmail: 'a***@example.com',
			emailCode: '',
			totpCode: '',
			error: '',
			onPasskey: fn(),
			onSendEmailCode: fn(),
			onVerifyEmailCode: fn(),
			onVerifyTotp: fn(),
			onClose: fn()
		},
		argTypes: {
			pending: { control: 'select', options: [null, 'passkey', 'email', 'totp'] }
		},
		parameters: {
			layout: 'fullscreen',
			docs: {
				// The dialog is fixed to the viewport: each story gets its own frame.
				story: { inline: false, iframeHeight: 640 },
				description: {
					component:
						'Asks for a recent authentication before a sensitive account change (adding or removing a passkey or authenticator app, changing the email address). It offers the methods the tenant allows for re-authentication that this account can use; the account page owns the requests. Focus moves to the first method, Tab stays inside, Escape or the backdrop closes it and focus returns to the control that opened it.'
				}
			}
		}
	});

	/** The "Opened from a button" story's own state: whether its dialog is open. */
	let openedFromButton = $state(false);
</script>

{#snippet dialog(args: Parameters<typeof AccountReauthDialog>[1])}
	<LoginUIFrame><AccountReauthDialog {...args} /></LoginUIFrame>
{/snippet}

<Story
	name="All methods"
	play={async ({ args, canvasElement }) => {
		const canvas = within(canvasElement);
		const ll = get(LL);
		const dialogElement = await canvas.findByRole('dialog', { name: ll.account_reauthTitle() });

		// Focus starts on the first method.
		await waitFor(() =>
			expect(canvas.getByRole('button', { name: ll.account_reauthWithPasskey() })).toHaveFocus()
		);

		// Tab and Shift+Tab wrap at the ends instead of leaving the dialog.
		const cancel = canvas.getByRole('button', { name: ll.dialog_cancel() });
		const close = canvas.getByRole('button', { name: ll.dialog_close() });
		cancel.focus();
		await userEvent.tab();
		await expect(close).toHaveFocus();
		await userEvent.tab({ shift: true });
		await expect(cancel).toHaveFocus();
		await expect(dialogElement.contains(document.activeElement)).toBe(true);

		await userEvent.keyboard('{Escape}');
		await expect(args.onClose).toHaveBeenCalled();
	}}
>
	{#snippet template(args)}{@render dialog(args)}{/snippet}
</Story>

<Story name="Passkey only" args={{ emailCodeAvailable: false, totpAvailable: false }}>
	{#snippet template(args)}{@render dialog(args)}{/snippet}
</Story>

<Story
	name="Email code only"
	args={{ passkeyAvailable: false, totpAvailable: false }}
	play={async ({ args, canvasElement }) => {
		const canvas = within(canvasElement);
		const send = canvas.getByRole('button', { name: get(LL).account_reauthWithEmailCode() });
		await waitFor(() => expect(send).toHaveFocus());
		await userEvent.click(send);
		await expect(args.onSendEmailCode).toHaveBeenCalled();
	}}
>
	{#snippet template(args)}{@render dialog(args)}{/snippet}
</Story>

<Story
	name="Authenticator app only"
	args={{ passkeyAvailable: false, emailCodeAvailable: false }}
	play={async ({ args, canvasElement }) => {
		const canvas = within(canvasElement);
		const ll = get(LL);
		const field = canvas.getByLabelText(ll.login_totpCodeLabel());
		await waitFor(() => expect(field).toHaveFocus());
		const verify = canvas.getByRole('button', { name: ll.account_reauthWithTotp() });
		await expect(verify).toBeDisabled();
		await userEvent.type(field, '123456');
		await expect(verify).toBeEnabled();
		await userEvent.click(verify);
		await expect(args.onVerifyTotp).toHaveBeenCalled();
	}}
>
	{#snippet template(args)}{@render dialog(args)}{/snippet}
</Story>

<Story
	name="Email code sent"
	args={{ emailCodeSent: true }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await waitFor(() =>
			expect(canvas.getByLabelText(get(LL).emailCode_codeLabel())).toBeInTheDocument()
		);
	}}
>
	{#snippet template(args)}{@render dialog(args)}{/snippet}
</Story>

<Story name="In progress" args={{ pending: 'passkey' }}>
	{#snippet template(args)}{@render dialog(args)}{/snippet}
</Story>

<Story
	name="Error"
	args={{
		emailCodeSent: true,
		emailCode: '123456',
		error: 'The verification code is incorrect or has expired.'
	}}
>
	{#snippet template(args)}{@render dialog(args)}{/snippet}
</Story>

<Story
	name="No method available"
	args={{ passkeyAvailable: false, emailCodeAvailable: false, totpAvailable: false }}
>
	{#snippet template(args)}{@render dialog(args)}{/snippet}
</Story>

<Story
	name="Opened from a button"
	play={async ({ args, canvasElement }) => {
		openedFromButton = false;
		const canvas = within(canvasElement);
		const ll = get(LL);
		const opener = canvas.getByRole('button', { name: ll.account_reauth() });
		await userEvent.click(opener);
		await waitFor(() =>
			expect(canvas.getByRole('button', { name: ll.account_reauthWithPasskey() })).toHaveFocus()
		);

		// Closing gives focus back to the button that opened the dialog.
		await userEvent.keyboard('{Escape}');
		await expect(args.onClose).toHaveBeenCalled();
		await waitFor(() => expect(canvas.queryByRole('dialog')).toBeNull());
		await expect(opener).toHaveFocus();
	}}
>
	{#snippet template({ open: _, onClose, ...args })}
		<LoginUIFrame>
			<div>
				<Button variant="secondary" onclick={() => (openedFromButton = true)}>
					{get(LL).account_reauth()}
				</Button>
			</div>
			<AccountReauthDialog
				{...args}
				open={openedFromButton}
				onClose={() => {
					onClose();
					openedFromButton = false;
				}}
			/>
		</LoginUIFrame>
	{/snippet}
</Story>
