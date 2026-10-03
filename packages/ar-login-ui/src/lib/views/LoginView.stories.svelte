<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { get } from 'svelte/store';
	import { LL } from '$i18n/i18n-svelte';
	import { expect, fn, userEvent, within } from 'storybook/test';
	import type { FlowRuntimeConsentPolicyContent } from '$lib/api/flow-runtime';
	import AuthPageShell from '$lib/components/AuthPageShell.svelte';
	import LoginUIFrame from '$lib/storybook/LoginUIFrame.svelte';
	import {
		consentPolicy,
		defaultLoginScreen,
		destinationFieldConsent,
		externalProviders as sampleProviders,
		type SampleScreen
	} from '$lib/storybook/fixtures';
	import type {
		ExternalProviderButton,
		HumanVerificationView,
		RuntimeScreenState,
		RuntimeStepView
	} from './auth-entry-types';
	import LoginView, { type LoginClientInfo } from './LoginView.svelte';

	/** The route widens the shell for a screen saved with the wide canvas. */
	const isWide = (step: RuntimeStepView | null | undefined): boolean => {
		const settings = step?.screen?.settings;
		return (
			typeof settings === 'object' &&
			settings !== null &&
			(settings as Record<string, unknown>).canvas_layout === 'wide'
		);
	};

	const humanVerification: HumanVerificationView = {
		siteKey: null,
		provider: 'turnstile',
		mode: 'managed',
		action: 'authrim-login',
		theme: 'light',
		language: 'en',
		resetKey: 0,
		runtimeRequired: false,
		runtimeVisible: false
	};

	/** What the route maps the tenant's providers to (button text as `login_continueWith` gives it). */
	const providers: ExternalProviderButton[] = sampleProviders.map((provider) => ({
		...provider,
		text: `Continue with ${provider.label}`
	}));

	const allMethods = {
		passkey: true,
		directoryPassword: true,
		emailCode: true,
		totp: true,
		external: true,
		any: true
	};

	const runtime = (overrides: Partial<RuntimeScreenState> = {}): RuntimeScreenState => ({
		fieldValues: {},
		methodAvailability: {
			passkey: true,
			mail_otp: true,
			mail_otp_totp: true,
			totp: true,
			directory_password: true,
			external_idp: true
		},
		methodLoading: {},
		destinationFieldDecisions: {},
		consentSelectedValues: {},
		consentReady: true,
		loading: false,
		...overrides
	});

	const screenStep = (screen: SampleScreen): RuntimeStepView => ({
		component: 'login',
		isAuthStep: true,
		screen,
		title: screen.display_name,
		description: '',
		consentPolicy: null,
		destinationFieldConsent: null
	});

	/** The consent fixture plus a choice item, which only the login page draws as radios. */
	const consentWithChoice: FlowRuntimeConsentPolicyContent = {
		...consentPolicy,
		items: [
			...consentPolicy.items,
			{
				...consentPolicy.items[1],
				statement_id: 'contact',
				slug: 'contact',
				title: 'How should we reach you?',
				description: 'Choose one.',
				content_mode: 'radio',
				checkbox_mode: 'none',
				is_required: true,
				display_order: 3,
				options: [
					{ id: 'email', value: 'email', label: 'By email', description: '' },
					{ id: 'sms', value: 'sms', label: 'By text message', description: '' }
				]
			}
		]
	};

	const client: LoginClientInfo = {
		client_id: 'dashboard',
		client_name: 'Acme Dashboard',
		client_uri: 'https://example.com',
		policy_uri: 'https://example.com/privacy',
		tos_uri: 'https://example.com/terms'
	};

	const { Story } = defineMeta({
		title: 'Screens/Login',
		component: LoginView,
		tags: ['autodocs'],
		args: {
			title: 'Sign in',
			humanVerification,
			methods: allMethods,
			directoryPasswordLabel: 'Organization ID',
			externalProviders: providers,
			signupHref: '/signup',
			onSubmit: fn(),
			onDismissExternalIdpError: fn(),
			onDismissError: fn(),
			onDismissRuntimeFlowError: fn(),
			onRuntimeFieldValueChange: fn(),
			onRuntimeAuthAction: fn(),
			onConsentDecisionChange: fn(),
			onDestinationFieldDecisionChange: fn(),
			onConsentSelectedValueChange: fn(),
			onRuntimeContinue: fn(),
			onRuntimeAccept: fn(),
			onRuntimeComplete: fn(),
			onGuestLogin: fn(),
			onPasskey: fn(),
			onEmailCode: fn(),
			onEmailKeyPress: fn(),
			onDirectoryPassword: fn(),
			onDirectoryKeyPress: fn(),
			onTotpStart: fn(),
			onTotpVerify: fn(),
			onTotpKeyPress: fn(),
			onTotpBack: fn(),
			onExternalProvider: fn(),
			onMigrationPasskey: fn(),
			onMigrationEmailSend: fn(),
			onMigrationEmailVerify: fn()
		},
		parameters: {
			layout: 'fullscreen',
			docs: {
				description: {
					component:
						'The sign-in page. With an Admin console screen for the current flow step it draws that screen; without one it falls back to the classic layout (passkey, directory password, email code, authenticator app, external providers). The route (`src/routes/login`) loads the methods and the flow, runs WebAuthn and the requests, and redirects; this view draws what it is given.'
				}
			}
		}
	});
