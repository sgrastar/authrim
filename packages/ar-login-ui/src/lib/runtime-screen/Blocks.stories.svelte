<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, fn, userEvent, within } from 'storybook/test';
	import LoginUIFrame from '$lib/storybook/LoginUIFrame.svelte';
	import { blocks, screenOf } from '$lib/storybook/fixtures';
	import RuntimeScreenHarness from '$lib/storybook/RuntimeScreenHarness.svelte';

	const { Story } = defineMeta({
		title: 'Runtime screen/Blocks',
		component: RuntimeScreenHarness,
		tags: ['autodocs'],
		args: { onAction: fn() },
		parameters: {
			docs: {
				description: {
					component:
						'Login, signup and the other server-driven screens are lists of **blocks** that an admin arranges in the Admin console. Each story here is one block type on its own, in the same card the login route puts it in. Block type names are the `block_type` values stored with the screen. Switch **Theme**, **Scheme** and **Language** in the toolbar to see each block in every look.'
				}
			}
		}
	});

	const only = (...fields: Parameters<typeof screenOf>[0]) => screenOf(fields);
</script>

<Story
	name="Heading and text"
	args={{
		screen: only(
			blocks.heading('Sign in', 'Use your Acme account to continue.'),
			blocks.text('Text blocks carry short notes, for example which account to use.')
		)
	}}
