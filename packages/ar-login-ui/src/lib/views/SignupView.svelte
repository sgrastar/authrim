<script module lang="ts">
	/** One registration field the tenant asks for, with its kind already resolved. */
	export type RegistrationFieldView = {
		key: string;
		/** `name` and `email` bind to the fixed inputs; the rest are custom fields. */
		kind: 'name' | 'email' | 'boolean' | 'enum' | 'date' | 'number' | 'text';
		/** The label, with " *" when the field is required. */
		label: string;
		placeholder: string | null;
		required: boolean;
		/** The choices of an `enum` field. */
		options: string[];
	};

	/** An authenticator app being set up: the secret first, then the backup codes once active. */
	export type TotpSetupView = {
		secret: string;
		/** The otpauth QR code as a data URL, or '' while it renders. */
		qrDataUrl: string;
		backupCodes: string[];
	};

	export type SignupAlerts = {
		error?: string;
		runtimeFlow?: string;
		/** The runtime step needs a screen the tenant has not configured. */
		runtimeScreenMissing?: boolean;
		passkeyProgress?: string;
		emailCodeProgress?: string;
	};

	/** The methods the classic layout offers (enabled by the tenant and allowed by the step). */
	export type SignupMethods = {
		passkey?: boolean;
		emailCode?: boolean;
		totp?: boolean;
		external?: boolean;
		/** At least one method is shown. */
		any?: boolean;
	};

	export type SignupLoading = {
		passkey?: boolean;
		emailCode?: boolean;
		totp?: boolean;
		/** The external provider whose sign-up is starting. */
		externalIdp?: string | null;
	};
</script>