</script>

{#snippet page(args: Parameters<typeof LoginView>[1])}
	<LoginUIFrame fit="page">
		<AuthPageShell wide={isWide(args.runtimeStep)}>
			<LoginView {...args} />
		</AuthPageShell>
	</LoginUIFrame>
{/snippet}

<Story name="Loading" args={{ initialLoading: true }}>
	{#snippet template(args)}{@render page(args)}{/snippet}
</Story>

<Story name="Methods failed to load" args={{ methodsError: 'Failed to load sign-in methods.' }}>
	{#snippet template(args)}{@render page(args)}{/snippet}
</Story>

<Story
	name="Runtime screen"
	args={{
		legacyHeading: false,
		legacyMethods: false,
		runtimeStep: screenStep(defaultLoginScreen),
		runtime: runtime(),
		guest: { enabled: true, retentionDescription: 'Guest accounts are deleted after 30 days.' }
	}}
>
	{#snippet template(args)}{@render page(args)}{/snippet}
</Story>

<Story
	name="Classic layout"
	play={async ({ args, canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(canvas.getByRole('button', { name: get(LL).login_signInWithPasskey() }));
		await expect(args.onPasskey).toHaveBeenCalled();
	}}
>
	{#snippet template(args)}{@render page(args)}{/snippet}
</Story>

<Story
	name="Authenticator code requested"
	args={{ methods: { totp: true, any: true }, totpCodeRequested: true }}
>
	{#snippet template(args)}{@render page(args)}{/snippet}
</Story>

<Story
	name="Signing in to an application (loading)"
	args={{ client: { loading: true, info: null } }}
>
	{#snippet template(args)}{@render page(args)}{/snippet}
</Story>

<Story
	name="Signing in to an application"
	args={{ client: { loading: false, info: client }, methods: { passkey: true, any: true } }}
>
	{#snippet template(args)}{@render page(args)}{/snippet}
</Story>

<Story
	name="External provider error"
	args={{
		alerts: {
			externalIdp: {
				title: 'An account already exists',
				message: 'Sign in with your existing method first, then link this provider.',
				action: 'Use your passkey or email code below.'
			}
		}
	}}
>
	{#snippet template(args)}{@render page(args)}{/snippet}
</Story>

<Story name="Failed" args={{ alerts: { error: 'Sign-in failed. Try again.' } }}>
	{#snippet template(args)}{@render page(args)}{/snippet}
</Story>

<Story
	name="Waiting on a passkey and an email code"
	args={{
		alerts: {
			passkeyProgress: 'Waiting for your passkey…',
			emailCodeProgress: 'Send code — Loading…'
		},
		loading: { passkey: true },
		busy: true,
		disabled: true
	}}
>
	{#snippet template(args)}{@render page(args)}{/snippet}
</Story>

<Story
	name="Directory account migration"
	args={{
		methods: { directoryPassword: true, any: true },
		migration: {
			notice: 'Your organization account is moving to passkeys. Create one to keep signing in.',
			passkey: true,
			emailFallback: true,
			codeSent: true
		},
		migrationEmailCode: '123'
	}}
>
	{#snippet template(args)}{@render page(args)}{/snippet}
</Story>

<Story
	name="Consent step without a screen"
	args={{
		legacyHeading: false,
		legacyMethods: false,
		runtimeStep: {
			component: 'consent_policy',
			isAuthStep: false,
			screen: null,
			title: 'Before you continue',
			description: 'Review what Acme Dashboard will receive.',
			consentPolicy: consentWithChoice,
			destinationFieldConsent
		},
		runtime: runtime({
			destinationFieldDecisions: { email: true, phone_number: true },
			consentReady: false
		}),
		consentDecisions: { tos: false, newsletter: false, privacy: true }
	}}
>
	{#snippet template(args)}{@render page(args)}{/snippet}
</Story>

<Story name="No methods available" args={{ methods: { any: false } }}>
	{#snippet template(args)}{@render page(args)}{/snippet}
</Story>
