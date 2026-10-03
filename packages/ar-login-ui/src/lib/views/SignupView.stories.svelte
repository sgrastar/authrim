<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { get } from 'svelte/store';
	import { LL } from '$i18n/i18n-svelte';
	import { expect, fn, userEvent, within } from 'storybook/test';
	import AuthPageShell from '$lib/components/AuthPageShell.svelte';
	import LoginUIFrame from '$lib/storybook/LoginUIFrame.svelte';
	import {
		consentPolicy,
		externalProviders as sampleProviders,
		registrationScreen
	} from '$lib/storybook/fixtures';
	import type {
		ExternalProviderButton,
		HumanVerificationView,
		RuntimeScreenState,
		RuntimeStepView
	} from './auth-entry-types';
	import SignupView, { type RegistrationFieldView } from './SignupView.svelte';

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
		action: 'authrim-signup',
		theme: 'light',
		language: 'en',
		resetKey: 0,
		runtimeRequired: false,
		runtimeVisible: false
	};

	const providers: ExternalProviderButton[] = sampleProviders.slice(0, 2).map((provider) => ({
		...provider,
		text: `Continue with ${provider.label}`
	}));

	const allMethods = { passkey: true, emailCode: true, totp: true, external: true, any: true };

	const runtime: RuntimeScreenState = {
		fieldValues: {},
		methodAvailability: {
			passkey: true,
			mail_otp: true,
			mail_otp_totp: true,
			totp: true,
			external_idp: true,
			directory_password: false
		},
		methodLoading: {},
		destinationFieldDecisions: {},
		consentSelectedValues: {},
		consentReady: true,
		loading: false
	};

	const field = (
		key: string,
		kind: RegistrationFieldView['kind'],
		label: string,
		extra: Partial<RegistrationFieldView> = {}
	): RegistrationFieldView => ({
		key,
		kind,
		label,
		placeholder: null,
		required: false,
		options: [],
		...extra
	});

	const registrationFields: RegistrationFieldView[] = [
		field('name', 'name', 'Name *', { required: true }),
		field('email', 'email', 'Email *', { required: true }),
		field('company', 'text', 'Company'),
		field('plan', 'enum', 'Plan *', { required: true, options: ['Free', 'Team', 'Enterprise'] }),
		field('birthdate', 'date', 'Date of birth'),
		field('seats', 'number', 'Seats'),
		field('newsletter', 'boolean', 'Send me product news')
	];

	const { Story } = defineMeta({
		title: 'Screens/Sign up',
		component: SignupView,
		tags: ['autodocs'],
		args: {
			title: 'Create your account',
			humanVerification,
			methods: allMethods,
			externalProviders: providers,
			loginHref: '/login',
			onSubmit: fn(),
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
			onCustomFieldChange: fn(),
			onPasskey: fn(),
			onEmailCode: fn(),
			onEmailKeyPress: fn(),
			onTotpStart: fn(),
			onTotpActivate: fn(),
			onTotpCancel: fn(),
			onTotpDone: fn(),
			onExternalProvider: fn()
		},
		parameters: {
			layout: 'fullscreen',
			docs: {
				description: {
					component:
						'The account-creation page. With an Admin console screen for the current flow step it draws that screen; without one it falls back to the classic layout: the registration fields the tenant asks for, then passkey, email code, authenticator app and external providers, and the terms note. The route (`src/routes/signup`) loads the fields and methods, validates, runs WebAuthn and the requests; this view draws what it is given.'
				}
			}
		}
	});
</script>

{#snippet page(args: Parameters<typeof SignupView>[1])}
	<LoginUIFrame fit="page">
		<AuthPageShell wide={isWide(args.runtimeStep)}>
			<SignupView {...args} />
		</AuthPageShell>
	</LoginUIFrame>
{/snippet}

<Story name="Loading" args={{ initialLoading: true }}>
	{#snippet template(args)}{@render page(args)}{/snippet}
</Story>

<Story
	name="Classic layout with terms"
	play={async ({ args, canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(
			canvas.getByRole('button', { name: get(LL).register_createWithPasskey() })
		);
		await expect(args.onPasskey).toHaveBeenCalled();
	}}
>
	{#snippet template(args)}{@render page(args)}{/snippet}
</Story>

<Story
	name="Registration fields with errors"
	args={{
		methods: { passkey: true, emailCode: true, any: true },
		registrationFields,
		// The route starts every custom field at '' ('false' for a checkbox) when it loads them.
		customFieldValues: { company: '', plan: '', birthdate: '', seats: '', newsletter: 'false' },
		email: 'ada@',
		emailError: 'Enter a valid email address.',
		nameError: 'Name is required.',
		customFieldErrors: { plan: 'Plan is required.', newsletter: 'Choose whether to receive news.' }
	}}
>
	{#snippet template(args)}{@render page(args)}{/snippet}
</Story>

<Story name="Invitation" args={{ inviteTenantName: 'Acme Corp' }}>
	{#snippet template(args)}{@render page(args)}{/snippet}
</Story>

<Story
	name="Runtime screen"
	args={{
		legacyHeading: false,
		legacyMethods: false,
		runtimeStep: {
			component: 'registration',
			isAuthStep: true,
			screen: registrationScreen,
			title: registrationScreen.display_name,
			description: '',
			consentPolicy,
			destinationFieldConsent: null
		},
		runtime,
		consentDecisions: { tos: false, newsletter: false, privacy: true }
	}}
>
	{#snippet template(args)}{@render page(args)}{/snippet}
</Story>

<Story
	name="Authenticator app setup"
	args={{
		methods: { totp: true, any: true },
		totpSetup: { secret: 'JBSWY3DPEHPK3PXP', qrDataUrl: '', backupCodes: [] },
		totpCode: '123456'
	}}
>
	{#snippet template(args)}{@render page(args)}{/snippet}
</Story>

<Story
	name="Authenticator backup codes"
	args={{
		methods: { totp: true, any: true },
		totpSetup: {
			secret: 'JBSWY3DPEHPK3PXP',
			qrDataUrl: '',
			backupCodes: ['4F7K-2M9Q', '8XQ2-71LD', 'P3ZT-6WNE', 'K9RA-04YB']
		}
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
			description: 'Review the terms for your new account.',
			consentPolicy,
			destinationFieldConsent: null
		},
		runtime: { ...runtime, consentReady: false },
		consentDecisions: { tos: false, newsletter: false, privacy: true }
	}}
>
	{#snippet template(args)}{@render page(args)}{/snippet}
</Story>

<Story name="Failed" args={{ alerts: { error: 'Could not create your account. Try again.' } }}>
	{#snippet template(args)}{@render page(args)}{/snippet}
</Story>

<Story
	name="Methods failed to load"
	args={{ methods: { any: false }, methodsError: 'Failed to load sign-up methods.' }}
>
	{#snippet template(args)}{@render page(args)}{/snippet}
</Story>

<Story name="No methods available" args={{ methods: { any: false } }}>
	{#snippet template(args)}{@render page(args)}{/snippet}
</Story>
