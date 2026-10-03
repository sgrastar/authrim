<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { fn } from 'storybook/test';
	import AuthPageShell from '$lib/components/AuthPageShell.svelte';
	import LoginUIFrame from '$lib/storybook/LoginUIFrame.svelte';
	import ReauthView, { type ChallengeData } from './ReauthView.svelte';

	const { Story } = defineMeta({
		title: 'Screens/Re-authentication',
		component: ReauthView,
		tags: ['autodocs'],
		args: {
			onPasskey: fn(),
			onEmailCode: fn(),
			onTotpStart: fn(),
			onTotpVerify: fn(),
			onTotpKeyPress: fn(),
			onDismissError: fn()
		},
		parameters: {
			layout: 'fullscreen',
			docs: {
				description: {
					component:
						'Asks a signed-in user to prove it is still them, using any method the tenant allows for re-authentication. Dividers appear only between methods that are shown. The route (`src/routes/reauth`) owns the requests.'
				}
			}
		}
	});

	const challenge: ChallengeData = {
		client: { client_id: 'dashboard', client_name: 'Acme Dashboard' },
		user: { id: 'u1', email: 'ada@example.com' }
	};
</script>

{#snippet page(args: Parameters<typeof ReauthView>[1])}
	<LoginUIFrame fit="page">
		<AuthPageShell><ReauthView {...args} /></AuthPageShell>
	</LoginUIFrame>
{/snippet}

<Story name="Loading" args={{ loading: true }}>
	{#snippet template(args)}{@render page(args)}{/snippet}
</Story>

<Story
	name="All methods"
	args={{ challengeData: challenge, showPasskey: true, emailCodeEnabled: true, totpEnabled: true }}
>
	{#snippet template(args)}{@render page(args)}{/snippet}
</Story>

<Story name="Passkey only" args={{ challengeData: challenge, showPasskey: true }}>
	{#snippet template(args)}{@render page(args)}{/snippet}
</Story>

<Story name="Email code only" args={{ challengeData: challenge, emailCodeEnabled: true }}>
	{#snippet template(args)}{@render page(args)}{/snippet}
</Story>

<Story
	name="Authenticator code requested"
	args={{ challengeData: challenge, totpEnabled: true, totpCodeRequested: true }}
>
	{#snippet template(args)}{@render page(args)}{/snippet}
</Story>

<Story
	name="Waiting on a method"
	args={{
		challengeData: challenge,
		showPasskey: true,
		emailCodeEnabled: true,
		totpEnabled: true,
		emailCodeLoading: true,
		authActionLoading: true
	}}
>
	{#snippet template(args)}{@render page(args)}{/snippet}
</Story>

<Story
	name="Failed"
	args={{
		challengeData: challenge,
		showPasskey: true,
		emailCodeEnabled: true,
		error: 'Verification failed. Try another method.'
	}}
>
	{#snippet template(args)}{@render page(args)}{/snippet}
</Story>

<Story
	name="Human verification"
	args={{
		challengeData: challenge,
		showPasskey: true,
		emailCodeEnabled: true,
		turnstileSiteKey: 'storybook',
		showTurnstileFor: (target: string) => target === 'passkey'
	}}
>
	{#snippet template(args)}{@render page(args)}{/snippet}
</Story>
