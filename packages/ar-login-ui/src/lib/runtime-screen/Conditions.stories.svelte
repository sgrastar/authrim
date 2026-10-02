<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, fn, within } from 'storybook/test';
	import LoginUIFrame from '$lib/storybook/LoginUIFrame.svelte';
	import { blocks, defaultLoginScreen, screenOf } from '$lib/storybook/fixtures';
	import RuntimeScreenHarness from '$lib/storybook/RuntimeScreenHarness.svelte';

	const METHODS = [
		'passkey',
		'mail_otp',
		'mail_otp_totp',
		'totp',
		'external_idp',
		'directory_password'
	];

	const { Story } = defineMeta({
		title: 'Runtime screen/Conditions',
		component: RuntimeScreenHarness,
		tags: ['autodocs'],
		args: { onAction: fn() },
		argTypes: {
			unavailable: {
				control: 'check',
				options: METHODS,
				description:
					'Authentication methods the tenant has switched off or the flow does not offer.'
			}
		},
		parameters: {
			docs: {
				description: {
					component:
						'What the Admin console can do with the blocks of a screen, and what the login page then shows:\n\n' +
						'| Setting in the Admin console | Effect |\n| --- | --- |\n' +
						'| Block order and layout rows | Blocks render in saved order; a **layout row** starts a new row of 1 or 2 columns and owns the blocks after it. |\n' +
						'| `display_condition: hidden` | The block is never shown. On a layout row, every block of that row is hidden. |\n' +
						'| `display_condition: feature_enabled` | Shown only while that authentication method is available. Use it on a divider so it disappears with the method it separates. |\n' +
						'| Auth widget whose method is off | Hidden even without a condition. |\n' +
						'| Guest widget | Login only, and only if guest access is on. |\n' +
						'| Security verification | Only when human verification is required for the step; "after submit" shows it after a first attempt. |\n\n' +
						'Use the **Controls** panel to switch methods off and watch the screen and its dividers follow.'
				}
			}
		}
	});
</script>

<Story name="Method availability" args={{ screen: defaultLoginScreen, unavailable: [] }}>
	{#snippet template(args)}
		<LoginUIFrame><RuntimeScreenHarness {...args} /></LoginUIFrame>
	{/snippet}
</Story>

<Story
	name="Only passkey"
	args={{
		screen: defaultLoginScreen,
		unavailable: ['mail_otp', 'mail_otp_totp', 'totp', 'external_idp', 'directory_password'],
		guest: false
	}}
>
	{#snippet template(args)}
		<LoginUIFrame><RuntimeScreenHarness {...args} /></LoginUIFrame>
	{/snippet}
</Story>

<Story
	name="No passkey, email code and providers"
	args={{
		screen: defaultLoginScreen,
		unavailable: ['passkey', 'totp', 'directory_password'],
		guest: false
	}}
>
	{#snippet template(args)}
		<LoginUIFrame><RuntimeScreenHarness {...args} /></LoginUIFrame>
	{/snippet}
</Story>

<Story
	name="Hidden block"
	args={{
		screen: screenOf([
			blocks.heading('Sign in'),
			blocks.passkey(),
			blocks.when(blocks.mailOtp(), 'hidden'),
			blocks.when(blocks.text('This block is set to hidden; the one above it too.'), 'hidden')
		])
	}}
>
	{#snippet template(args)}
		<LoginUIFrame><RuntimeScreenHarness {...args} /></LoginUIFrame>
	{/snippet}
</Story>

<Story
	name="Hidden layout row"
	args={{
		screen: screenOf([
			blocks.heading('Create your account'),
			blocks.when(blocks.row(2), 'hidden'),
			blocks.name('given_name', 'First name', 1),
			blocks.name('family_name', 'Last name', 2),
			blocks.row(1, 'row-2'),
			blocks.email()
		]),
		mode: 'signup'
	}}
>
	{#snippet template(args)}
		<LoginUIFrame><RuntimeScreenHarness {...args} /></LoginUIFrame>
	{/snippet}
</Story>

<Story
	name="Block shown only with a method"
	args={{
		screen: screenOf([
			blocks.heading('Sign in'),
			blocks.passkey(),
			blocks.when(blocks.text('Shown only while email code is available.'), {
				feature: 'mail_otp'
			}),
			blocks.mailOtp()
		]),
		unavailable: ['mail_otp']
	}}
>
	{#snippet template(args)}
		<LoginUIFrame><RuntimeScreenHarness {...args} /></LoginUIFrame>
	{/snippet}
</Story>

<Story
	name="Guest on signup"
	args={{
		screen: screenOf([
			blocks.heading('Create your account'),
			blocks.passkey('Create Account with Passkey'),
			blocks.guest()
		]),
		mode: 'signup'
	}}
>
	{#snippet template(args)}
		<LoginUIFrame><RuntimeScreenHarness {...args} /></LoginUIFrame>
	{/snippet}
</Story>

<Story
	name="Security verification after submit"
	args={{
		screen: screenOf([blocks.heading('Sign in'), blocks.passkey(), blocks.security('submit')]),
		humanVerification: true,
		humanVerificationVisible: false
	}}
>
	{#snippet template(args)}
		<LoginUIFrame><RuntimeScreenHarness {...args} /></LoginUIFrame>
	{/snippet}
</Story>

<Story
	name="Security verification shown after submit"
	args={{
		screen: screenOf([blocks.heading('Sign in'), blocks.passkey(), blocks.security('submit')]),
		humanVerification: true,
		humanVerificationVisible: true
	}}
>
	{#snippet template(args)}
		<LoginUIFrame><RuntimeScreenHarness {...args} /></LoginUIFrame>
	{/snippet}
</Story>

<Story
	name="Reordered blocks"
	args={{
		screen: screenOf([
			blocks.heading('Sign in'),
			blocks.mailOtp(),
			blocks.divider('or', 'passkey'),
			blocks.passkey(),
			blocks.externalIdp(true)
		])
	}}
>
	{#snippet template(args)}
		<LoginUIFrame><RuntimeScreenHarness {...args} /></LoginUIFrame>
	{/snippet}
</Story>

<Story
	name="Switching a method off removes its widget"
	args={{ screen: defaultLoginScreen, unavailable: ['passkey'] }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.queryByText(/passkey/i)).toBeNull();
		await expect(canvas.getAllByRole('button').length).toBeGreaterThan(0);
	}}
>
	{#snippet template(args)}
		<LoginUIFrame><RuntimeScreenHarness {...args} /></LoginUIFrame>
	{/snippet}
</Story>
