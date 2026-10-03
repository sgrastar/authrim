<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { get } from 'svelte/store';
	import { expect, fn, userEvent, within } from 'storybook/test';
	import { LL } from '$i18n/i18n-svelte';
	import LoginUIFrame from '$lib/storybook/LoginUIFrame.svelte';
	import AccountUpgradeWidget from './AccountUpgradeWidget.svelte';
	import { guestUpgradeStatus } from './fixtures';

	const { Story } = defineMeta({
		title: 'Account/Guest upgrade',
		component: AccountUpgradeWidget,
		tags: ['autodocs'],
		args: {
			status: guestUpgradeStatus(),
			completed: false,
			attemptMethod: null,
			busy: false,
			error: false,
			collision: false,
			pending: false,
			headingLevel: 2,
			onStartEmail: fn(),
			onStartPasskey: fn(),
			onConfirmCode: fn(),
			onChangeMethod: fn(),
			onRetry: fn(),
			onExistingLogin: fn()
		},
		parameters: {
			docs: {
				description: {
					component:
						'Registering a guest account so it keeps its data: the automatic-deletion deadline, the methods the tenant allows (email code, passkey), then the code form, a pending registration to retry, a collision with an existing account, or the outcome. Renders nothing for a registered account.'
				}
			}
		}
	});
</script>

{#snippet widget(args: Parameters<typeof AccountUpgradeWidget>[1])}
	<LoginUIFrame><AccountUpgradeWidget {...args} /></LoginUIFrame>
{/snippet}

<Story
	name="Choose a method"
	play={async ({ args, canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.type(canvas.getByLabelText(get(LL).account_guestEmail()), 'alice@example.com');
		await userEvent.click(canvas.getByRole('button', { name: get(LL).account_guestSend() }));
		await expect(args.onStartEmail).toHaveBeenCalledWith('alice@example.com');
	}}
>
	{#snippet template(args)}{@render widget(args)}{/snippet}
</Story>

<Story
	name="Passkey only"
	args={{ status: guestUpgradeStatus({ allowed_methods: ['passkey'] }) }}
	play={async ({ args, canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(canvas.getByRole('button', { name: get(LL).account_guestPasskey() }));
		await expect(args.onStartPasskey).toHaveBeenCalled();
	}}
>
	{#snippet template(args)}{@render widget(args)}{/snippet}
</Story>

<Story
	name="Email only, no deletion scheduled"
	args={{ status: guestUpgradeStatus({ allowed_methods: ['email'], deletion_due_at: null }) }}
>
	{#snippet template(args)}{@render widget(args)}{/snippet}
</Story>

<Story
	name="Registration unavailable"
	args={{ status: guestUpgradeStatus({ upgrade_eligible: false, allowed_methods: [] }) }}
>
	{#snippet template(args)}{@render widget(args)}{/snippet}
</Story>

<Story
	name="Confirmation code sent"
	args={{ attemptMethod: 'email' }}
	play={async ({ args, canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.type(canvas.getByLabelText(get(LL).account_guestCode()), '123456');
		await userEvent.click(canvas.getByRole('button', { name: get(LL).account_guestConfirm() }));
		await expect(args.onConfirmCode).toHaveBeenCalledWith('123456');
		await userEvent.click(
			canvas.getByRole('button', { name: get(LL).account_guestChangeMethod() })
		);
		await expect(args.onChangeMethod).toHaveBeenCalled();
	}}
>
	{#snippet template(args)}{@render widget(args)}{/snippet}
</Story>

<Story name="Confirming" args={{ attemptMethod: 'email', busy: true }}>
	{#snippet template(args)}{@render widget(args)}{/snippet}
</Story>

<Story
	name="Pending"
	args={{ pending: true }}
	play={async ({ args, canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(canvas.getByRole('button', { name: get(LL).account_guestRetry() }));
		await expect(args.onRetry).toHaveBeenCalled();
	}}
>
	{#snippet template(args)}{@render widget(args)}{/snippet}
</Story>

<Story
	name="In progress elsewhere"
	args={{ status: guestUpgradeStatus({ upgrade_in_progress: true }) }}
>
	{#snippet template(args)}{@render widget(args)}{/snippet}
</Story>

<Story
	name="Already registered elsewhere"
	args={{ collision: true }}
	play={async ({ args, canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(
			canvas.getByRole('button', { name: get(LL).account_guestExistingLogin() })
		);
		await expect(args.onExistingLogin).toHaveBeenCalled();
	}}
>
	{#snippet template(args)}{@render widget(args)}{/snippet}
</Story>

<Story name="Error" args={{ error: true }}>
	{#snippet template(args)}{@render widget(args)}{/snippet}
</Story>

<Story name="Completed" args={{ completed: true }}>
	{#snippet template(args)}{@render widget(args)}{/snippet}
</Story>