<script lang="ts">
	/**
	 * The account-creation page, as the person sees it inside the page shell. The route
	 * (`src/routes/signup`) owns the state, validation, the requests, WebAuthn and the redirects;
	 * this view only draws what it is given and reports what the person does.
	 */
	import { Button, Input, Card, Alert } from '$lib/components';
	import AuthSwitchLink from '$lib/components/AuthSwitchLink.svelte';
	import RuntimeScreen from '$lib/components/RuntimeScreen.svelte';
	import { LL } from '$i18n/i18n-svelte';
	import type { RuntimeAuthMethod } from '$lib/authrim/runtime-auth-handles';
	import type {
		EmailVerificationView,
		ExternalProviderButton,
		HumanVerificationView,
		RuntimeScreenState,
		RuntimeStepView
	} from './auth-entry-types';
	import ExternalProviderStack from './parts/ExternalProviderStack.svelte';
	import HumanVerification from './parts/HumanVerification.svelte';
	import RuntimeFallbackPanel from './parts/RuntimeFallbackPanel.svelte';

	type RuntimeAuthAction = Parameters<
		NonNullable<NonNullable<Parameters<typeof RuntimeScreen>[1]>['onAuthAction']>
	>[1];

	type Props = {
		/** The methods and the runtime contract are still loading. */
		initialLoading?: boolean;
		methodsLoading?: boolean;
		methodsError?: string;
		title: string;
		/** The tenant that invited the person, for the subtitle. */
		inviteTenantName?: string;
		/** Show the title block (off while a runtime screen or a blocked flow takes the card). */
		legacyHeading?: boolean;
		/** Show the classic fields and method buttons (off while a runtime screen draws them). */
		legacyMethods?: boolean;
		alerts?: SignupAlerts;
		/** The runtime step to draw, or null when the step draws nothing of its own. */
		runtimeStep?: RuntimeStepView | null;
		runtime?: RuntimeScreenState;
		/** The runtime screen has no verification block, so the page draws the widget under it. */
		runtimeHumanVerification?: boolean;
		methods?: SignupMethods;
		loading?: SignupLoading;
		/** Any action is in progress. */
		busy?: boolean;
		registrationFields?: RegistrationFieldView[];
		nameError?: string;
		emailError?: string;
		customFieldErrors?: Record<string, string>;
		totpSetup?: TotpSetupView | null;
		externalProviders?: ExternalProviderButton[];
		emailVerification?: EmailVerificationView;
		humanVerification: HumanVerificationView;
		/** Whether the human-verification widget shows under the given method. */
		showTurnstileFor?: (target: string) => boolean;
		/** The "Already have an account?" link, or null when the tenant hides it. */
		loginHref?: string | null;
		name?: string;
		email?: string;
		customFieldValues?: Record<string, string>;
		totpCode?: string;
		turnstileToken?: string;
		consentDecisions?: Record<string, boolean>;
		onSubmit?: (event: SubmitEvent) => void;
		onDismissError?: () => void;
		onDismissRuntimeFlowError?: () => void;
		onRuntimeFieldValueChange?: (field: string, value: string | boolean) => void;
		onRuntimeAuthAction?: (method: RuntimeAuthMethod, action?: RuntimeAuthAction) => void;
		onConsentDecisionChange?: (statementId: string, checked: boolean) => void;
		onDestinationFieldDecisionChange?: (fieldKey: string, checked: boolean) => void;
		onConsentSelectedValueChange?: (statementId: string, value: string) => void;
		/** Continue past a runtime screen that is not an authentication step. */
		onRuntimeContinue?: () => void;
		/** Continue past a plain consent step, with the answers. */
		onRuntimeAccept?: () => void;
		/** Continue past any other plain step. */
		onRuntimeComplete?: () => void;
		onCustomFieldChange?: (fieldKey: string, value: string) => void;
		onPasskey?: () => void;
		onEmailCode?: () => void;
		onEmailKeyPress?: (event: KeyboardEvent) => void;
		onTotpStart?: () => void;
		onTotpActivate?: () => void;
		onTotpCancel?: () => void;
		/** Leave the backup codes and finish signing up. */
		onTotpDone?: () => void;
		onExternalProvider?: (providerId: string) => void;
	};

	let {
		initialLoading = false,
		methodsLoading = false,
		methodsError = '',
		title,
		inviteTenantName = '',
		legacyHeading = true,
		legacyMethods = true,
		alerts = {},
		runtimeStep = null,
		runtime = {
			fieldValues: {},
			methodAvailability: {},
			methodLoading: {},
			destinationFieldDecisions: {},
			consentSelectedValues: {},
			consentReady: true,
			loading: false
		},
		runtimeHumanVerification = false,
		methods = {},
		loading = {},
		busy = false,
		registrationFields = [],
		nameError = '',
		emailError = '',
		customFieldErrors = {},
		totpSetup = null,
		externalProviders = [],
		emailVerification = { enabled: false, nonce: null },
		humanVerification,
		showTurnstileFor = () => false,
		loginHref = null,
		name = $bindable(''),
		email = $bindable(''),
		customFieldValues = $bindable({}),
		totpCode = $bindable(''),
		turnstileToken = $bindable(''),
		consentDecisions = $bindable({}),
		onSubmit,
		onDismissError,
		onDismissRuntimeFlowError,
		onRuntimeFieldValueChange,
		onRuntimeAuthAction,
		onConsentDecisionChange,
		onDestinationFieldDecisionChange,
		onConsentSelectedValueChange,
		onRuntimeContinue,
		onRuntimeAccept,
		onRuntimeComplete,
		onCustomFieldChange,
		onPasskey,
		onEmailCode,
		onEmailKeyPress,
		onTotpStart,
		onTotpActivate,
		onTotpCancel,
		onTotpDone,
		onExternalProvider
	}: Props = $props();

	const emailVerificationTokenAutocomplete = 'email-verification-token' as never;
</script>

