<script module lang="ts">
	/** The application a sign-in comes from (OIDC login challenge). */
	export interface LoginClientInfo {
		client_id: string;
		client_name: string;
		logo_uri?: string;
		client_uri?: string;
		policy_uri?: string;
		tos_uri?: string;
	}

	/** Why an external identity provider sent the person back, and what they can do about it. */
	export type LoginExternalIdpError = { title: string; message: string; action?: string };

	export type LoginAlerts = {
		externalIdp?: LoginExternalIdpError | null;
		error?: string;
		runtimeFlow?: string;
		/** The runtime step needs a screen the tenant has not configured. */
		runtimeScreenMissing?: boolean;
		passkeyProgress?: string;
		emailCodeProgress?: string;
	};

	/** The methods the classic layout offers (enabled by the tenant and allowed by the step). */
	export type LoginMethods = {
		passkey?: boolean;
		directoryPassword?: boolean;
		emailCode?: boolean;
		totp?: boolean;
		external?: boolean;
		/** At least one method is shown. */
		any?: boolean;
	};

	/** The requests in progress, one flag per method. */
	export type LoginLoading = {
		passkey?: boolean;
		emailCode?: boolean;
		totp?: boolean;
		directoryPassword?: boolean;
		/** The external provider whose sign-in is starting. */
		externalIdp?: string | null;
		migrationPasskey?: boolean;
		migrationEmail?: boolean;
	};

	/** A directory account that has to move to a passkey (or recover through email) to sign in. */
	export type DirectoryMigrationView = {
		notice: string;
		/** A passkey can be registered for the migrated account. */
		passkey: boolean;
		/** The account can continue with a code sent to its email address. */
		emailFallback: boolean;
		/** The code has been sent; show the code entry. */
		codeSent: boolean;
	};
</script>

<script lang="ts">
	/**
	 * The sign-in page, as the person sees it inside the page shell. The route (`src/routes/login`)
	 * owns the state, the requests, WebAuthn and the redirects; this view only draws what it is
	 * given and reports what the person does.
	 */
	import { Button, Input, Card, Alert } from '$lib/components';
	import AuthSwitchLink from '$lib/components/AuthSwitchLink.svelte';
	import RuntimeScreen from '$lib/components/RuntimeScreen.svelte';
	import { LL } from '$i18n/i18n-svelte';
	import type { RuntimeAuthMethod } from '$lib/authrim/runtime-auth-handles';
	import { isValidImageUrl, isValidLinkUrl } from '$lib/utils/url-validation';
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
		methodsError?: string;
		client?: { loading: boolean; info: LoginClientInfo | null };
		title: string;
		/** Show the title block (off while a runtime screen or a blocked flow takes the card). */
		legacyHeading?: boolean;
		/** Show the classic method buttons (off while a runtime screen draws the methods). */
		legacyMethods?: boolean;
		alerts?: LoginAlerts;
		/** The runtime step to draw, or null when the step draws nothing of its own. */
		runtimeStep?: RuntimeStepView | null;
		runtime?: RuntimeScreenState;
		guest?: { enabled: boolean; retentionDescription: string };
		methods?: LoginMethods;
		loading?: LoginLoading;
		/** Any action is in progress. */
		busy?: boolean;
		/** Actions are unavailable (in progress, or the authorization request cannot continue). */
		disabled?: boolean;
		directoryPasswordLabel?: string;
		externalProviders?: ExternalProviderButton[];
		totpCodeRequested?: boolean;
		migration?: DirectoryMigrationView | null;
		emailVerification?: EmailVerificationView;
		humanVerification: HumanVerificationView;
		/** Whether the human-verification widget shows under the given method. */
		showTurnstileFor?: (target: string) => boolean;
		/** The "Create account" link, or null when the tenant hides it. */
		signupHref?: string | null;
		email?: string;
		directoryUsername?: string;
		directoryPassword?: string;
		totpIdentifier?: string;
		totpCode?: string;
		migrationEmailCode?: string;
		turnstileToken?: string;
		consentDecisions?: Record<string, boolean>;
		onSubmit?: (event: SubmitEvent) => void;
		onDismissExternalIdpError?: () => void;
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
		onGuestLogin?: () => void;
		onPasskey?: () => void;
		onEmailCode?: () => void;
		onEmailKeyPress?: (event: KeyboardEvent) => void;
		onDirectoryPassword?: () => void;
		onDirectoryKeyPress?: (event: KeyboardEvent) => void;
		onTotpStart?: () => void;
		onTotpVerify?: () => void;
		onTotpKeyPress?: (event: KeyboardEvent) => void;
		/** Leave the authenticator-code entry for the identifier again. */
		onTotpBack?: () => void;
		onExternalProvider?: (providerId: string) => void;
		onMigrationPasskey?: () => void;
		onMigrationEmailSend?: () => void;
		onMigrationEmailVerify?: () => void;
	};

	let {
		initialLoading = false,
		methodsError = '',
		client = { loading: false, info: null },
		title,
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
		guest = { enabled: false, retentionDescription: '' },
		methods = {},
		loading = {},
		busy = false,
		disabled = false,
		directoryPasswordLabel = '',
		externalProviders = [],
		totpCodeRequested = false,
		migration = null,
		emailVerification = { enabled: false, nonce: null },
		humanVerification,
		showTurnstileFor = () => false,
		signupHref = null,
		email = $bindable(''),
		directoryUsername = $bindable(''),
		directoryPassword = $bindable(''),
		totpIdentifier = $bindable(''),
		totpCode = $bindable(''),
		migrationEmailCode = $bindable(''),
		turnstileToken = $bindable(''),
		consentDecisions = $bindable({}),
		onSubmit,
		onDismissExternalIdpError,
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
		onGuestLogin,
		onPasskey,
		onEmailCode,
		onEmailKeyPress,
		onDirectoryPassword,
		onDirectoryKeyPress,
		onTotpStart,
		onTotpVerify,
		onTotpKeyPress,
		onTotpBack,
		onExternalProvider,
		onMigrationPasskey,
		onMigrationEmailSend,
		onMigrationEmailVerify
	}: Props = $props();

	const emailVerificationTokenAutocomplete = 'email-verification-token' as never;
	const externalIdpBusy = $derived(loading.externalIdp != null);
