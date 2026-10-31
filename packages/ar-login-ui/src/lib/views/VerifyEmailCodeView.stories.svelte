<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, fn, within } from 'storybook/test';
	import AuthPageShell from '$lib/components/AuthPageShell.svelte';
	import LoginUIFrame from '$lib/storybook/LoginUIFrame.svelte';
	import VerifyEmailCodeView from './VerifyEmailCodeView.svelte';

	const { Story } = defineMeta({
		title: 'Screens/Email code',
		component: VerifyEmailCodeView,
		tags: ['autodocs'],
		args: {
			email: 'taro.yamada@example.com',
			code: '',
			countdown: 42,
			canResend: false,
			onCodeChange: fn(),
			onVerify: fn(),
			onResend: fn(),
			onDismissError: fn(),
			onDismissSuccess: fn(),
			onDismissResendNotice: fn()
		},
		parameters: {
			layout: 'fullscreen',
			docs: {
				description: {
					component:
						'Where a person types the six-digit code sent to their email. It shows the same accepted status whether or not the address has an account. The route (`src/routes/verify-email-code`) owns the requests and the resend countdown.'
				}
			}
		}
	});
</script>

{#snippet page(args: Parameters<typeof VerifyEmailCodeView>[1])}
	<LoginUIFrame fit="page">
		<AuthPageShell><VerifyEmailCodeView {...args} /></AuthPageShell>
	</LoginUIFrame>
{/snippet}

<Story
	name="Code sent"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.getByRole('status')).toHaveTextContent('taro.yamada@example.com');
	}}
>
	{#snippet template(args)}{@render page(args)}{/snippet}
</Story>

<Story name="Code complete" args={{ code: '482913' }}>
	{#snippet template(args)}{@render page(args)}{/snippet}
</Story>

<Story name="Verifying" args={{ code: '482913', loading: true }}>
	{#snippet template(args)}{@render page(args)}{/snippet}
</Story>

<Story name="Wrong code" args={{ code: '482910', error: 'The code is incorrect or has expired.' }}>
	{#snippet template(args)}{@render page(args)}{/snippet}
</Story>

<Story name="Can resend" args={{ canResend: true, countdown: 0 }}>
	{#snippet template(args)}{@render page(args)}{/snippet}
</Story>

<Story name="Resent" args={{ countdown: 60, resendNotice: 'A new code has been sent.' }}>
	{#snippet template(args)}{@render page(args)}{/snippet}
</Story>

<Story name="Verified" args={{ code: '482913', success: 'Verified. Signing you in…' }}>
	{#snippet template(args)}{@render page(args)}{/snippet}
</Story>