<!-- Loading State -->
{#if initialLoading}
	<div class="auth-initial-loading" role="status">
		<span class="sr-only">{$LL.common_loading()}</span>
	</div>
{:else}
	<!-- Registration Card -->
	<form class="auth-entry-form" onsubmit={onSubmit}>
		{#if emailVerification.nonce}
			<input
				type="hidden"
				name="email_verification_token"
				nonce={emailVerification.nonce}
				autocomplete={emailVerificationTokenAutocomplete}
			/>
		{/if}
		<Card class="mb-6">
			{#if legacyHeading}
				<div class="mb-6">
					<h2 class="auth-section-title">
						{title}
					</h2>
					{#if inviteTenantName}
						<p class="auth-section-subtitle">
							{$LL.register_invitation({ tenant: inviteTenantName })}
						</p>
					{:else}
						<p class="auth-section-subtitle">
							{$LL.register_subtitle()}
						</p>
					{/if}
				</div>
			{/if}

			<!-- Error Alert -->
			{#if alerts.error}
				<Alert variant="error" dismissible={true} onDismiss={onDismissError} class="mb-4">
					{alerts.error}
				</Alert>
			{/if}

			{#if alerts.runtimeFlow}
				<Alert
					variant="error"
					dismissible={true}
					onDismiss={onDismissRuntimeFlowError}
					class="mb-4"
				>
					{alerts.runtimeFlow}
				</Alert>
			{/if}

			{#if alerts.runtimeScreenMissing}
				<Alert variant="error" class="mb-4">
					{$LL.runtime_screenUnavailable()}
				</Alert>
			{/if}

			{#if alerts.passkeyProgress}
				<div class="auth-progress mb-4" role="status" aria-live="polite">
					<span class="auth-progress__spinner" aria-hidden="true"></span>
					<span>{alerts.passkeyProgress}</span>
				</div>
			{/if}

			{#if alerts.emailCodeProgress}
				<div class="auth-progress mb-4" role="status" aria-live="polite">
					<span class="auth-progress__spinner" aria-hidden="true"></span>
					<span>{alerts.emailCodeProgress}</span>
				</div>
			{/if}

			{#if runtimeStep}
				{#if runtimeStep.screen}
					<div class="runtime-screen-step mb-4">
						<RuntimeScreen
							screen={runtimeStep.screen}
							headingOverride={title}
							disabled={busy}
							authMethodMode="signup"
							fieldValues={runtime.fieldValues}
							fieldErrors={{
								email: emailError,
								name: nameError,
								...customFieldErrors
							}}
							methodAvailability={runtime.methodAvailability}
							methodLoading={runtime.methodLoading}
							{externalProviders}
							consentPolicy={runtimeStep.consentPolicy}
							destinationFieldConsent={runtimeStep.destinationFieldConsent}
							{consentDecisions}
							destinationFieldDecisions={runtime.destinationFieldDecisions}
							consentSelectedValues={runtime.consentSelectedValues}
							consentReady={runtime.consentReady}
							humanVerificationRequired={humanVerification.runtimeRequired}
							humanVerificationSiteKey={humanVerification.siteKey}
							humanVerificationProvider={humanVerification.provider}
							humanVerificationMode={humanVerification.mode}
							humanVerificationAction={humanVerification.action}
							humanVerificationTheme={humanVerification.theme}
							humanVerificationLanguage={humanVerification.language}
							bind:humanVerificationToken={turnstileToken}
							humanVerificationResetKey={humanVerification.resetKey}
							humanVerificationVisible={humanVerification.runtimeVisible}
							humanVerificationLoadingLabel={$LL.login_humanVerificationLoading()}
							humanVerificationErrorLabel={$LL.login_humanVerificationLoadFailed()}
							emailVerificationProtocolEnabled={emailVerification.enabled}
							onFieldValueChange={onRuntimeFieldValueChange}
							onAuthAction={onRuntimeAuthAction}
							onExternalProviderAction={onExternalProvider}
							{onConsentDecisionChange}
							{onDestinationFieldDecisionChange}
							{onConsentSelectedValueChange}
						/>
						{#if runtimeHumanVerification && humanVerification.siteKey}
							<div class="runtime-screen-human-verification">
								<HumanVerification
									show
									verification={humanVerification}
									bind:token={turnstileToken}
									disabled={busy}
								/>
							</div>
						{/if}
						{#if !runtimeStep.isAuthStep}
							<Button
								variant="primary"
								class="w-full"
								loading={runtime.loading}
								disabled={busy || !runtime.consentReady}
								onclick={() => onRuntimeContinue?.()}
							>
								{$LL.common_continue()}
							</Button>
						{/if}
					</div>
				{:else}
					<RuntimeFallbackPanel
						step={runtimeStep}
						bind:decisions={consentDecisions}
						destinationFieldDecisions={runtime.destinationFieldDecisions}
						selectedValues={runtime.consentSelectedValues}
						consentReady={runtime.consentReady}
						loading={runtime.loading}
						{busy}
						disabled={busy}
						{onDestinationFieldDecisionChange}
						onSelectedValueChange={onConsentSelectedValueChange}
						onAccept={onRuntimeAccept}
						onComplete={onRuntimeComplete}
					/>
				{/if}
			{/if}

			{#if legacyMethods && !methodsLoading && (methodsError || !methods.any)}
				<Alert variant="error" class="mb-4">
					{methodsError || $LL.register_noMethodsAvailable()}
				</Alert>
			{/if}

			<!-- Registration Fields -->
			{#if legacyMethods && registrationFields.length > 0}
				{#each registrationFields as field (field.key)}
					<div class="mb-4">
						{#if field.kind === 'name'}
							<Input
								label={field.label}
								type="text"
								placeholder={field.placeholder ?? $LL.common_namePlaceholder()}
								bind:value={name}
								error={nameError}
								autocomplete="name"
								required={field.required}
							/>
						{:else if field.kind === 'email'}
							<Input
								label={field.label}
								type="email"
								name="email"
								placeholder={field.placeholder ?? $LL.common_emailPlaceholder()}
								bind:value={email}
								error={emailError}
								onkeypress={onEmailKeyPress}
								autocomplete="email"
								required={field.required}
							/>
						{:else if field.kind === 'boolean'}
							<label class="flex items-center gap-2" style="cursor: pointer;">
								<input
									type="checkbox"
									checked={customFieldValues[field.key] === 'true'}
									onchange={(e) => {
										onCustomFieldChange?.(
											field.key,
											(e.currentTarget as HTMLInputElement).checked ? 'true' : 'false'
										);
									}}
								/>
								<span style="font-size: 0.875rem; color: var(--text);">{field.label}</span>
							</label>
							{#if customFieldErrors[field.key]}
								<p class="custom-field-error">{customFieldErrors[field.key]}</p>
							{/if}
						{:else if field.kind === 'enum'}
							<div class="form-group">
								<label class="form-label" for={`signup-${field.key}`}>{field.label}</label>
								<select
									id={`signup-${field.key}`}
									class="custom-field-select"
									class:has-error={!!customFieldErrors[field.key]}
									value={customFieldValues[field.key]}
									onchange={(e) =>
										onCustomFieldChange?.(field.key, (e.currentTarget as HTMLSelectElement).value)}
								>
									<option value="">{field.placeholder ?? $LL.common_selectOption()}</option>
									{#each field.options as option (option)}
										<option value={option}>{option}</option>
									{/each}
								</select>
								{#if customFieldErrors[field.key]}
									<p class="custom-field-error">{customFieldErrors[field.key]}</p>
								{/if}
							</div>
						{:else if field.kind === 'date'}
							<Input
								label={field.label}
								type="date"
								placeholder={field.placeholder ?? ''}
								bind:value={customFieldValues[field.key]}
								error={customFieldErrors[field.key]}
								oninput={() => onCustomFieldChange?.(field.key, customFieldValues[field.key])}
								required={field.required}
							/>
						{:else if field.kind === 'number'}
							<Input
								label={field.label}
								type="number"
								placeholder={field.placeholder ?? ''}
								bind:value={customFieldValues[field.key]}
								error={customFieldErrors[field.key]}
								oninput={() => onCustomFieldChange?.(field.key, customFieldValues[field.key])}
								required={field.required}
							/>
						{:else}
							<Input
								label={field.label}
								type="text"
								placeholder={field.placeholder ?? ''}
								bind:value={customFieldValues[field.key]}
								error={customFieldErrors[field.key]}
								oninput={() => onCustomFieldChange?.(field.key, customFieldValues[field.key])}
								required={field.required}
							/>
						{/if}
					</div>
				{/each}
			{/if}

			<!-- Passkey Button -->
			{#if legacyMethods && methods.passkey}
				<Button
					variant="primary"
					class="w-full mb-3"
					loading={loading.passkey}
					disabled={busy}
					onclick={onPasskey}
				>
					<div class="i-heroicons-key h-5 w-5"></div>
					{$LL.register_createWithPasskey()}
				</Button>
				<HumanVerification
					show={showTurnstileFor('passkey')}
					verification={humanVerification}
					bind:token={turnstileToken}
					disabled={busy}
				/>

				{#if methods.emailCode}
					<div class="auth-divider">
						<div class="auth-divider__line"></div>
						<span class="auth-divider__text">{$LL.common_or()}</span>
						<div class="auth-divider__line"></div>
					</div>
				{/if}
			{/if}

			<!-- Email Code Button -->
			{#if legacyMethods && methods.emailCode}
				<Button
					variant="secondary"
					class="w-full"
					type={emailVerification.enabled ? 'submit' : 'button'}
					loading={loading.emailCode}
					disabled={busy}
					onclick={emailVerification.enabled ? undefined : () => onEmailCode?.()}
				>
					<div class="i-heroicons-envelope h-5 w-5"></div>
					{$LL.register_sendCode()}
				</Button>
				<HumanVerification
					show={showTurnstileFor('email-code')}
					verification={humanVerification}
					bind:token={turnstileToken}
					disabled={busy}
				/>
			{/if}

			<!-- TOTP Button and Setup -->
			{#if methods.totp && (legacyMethods || totpSetup)}
				{#if methods.passkey || methods.emailCode}
					<div class="auth-divider">
						<div class="auth-divider__line"></div>
						<span class="auth-divider__text">{$LL.common_or()}</span>
						<div class="auth-divider__line"></div>
					</div>
				{/if}

				{#if totpSetup}
					<div class="totp-signup-panel">
						{#if totpSetup.backupCodes.length > 0}
							<h3>{$LL.account_totpBackupCodes()}</h3>
							<ul class="totp-backup-codes">
								{#each totpSetup.backupCodes as backupCode (backupCode)}
									<li><code>{backupCode}</code></li>
								{/each}
							</ul>
							<Button variant="primary" class="w-full" disabled={busy} onclick={onTotpDone}>
								{$LL.common_continue()}
							</Button>
						{:else}
							<h3>{$LL.register_totpSetupTitle()}</h3>
							{#if totpSetup.qrDataUrl}
								<img
									class="totp-signup-qr"
									src={totpSetup.qrDataUrl}
									alt={$LL.account_totpQrAlt()}
								/>
							{/if}
							<div class="totp-manual-key">
								<span>{$LL.account_totpManualKey()}</span>
								<code>{totpSetup.secret}</code>
							</div>
							<Input
								label={$LL.login_totpCodeLabel()}
								placeholder={$LL.login_totpCodePlaceholder()}
								bind:value={totpCode}
								autocomplete="one-time-code"
								inputmode="numeric"
								maxlength={8}
							/>
							<div class="totp-signup-actions">
								<Button
									variant="primary"
									class="w-full"
									loading={loading.totp}
									disabled={!/^\d{6}$|^\d{8}$/.test(totpCode.trim())}
									onclick={onTotpActivate}
								>
									{$LL.account_totpActivate()}
								</Button>
								<Button
									variant="secondary"
									class="w-full"
									disabled={busy}
									onclick={() => onTotpCancel?.()}
								>
									{$LL.dialog_cancel()}
								</Button>
							</div>
						{/if}
					</div>
				{:else if legacyMethods}
					<Button
						variant="secondary"
						class="w-full"
						loading={loading.totp}
						disabled={busy}
						onclick={onTotpStart}
					>
						<div class="i-heroicons-device-phone-mobile h-5 w-5"></div>
						{$LL.register_createWithTotp()}
					</Button>
				{/if}
				<HumanVerification
					show={showTurnstileFor('totp')}
					verification={humanVerification}
					bind:token={turnstileToken}
					disabled={busy}
				/>
			{/if}

			<!-- External Login Section -->
			{#if legacyMethods && methods.external}
				<ExternalProviderStack
					providers={externalProviders}
					loadingId={loading.externalIdp}
					disabled={busy}
					{showTurnstileFor}
					verification={humanVerification}
					bind:token={turnstileToken}
					onSelect={onExternalProvider}
				/>
			{/if}

			<!-- Terms Agreement -->
			{#if legacyMethods}
				<p class="mt-4 text-xs text-center" style="color: var(--text-muted);">
					{$LL.register_termsAgreement()}
				</p>
			{/if}
		</Card>
	</form>
{/if}

<!-- Sign In Link -->
{#if loginHref}
	<p class="auth-bottom-link">
		<AuthSwitchLink
			href={loginHref}
			label={$LL.register_alreadyHaveAccount()}
			loadingLabel={$LL.common_loading()}
		/>
	</p>
{/if}

<style>
	.form-group {
		width: 100%;
	}

	.form-label {
		display: block;
		font-family: var(--font-display);
		font-size: 0.9375rem;
		font-weight: 600;
		color: var(--text-primary);
		margin-bottom: 8px;
	}

	.custom-field-select {
		width: 100%;
		padding: 12px 16px;
		background: var(--bg-glass);
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		font-size: 0.9375rem;
		font-family: var(--font-body);
		color: var(--text-primary);
		transition: all var(--transition-fast);
		backdrop-filter: var(--blur-sm);
		-webkit-backdrop-filter: var(--blur-sm);
	}

	.custom-field-select.has-error {
		border-color: var(--danger);
	}

	.custom-field-select:focus {
		outline: none;
		border-color: var(--primary);
		box-shadow: 0 0 0 4px var(--primary-light);
	}

	.custom-field-error {
		font-size: 0.8125rem;
		color: var(--danger);
		margin-top: 6px;
	}

	.runtime-screen-human-verification {
		display: grid;
		justify-items: center;
		width: 100%;
		margin-top: 1rem;
	}

	.totp-signup-panel {
		display: grid;
		gap: 12px;
		margin-top: 12px;
		padding: 14px;
		border: 1px solid var(--border-color, var(--border));
		border-radius: 8px;
		background: color-mix(in srgb, var(--surface-color, var(--bg-glass)) 90%, transparent);
	}

	.totp-signup-panel h3 {
		margin: 0;
		font-size: 0.9375rem;
	}

	.totp-signup-qr {
		width: 192px;
		max-width: 100%;
		height: auto;
		border: 1px solid var(--border-color, var(--border));
		border-radius: 8px;
		background: #ffffff;
		padding: 8px;
	}

	.totp-manual-key {
		display: grid;
		gap: 4px;
	}

	.totp-manual-key span {
		font-size: 0.8125rem;
		color: var(--text-muted);
	}

	.totp-manual-key code,
	.totp-backup-codes code {
		font-size: 0.8125rem;
		overflow-wrap: anywhere;
	}

	.totp-signup-actions {
		display: grid;
		gap: 8px;
	}

	.totp-backup-codes {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
		gap: 8px;
		padding: 0;
		margin: 0;
		list-style: none;
	}

	.totp-backup-codes li {
		padding: 8px 10px;
		border: 1px solid var(--border-color, var(--border));
		border-radius: 8px;
		background: var(--surface-color, var(--surface));
	}
</style>