</script>

<!-- Client Info Section (OIDC Dynamic OP) -->
{#if client.loading}
	<div class="auth-client-card animate-pulse">
		<div class="auth-client-card__row">
			<div class="flex-shrink-0 h-12 w-12 rounded-lg" style="background: var(--bg-subtle);"></div>
			<div class="flex-1">
				<div class="h-3 rounded w-20 mb-2" style="background: var(--bg-subtle);"></div>
				<div class="h-4 rounded w-32" style="background: var(--bg-subtle);"></div>
			</div>
		</div>
	</div>
{:else if client.info}
	{@const clientInfo = client.info}
	<div class="auth-client-card">
		<div class="auth-client-card__row">
			{#if clientInfo.logo_uri && isValidImageUrl(clientInfo.logo_uri)}
				<img
					src={clientInfo.logo_uri}
					alt="{clientInfo.client_name} logo"
					class="auth-client-card__logo"
					onerror={(e) => ((e.currentTarget as HTMLImageElement).style.display = 'none')}
				/>
			{/if}
			<div class="flex-1 min-w-0">
				<p class="auth-client-card__label">{$LL.login_signingInTo()}</p>
				{#if clientInfo.client_uri && isValidLinkUrl(clientInfo.client_uri)}
					<p class="auth-client-card__name">
						<a
							href={clientInfo.client_uri}
							target="_blank"
							rel="noopener noreferrer"
							class="truncate block"
						>
							{clientInfo.client_name}
						</a>
					</p>
				{:else}
					<p class="auth-client-card__name truncate">
						{clientInfo.client_name}
					</p>
				{/if}
				{#if clientInfo.policy_uri || clientInfo.tos_uri}
					<div class="auth-client-card__links">
						{#if clientInfo.policy_uri && isValidLinkUrl(clientInfo.policy_uri)}
							<a
								href={clientInfo.policy_uri}
								target="_blank"
								rel="noopener noreferrer"
								class="auth-client-card__link"
							>
								{$LL.consent_privacyPolicy()}
							</a>
						{/if}
						{#if clientInfo.tos_uri && isValidLinkUrl(clientInfo.tos_uri)}
							<a
								href={clientInfo.tos_uri}
								target="_blank"
								rel="noopener noreferrer"
								class="auth-client-card__link"
							>
								{$LL.consent_termsOfService()}
							</a>
						{/if}
					</div>
				{/if}
			</div>
		</div>
	</div>
{/if}

<!-- Loading State -->
{#if initialLoading}
	<div class="auth-initial-loading" role="status">
		<span class="auth-initial-loading__spinner" aria-hidden="true"></span>
		<span class="sr-only">{$LL.common_loading()}</span>
	</div>
{:else if methodsError}
	<!-- Methods Error -->
	<Card class="mb-6">
		<Alert variant="error" class="mb-0">
			{methodsError}
		</Alert>
	</Card>
{:else}
	<!-- Login Card -->
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
					<p class="auth-section-subtitle">
						{$LL.login_subtitle()}
					</p>
				</div>
			{/if}

			<!-- External IdP Error Alert -->
			{#if alerts.externalIdp}
				<Alert
					variant="warning"
					dismissible={true}
					onDismiss={onDismissExternalIdpError}
					class="mb-4"
				>
					<div class="space-y-1">
						<p class="font-semibold">{alerts.externalIdp.title}</p>
						<p class="text-sm">{alerts.externalIdp.message}</p>
						{#if alerts.externalIdp.action}
							<p class="text-sm mt-2" style="color: var(--text-secondary);">
								{alerts.externalIdp.action}
							</p>
						{/if}
					</div>
				</Alert>
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
							guestEnabled={guest.enabled}
							guestRetentionDescription={guest.retentionDescription}
							{onGuestLogin}
							headingOverride={title}
							{disabled}
							authMethodMode="login"
							fieldValues={runtime.fieldValues}
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
						choiceItems
						bind:decisions={consentDecisions}
						destinationFieldDecisions={runtime.destinationFieldDecisions}
						selectedValues={runtime.consentSelectedValues}
						consentReady={runtime.consentReady}
						loading={runtime.loading}
						{busy}
						{disabled}
						{onDestinationFieldDecisionChange}
						onSelectedValueChange={onConsentSelectedValueChange}
						onAccept={onRuntimeAccept}
						onComplete={onRuntimeComplete}
					/>
				{/if}
			{/if}

			{#if migration}
				<Alert variant="info" class="mb-4">
					<div class="space-y-3">
						<p>{migration.notice}</p>
						{#if migration.passkey}
							<Button
								variant="primary"
								class="w-full"
								loading={loading.migrationPasskey}
								disabled={loading.passkey ||
									loading.emailCode ||
									loading.directoryPassword ||
									loading.migrationEmail ||
									externalIdpBusy}
								onclick={onMigrationPasskey}
							>
								<div class="i-ph-key h-5 w-5"></div>
								{$LL.register_createWithPasskey()}
							</Button>
						{/if}
						{#if migration.emailFallback}
							<div class="space-y-2">
								<Button
									variant="secondary"
									class="w-full"
									loading={loading.migrationEmail && !migration.codeSent}
									disabled={loading.passkey ||
										loading.emailCode ||
										loading.directoryPassword ||
										loading.migrationPasskey ||
										externalIdpBusy}
									onclick={onMigrationEmailSend}
								>
									<div class="i-ph-envelope-simple h-5 w-5"></div>
									{$LL.login_sendCode()}
								</Button>
								{#if migration.codeSent}
									<div class="space-y-2">
										<input
											type="text"
											inputmode="numeric"
											autocomplete="one-time-code"
											maxlength={6}
											placeholder={$LL.account_reauthEmailCodePlaceholder()}
											bind:value={migrationEmailCode}
											class="input w-full"
										/>
										<Button
											variant="primary"
											class="w-full"
											loading={loading.migrationEmail}
											disabled={migrationEmailCode.trim().length !== 6 ||
												loading.passkey ||
												loading.emailCode ||
												loading.directoryPassword ||
												loading.migrationPasskey ||
												externalIdpBusy}
											onclick={onMigrationEmailVerify}
										>
											<div class="i-ph-check h-5 w-5"></div>
											{$LL.emailCode_verifyButton()}
										</Button>
									</div>
								{/if}
							</div>
						{/if}
					</div>
				</Alert>
			{/if}

			{#if legacyMethods && !methods.any}
				<Alert variant="error" class="mb-4">
					{$LL.login_noMethodsAvailable()}
				</Alert>
			{/if}

			<!-- Passkey Button -->
			{#if legacyMethods && methods.passkey}
				<Button
					variant="primary"
					class="w-full mb-4"
					loading={loading.passkey}
					{disabled}
					onclick={onPasskey}
				>
					<div class="i-ph-key h-5 w-5"></div>
					{$LL.login_signInWithPasskey()}
				</Button>
				<HumanVerification
					show={showTurnstileFor('passkey')}
					verification={humanVerification}
					bind:token={turnstileToken}
					{disabled}
				/>

				{#if methods.directoryPassword || methods.emailCode}
					<div class="auth-divider">
						<div class="auth-divider__line"></div>
						<span class="auth-divider__text">{$LL.common_or()}</span>
						<div class="auth-divider__line"></div>
					</div>
				{/if}
			{/if}

			<!-- Directory Password -->
			{#if legacyMethods && methods.directoryPassword}
				<div class="mb-4">
					<Input
						label={directoryPasswordLabel}
						type="text"
						placeholder={$LL.login_directoryUsernamePlaceholder()}
						bind:value={directoryUsername}
						onkeypress={onDirectoryKeyPress}
						autocomplete="username"
						{disabled}
						required
					/>
				</div>

				<div class="mb-4">
					<Input
						label={$LL.login_directoryPasswordLabel()}
						type="password"
						placeholder={$LL.login_directoryPasswordPlaceholder()}
						bind:value={directoryPassword}
						onkeypress={onDirectoryKeyPress}
						autocomplete="current-password"
						{disabled}
						required
					/>
				</div>

				<Button
					variant="secondary"
					class="w-full"
					loading={loading.directoryPassword}
					{disabled}
					onclick={onDirectoryPassword}
				>
					<div class="i-ph-identification-card h-5 w-5"></div>
					{$LL.login_signInWithDirectory({ label: directoryPasswordLabel })}
				</Button>
				<HumanVerification
					show={showTurnstileFor('directory-password')}
					verification={humanVerification}
					bind:token={turnstileToken}
					{disabled}
				/>

				{#if methods.emailCode}
					<div class="auth-divider">
						<div class="auth-divider__line"></div>
						<span class="auth-divider__text">{$LL.common_or()}</span>
						<div class="auth-divider__line"></div>
					</div>
				{/if}
			{/if}

			<!-- Email Input + Email Code -->
			{#if legacyMethods && methods.emailCode}
				<div class="mb-4">
					<Input
						label={$LL.common_email()}
						type="email"
						name="email"
						placeholder={$LL.common_emailPlaceholder()}
						bind:value={email}
						onkeypress={onEmailKeyPress}
						autocomplete="email"
						{disabled}
						required
					/>
				</div>

				<Button
					variant="secondary"
					class="w-full"
					type={emailVerification.enabled ? 'submit' : 'button'}
					loading={loading.emailCode}
					{disabled}
					onclick={emailVerification.enabled ? undefined : () => onEmailCode?.()}
				>
					<div class="i-ph-envelope-simple h-5 w-5"></div>
					{$LL.login_sendCode()}
				</Button>
				<HumanVerification
					show={showTurnstileFor('email-code')}
					verification={humanVerification}
					bind:token={turnstileToken}
					{disabled}
				/>
			{/if}

			<!-- TOTP -->
			{#if legacyMethods && methods.totp}
				{#if methods.emailCode}
					<div class="auth-divider">
						<div class="auth-divider__line"></div>
						<span class="auth-divider__text">{$LL.common_or()}</span>
						<div class="auth-divider__line"></div>
					</div>
				{/if}

				{#if !totpCodeRequested && !methods.emailCode}
					<div class="mb-4">
						<Input
							label={$LL.login_totpIdentifierLabel()}
							type="text"
							placeholder={$LL.login_totpIdentifierPlaceholder()}
							bind:value={totpIdentifier}
							onkeypress={onTotpKeyPress}
							autocomplete="username"
							{disabled}
							required
						/>
					</div>
				{:else}
					<div class="mb-4">
						<Input
							label={$LL.login_totpCodeLabel()}
							type="text"
							placeholder={$LL.login_totpCodePlaceholder()}
							bind:value={totpCode}
							onkeypress={onTotpKeyPress}
							autocomplete="one-time-code"
							inputmode="numeric"
							maxlength={8}
							{disabled}
							required
						/>
						<Button variant="ghost" size="sm" {disabled} onclick={() => onTotpBack?.()}>
							{$LL.common_backToLogin()}
						</Button>
					</div>
				{/if}

				<Button
					variant="secondary"
					class="w-full"
					loading={loading.totp}
					{disabled}
					onclick={totpCodeRequested ? onTotpVerify : onTotpStart}
				>
					<div class="i-ph-key h-5 w-5"></div>
					{totpCodeRequested ? $LL.login_totpVerify() : $LL.login_totpContinue()}
				</Button>
			{/if}

			<!-- External Login Section -->
			{#if legacyMethods && methods.external}
				<ExternalProviderStack
					providers={externalProviders}
					loadingId={loading.externalIdp}
					{disabled}
					{showTurnstileFor}
					verification={humanVerification}
					bind:token={turnstileToken}
					onSelect={onExternalProvider}
				/>
			{/if}
		</Card>
	</form>
{/if}

<!-- Create Account Link -->
{#if signupHref}
	<p class="auth-bottom-link">
		<AuthSwitchLink
			href={signupHref}
			label={$LL.login_createAccount()}
			loadingLabel={$LL.common_loading()}
		/>
	</p>
{/if}
