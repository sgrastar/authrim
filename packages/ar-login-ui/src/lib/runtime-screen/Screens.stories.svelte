<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, fn, userEvent, within } from 'storybook/test';
	import LoginUIFrame from '$lib/storybook/LoginUIFrame.svelte';
	import {
		blocks,
		codeInputScreen,
		defaultLoginScreen,
		registrationScreen,
		screenOf
	} from '$lib/storybook/fixtures';
	import RuntimeScreenHarness from '$lib/storybook/RuntimeScreenHarness.svelte';

	const { Story } = defineMeta({
		title: 'Runtime screen/Screens',
		component: RuntimeScreenHarness,
		tags: ['autodocs'],
		args: { onAction: fn() },
		parameters: {
			docs: {
				description: {
					component:
						'Whole screens as the login and signup routes show them inside the card: the screen that ships by default, a registration screen as an admin might author it, and the code-entry step. The page around the card (logo, footer, language switcher, brand panel) is on **Page shell**.'
				}
			}
		}
	});
</script>

<Story
	name="Login (shipped default)"
	args={{ screen: defaultLoginScreen, guestRetention: 'Guest data is deleted after 30 days.' }}
>
	{#snippet template(args)}
		<LoginUIFrame><RuntimeScreenHarness {...args} /></LoginUIFrame>
	{/snippet}
</Story>

<Story
	name="Login with a custom title"
	args={{ screen: defaultLoginScreen, headingOverride: 'Welcome back to Acme', guest: false }}
>
	{#snippet template(args)}
		<LoginUIFrame><RuntimeScreenHarness {...args} /></LoginUIFrame>
	{/snippet}
</Story>

<Story
	name="Signup (admin-authored)"
	args={{
		screen: registrationScreen,
		mode: 'signup',
		withConsent: true,
		humanVerification: true,
		humanVerificationVisible: true
	}}
>
	{#snippet template(args)}
		<LoginUIFrame><RuntimeScreenHarness {...args} /></LoginUIFrame>
	{/snippet}
</Story>

<Story
	name="Signup (shipped default)"
	args={{
		screen: screenOf(
			[blocks.heading('Create your account'), blocks.passkey('Create Account with Passkey')],
			{ canvas_layout: 'narrow' },
			'registration'
		),
		mode: 'signup'
	}}
>
	{#snippet template(args)}
		<LoginUIFrame><RuntimeScreenHarness {...args} /></LoginUIFrame>
	{/snippet}
</Story>

<Story
	name="Code entry"
	args={{
		screen: codeInputScreen,
		values: {
			mail_otp_resend_remaining: '30',
			mail_otp_resend_total: '60',
			code_input_method: 'mail_otp'
		}
	}}
>
	{#snippet template(args)}
		<LoginUIFrame><RuntimeScreenHarness {...args} /></LoginUIFrame>
	{/snippet}
</Story>

<Story
	name="Waiting on the server"
	args={{
		screen: defaultLoginScreen,
		busy: ['passkey', 'mail_otp', 'external_idp'],
		disabled: true
	}}
>
	{#snippet template(args)}
		<LoginUIFrame><RuntimeScreenHarness {...args} /></LoginUIFrame>
	{/snippet}
</Story>

<Story
	name="Signup with errors"
	args={{
		screen: screenOf(
			[
				blocks.heading('Create your account'),
				blocks.email(),
				blocks.name('given_name', 'First name', undefined),
				blocks.mailOtp()
			],
			{ canvas_layout: 'narrow' },
			'registration'
		),
		mode: 'signup',
		values: { email: 'not-an-email' },
		errors: { email: 'Enter a valid email address.', given_name: 'First name is required.' }
	}}
>
	{#snippet template(args)}
		<LoginUIFrame><RuntimeScreenHarness {...args} /></LoginUIFrame>
	{/snippet}
</Story>

<Story
	name="Consent gates the buttons"
	args={{
		screen: screenOf(
			[
				blocks.heading('Create your account'),
				blocks.consent(),
				blocks.passkey('Create Account with Passkey')
			],
			{ canvas_layout: 'narrow' },
			'registration'
		),
		mode: 'signup',
		withConsent: true,
		consentReady: false
	}}
	play={async ({ canvasElement }) => {
		const passkey = within(canvasElement).getAllByRole('button').at(-1);
		await expect(passkey).toBeDisabled();
	}}
>
	{#snippet template(args)}
		<LoginUIFrame><RuntimeScreenHarness {...args} /></LoginUIFrame>
	{/snippet}
</Story>

<Story
	name="Typing in the code"
	args={{
		screen: codeInputScreen,
		values: { code_input_method: 'mail_otp', mail_otp_resend_remaining: '0' }
	}}
	play={async ({ canvasElement, args }) => {
		const canvas = within(canvasElement);
		const cell = canvas.getAllByRole('textbox')[0];
		await userEvent.type(cell, '123456');
		await expect(args.onAction).toHaveBeenCalledWith('field', {
			field: 'mail_otp_code',
			value: '123456'
		});
	}}
>
	{#snippet template(args)}
		<LoginUIFrame><RuntimeScreenHarness {...args} /></LoginUIFrame>
	{/snippet}
</Story>
