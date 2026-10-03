<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { get } from 'svelte/store';
	import { expect, fn, userEvent, within } from 'storybook/test';
	import { LL } from '$i18n/i18n-svelte';
	import LoginUIFrame from '$lib/storybook/LoginUIFrame.svelte';
	import AccountProfileWidget from './AccountProfileWidget.svelte';
	import { profile } from './fixtures';

	const { Story } = defineMeta({
		title: 'Account/Profile',
		component: AccountProfileWidget,
		tags: ['autodocs'],
		args: {
			profile: profile(),
			loading: false,
			saving: false,
			error: '',
			saved: false,
			emailChangeStage: 'idle',
			emailChangeLoading: false,
			emailChangeError: '',
			pendingEmail: '',
			headingLevel: 2,
			onSave: fn(),
			onStartEmailChange: fn(),
			onCompleteEmailChange: fn(),
			onCancelEmailChange: fn()
		},
		parameters: {
			docs: {
				description: {
					component:
						"The account's name and email. Renaming saves the name; changing the email sends a confirmation code to the new address, then the caller reports the stage (code sent, processing, completed)."
				}
			}
		}
	});
</script>

{#snippet widget(args: Parameters<typeof AccountProfileWidget>[1])}
	<LoginUIFrame><AccountProfileWidget {...args} /></LoginUIFrame>
{/snippet}

<Story
	name="Default"
	play={async ({ args, canvasElement }) => {
		const canvas = within(canvasElement);
		const name = canvas.getByLabelText(get(LL).account_editName());
		await userEvent.clear(name);
		await userEvent.type(name, 'Alice Smith');
		await userEvent.click(canvas.getByRole('button', { name: get(LL).account_save() }));
		await expect(args.onSave).toHaveBeenCalledWith('Alice Smith');
	}}
>
	{#snippet template(args)}{@render widget(args)}{/snippet}
</Story>

<Story name="Unverified email" args={{ profile: profile({ email_verified: false }) }}>
	{#snippet template(args)}{@render widget(args)}{/snippet}
</Story>

<Story name="Empty" args={{ profile: null }}>
	{#snippet template(args)}{@render widget(args)}{/snippet}
</Story>

<Story name="Loading" args={{ profile: null, loading: true }}>
	{#snippet template(args)}{@render widget(args)}{/snippet}
</Story>

<Story name="Saving" args={{ saving: true }}>
	{#snippet template(args)}{@render widget(args)}{/snippet}
</Story>

<Story name="Saved" args={{ saved: true }}>
	{#snippet template(args)}{@render widget(args)}{/snippet}
</Story>

<Story name="Error" args={{ error: 'Could not save the profile.' }}>
	{#snippet template(args)}{@render widget(args)}{/snippet}
</Story>

<Story
	name="Editing email"
	play={async ({ args, canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(canvas.getByRole('button', { name: get(LL).account_manage() }));
		await userEvent.type(canvas.getByLabelText(get(LL).common_email()), 'alice@example.org');
		await userEvent.click(canvas.getByRole('button', { name: get(LL).common_continue() }));
		await expect(args.onStartEmailChange).toHaveBeenCalledWith('alice@example.org');
	}}
>
	{#snippet template(args)}{@render widget(args)}{/snippet}
</Story>

<Story
	name="Editing email (code sent)"
	args={{ emailChangeStage: 'challenge', pendingEmail: 'alice@example.org' }}
	play={async ({ args, canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.getByText(/alice@example\.org/)).toBeVisible();
		await userEvent.type(
			canvas.getByLabelText(get(LL).account_reauthEmailCodePlaceholder()),
			'123456'
		);
		await userEvent.click(
			canvas.getByRole('button', { name: get(LL).account_reauthVerifyEmailCode() })
		);
		await expect(args.onCompleteEmailChange).toHaveBeenCalledWith('123456');
	}}
>
	{#snippet template(args)}{@render widget(args)}{/snippet}
</Story>

<Story name="Email change in progress" args={{ emailChangeStage: 'processing' }}>
	{#snippet template(args)}{@render widget(args)}{/snippet}
</Story>

<Story
	name="Email change completed"
	args={{ emailChangeStage: 'completed', profile: profile({ email: 'alice@example.org' }) }}
>
	{#snippet template(args)}{@render widget(args)}{/snippet}
</Story>

<Story
	name="Email change failed"
	args={{
		emailChangeStage: 'challenge',
		pendingEmail: 'alice@example.org',
		emailChangeError: 'The code is invalid or has expired.'
	}}
>
	{#snippet template(args)}{@render widget(args)}{/snippet}
</Story>