>
	{#snippet template(args)}
		<LoginUIFrame><RuntimeScreenHarness {...args} /></LoginUIFrame>
	{/snippet}
</Story>

<Story
	name="Divider"
	args={{
		screen: only(
			blocks.divider('or'),
			blocks.divider('Continue with another account'),
			blocks.divider('')
		)
	}}
>
	{#snippet template(args)}
		<LoginUIFrame><RuntimeScreenHarness {...args} /></LoginUIFrame>
	{/snippet}
</Story>

<Story name="Auth widget: passkey" args={{ screen: only(blocks.passkey()) }}>
	{#snippet template(args)}
		<LoginUIFrame><RuntimeScreenHarness {...args} /></LoginUIFrame>
	{/snippet}
</Story>

<Story name="Auth widget: email code" args={{ screen: only(blocks.mailOtp()) }}>
	{#snippet template(args)}
		<LoginUIFrame><RuntimeScreenHarness {...args} /></LoginUIFrame>
	{/snippet}
</Story>

<Story name="Auth widget: authenticator app" args={{ screen: only(blocks.totp()) }}>
	{#snippet template(args)}
		<LoginUIFrame><RuntimeScreenHarness {...args} /></LoginUIFrame>
	{/snippet}
</Story>

<Story
	name="Auth widget: email code or authenticator"
	args={{ screen: only(blocks.mailOtpTotp()) }}
>
	{#snippet template(args)}
		<LoginUIFrame><RuntimeScreenHarness {...args} /></LoginUIFrame>
	{/snippet}
</Story>

<Story name="Auth widget: directory password" args={{ screen: only(blocks.directoryPassword()) }}>
	{#snippet template(args)}
		<LoginUIFrame><RuntimeScreenHarness {...args} /></LoginUIFrame>
	{/snippet}
</Story>

<Story name="Auth widget: external providers" args={{ screen: only(blocks.externalIdp(false)) }}>
	{#snippet template(args)}
		<LoginUIFrame><RuntimeScreenHarness {...args} /></LoginUIFrame>
	{/snippet}
</Story>

<Story
	name="Auth widget: external providers with action text"
	args={{ screen: only(blocks.externalIdp(true)) }}
>
	{#snippet template(args)}
		<LoginUIFrame><RuntimeScreenHarness {...args} /></LoginUIFrame>
	{/snippet}
</Story>

<Story
	name="Auth widget: no external provider configured"
	args={{ screen: only(blocks.externalIdp(false)), providers: false }}
>
	{#snippet template(args)}
		<LoginUIFrame><RuntimeScreenHarness {...args} /></LoginUIFrame>
	{/snippet}
</Story>

<Story
	name="Guest login"
	args={{ screen: only(blocks.guest()), guestRetention: 'Guest data is deleted after 30 days.' }}
>
	{#snippet template(args)}
		<LoginUIFrame><RuntimeScreenHarness {...args} /></LoginUIFrame>
	{/snippet}
</Story>

<Story
	name="Code input: email code"
	args={{
		screen: only(blocks.codeInput('mail_otp')),
		values: { mail_otp_resend_remaining: '42', mail_otp_resend_total: '60' }
	}}
>
	{#snippet template(args)}
		<LoginUIFrame><RuntimeScreenHarness {...args} /></LoginUIFrame>
	{/snippet}
</Story>

<Story
	name="Code input: email code, resend ready"
	args={{ screen: only(blocks.codeInput('mail_otp')), values: { mail_otp_resend_remaining: '0' } }}
>
	{#snippet template(args)}
		<LoginUIFrame><RuntimeScreenHarness {...args} /></LoginUIFrame>
	{/snippet}
</Story>

<Story name="Code input: authenticator app" args={{ screen: only(blocks.codeInput('totp')) }}>
	{#snippet template(args)}
		<LoginUIFrame><RuntimeScreenHarness {...args} /></LoginUIFrame>
	{/snippet}
</Story>

<Story
	name="Code input: wrong code"
	args={{
		screen: only(blocks.codeInput('mail_otp')),
		values: { mail_otp_code: '123456' },
		errors: { mail_otp_code: 'The code is not correct.' }
	}}
>
	{#snippet template(args)}
		<LoginUIFrame><RuntimeScreenHarness {...args} /></LoginUIFrame>
	{/snippet}
</Story>

<Story
	name="Consent widget"
	args={{ screen: only(blocks.consent()), withConsent: true, mode: 'signup' }}
>
	{#snippet template(args)}
		<LoginUIFrame><RuntimeScreenHarness {...args} /></LoginUIFrame>
	{/snippet}
</Story>

<Story
	name="Consent widget: shared fields"
	args={{
		screen: only(blocks.consent()),
		withConsent: true,
		withDestinationFields: true,
		mode: 'signup'
	}}
>
	{#snippet template(args)}
		<LoginUIFrame><RuntimeScreenHarness {...args} /></LoginUIFrame>
	{/snippet}
</Story>

<Story
	name="Consent widget: no policy attached"
	args={{ screen: only(blocks.consent()), mode: 'signup' }}
>
	{#snippet template(args)}
		<LoginUIFrame><RuntimeScreenHarness {...args} /></LoginUIFrame>
	{/snippet}
</Story>

<Story
	name="Security verification"
	args={{ screen: only(blocks.security('initial')), humanVerification: true }}
>
	{#snippet template(args)}
		<LoginUIFrame><RuntimeScreenHarness {...args} /></LoginUIFrame>
	{/snippet}
</Story>

<Story
	name="Identity fields"
	args={{
		screen: only(
			blocks.email(),
			{ ...blocks.name('given_name', 'First name'), help_text: 'As on your passport.' },
			blocks.name('family_name', 'Last name'),
			blocks.checkbox('newsletter', 'Newsletter', 'Send me product news')
		),
		mode: 'signup',
		errors: { family_name: 'Enter your last name.' }
	}}
>
	{#snippet template(args)}
		<LoginUIFrame><RuntimeScreenHarness {...args} /></LoginUIFrame>
	{/snippet}
</Story>

<Story
	name="Two-column row"
	args={{
		screen: only(
			blocks.row(2),
			blocks.name('given_name', 'First name', 1),
			blocks.name('family_name', 'Last name', 2),
			blocks.row(1, 'row-2'),
			blocks.email()
		),
		mode: 'signup'
	}}
>
	{#snippet template(args)}
		<LoginUIFrame><RuntimeScreenHarness {...args} /></LoginUIFrame>
	{/snippet}
</Story>

<Story
	name="Typing and choosing"
	args={{ screen: only(blocks.email(), blocks.mailOtp(), blocks.passkey()), mode: 'signup' }}
	play={async ({ canvasElement, args }) => {
		const canvas = within(canvasElement);
		await userEvent.type(canvas.getAllByRole('textbox')[0], 'ada@example.com');
		await expect(args.onAction).toHaveBeenCalledWith('field', {
			field: 'email',
			value: 'ada@example.com'
		});
		await userEvent.click(canvas.getAllByRole('button')[0]);
		await expect(args.onAction).toHaveBeenCalledWith('auth', {
			method: 'mail_otp',
			action: undefined
		});
	}}
>
	{#snippet template(args)}
		<LoginUIFrame><RuntimeScreenHarness {...args} /></LoginUIFrame>
	{/snippet}
</Story>
