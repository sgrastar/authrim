<script module lang="ts">
	export interface ChallengeData {
		client: {
			client_id: string;
			client_name: string;
			logo_uri?: string;
		};
		user: {
			id: string;
			email: string;
			name?: string;
		};
		max_age?: number;
		login_hint?: string;
	}
</script>

<script lang="ts">
	/**
	 * The re-authentication page, as the user sees it. The route owns the state and the requests;
	 * this component only draws what it is given and reports what the user does.
	 */
	import { Button, Card, Alert, Input, TurnstileWidget } from '$lib/components';
	import { LL } from '$i18n/i18n-svelte';
	import { isValidImageUrl } from '$lib/utils/url-validation';

	type HumanVerificationProvider = 'turnstile' | 'hcaptcha' | 'recaptcha' | 'custom';
	type HumanVerificationMode = 'managed' | 'checkbox' | 'invisible' | 'score';

	type Props = {
		loading?: boolean;
		error?: string;
		challengeData?: ChallengeData | null;
		showPasskey?: boolean;
		emailCodeEnabled?: boolean;
		totpEnabled?: boolean;
		passkeyLoading?: boolean;
		emailCodeLoading?: boolean;
		totpLoading?: boolean;
		authActionLoading?: boolean;
		totpCodeRequested?: boolean;
		totpCode?: string;
		/** Whether the human-verification widget shows under the given action. */
		showTurnstileFor?: (target: string) => boolean;
		turnstileSiteKey?: string | null;
		humanVerificationProvider?: HumanVerificationProvider;
		humanVerificationMode?: HumanVerificationMode;
		turnstileAction?: string;
		turnstileTheme?: 'light' | 'dark';
		turnstileLanguage?: string;
		turnstileToken?: string;
		onPasskey?: () => void;
		onEmailCode?: () => void;
		onTotpStart?: () => void;
		onTotpVerify?: () => void;
		onTotpKeyPress?: (event: KeyboardEvent) => void;
		onDismissError?: () => void;
	};

	let {
		loading = false,
		error = '',
		challengeData = null,
		showPasskey = false,
		emailCodeEnabled = false,
		totpEnabled = false,
		passkeyLoading = false,
		emailCodeLoading = false,
		totpLoading = false,
		authActionLoading = false,
		totpCodeRequested = false,
		totpCode = $bindable(''),
		showTurnstileFor = () => false,
		turnstileSiteKey = null,
		humanVerificationProvider = 'turnstile',
		humanVerificationMode = 'managed',
		turnstileAction = 'authrim-reauth',
		turnstileTheme = 'light',
		turnstileLanguage = 'en',
		turnstileToken = $bindable(''),
		onPasskey,
		onEmailCode,
		onTotpStart,
		onTotpVerify,
		onTotpKeyPress,
		onDismissError
	}: Props = $props();
</script>

{#if loading}
	<Card class="text-center py-8">
		<div
			class="h-8 w-8 border-3 rounded-full animate-spin mx-auto mb-3"
			style="border-color: var(--border); border-top-color: var(--primary);"
		></div>
		<p style="color: var(--text-muted); font-size: 0.875rem;">{$LL.common_loading()}</p>
	</Card>
{:else}
	<Card class="mb-6">
		<!-- Icon -->
		<div class="auth-icon-badge">
			<div class="auth-icon-badge__circle auth-icon-badge__circle--warning">
				<div class="i-ph-shield-warning h-9 w-9 auth-icon-badge__icon"></div>
			</div>
		</div>

		<h2 class="auth-section-title text-center">
			{$LL.reauth_title()}
		</h2>
		<p class="auth-section-subtitle text-center mb-6">
			{$LL.reauth_subtitle()}
		</p>

		<!-- Challenge Info -->
		{#if challengeData}
			<div class="auth-info-box mb-6">
				<div class="flex items-center gap-3">
					{#if challengeData.client.logo_uri && isValidImageUrl(challengeData.client.logo_uri)}
						<img
							src={challengeData.client.logo_uri}
							alt={challengeData.client.client_name}
							class="h-10 w-10 rounded-lg"
						/>
					{/if}
					<div>
						<p class="auth-info-box__value">
							{challengeData.client.client_name}
						</p>
						{#if challengeData.user}
							<p class="auth-info-box__label" style="margin: 0;">
								{challengeData.user.email}
							</p>
						{/if}
					</div>
				</div>
			</div>
		{/if}

		{#if error}
			<Alert variant="error" dismissible={true} onDismiss={onDismissError} class="mb-4">
				{error}
			</Alert>
		{/if}

		<!-- Passkey Button -->
		{#if showPasskey}
			<Button
				variant="primary"
				class="w-full mb-3"
				loading={passkeyLoading}
				disabled={emailCodeLoading}
				onclick={onPasskey}
			>
				<div class="i-ph-key h-5 w-5"></div>
				{$LL.reauth_verifyWithPasskey()}
			</Button>
			{#if showTurnstileFor('passkey') && turnstileSiteKey}
				<TurnstileWidget
					siteKey={turnstileSiteKey}
					provider={humanVerificationProvider}
					mode={humanVerificationMode}
					action={turnstileAction}
					theme={turnstileTheme}
					language={turnstileLanguage}
					bind:token={turnstileToken}
					disabled={authActionLoading}
					loadingLabel={$LL.login_humanVerificationLoading()}
					errorLabel={$LL.login_humanVerificationLoadFailed()}
				/>
			{/if}

			{#if emailCodeEnabled}
				<div class="auth-divider">
					<div class="auth-divider__line"></div>
					<span class="auth-divider__text">{$LL.common_or()}</span>
					<div class="auth-divider__line"></div>
				</div>
			{/if}
		{/if}

		<!-- Email Code Button -->
		{#if emailCodeEnabled}
			<Button
				variant="secondary"
				class="w-full"
				loading={emailCodeLoading}
				disabled={passkeyLoading}
				onclick={onEmailCode}
			>
				<div class="i-ph-envelope-simple h-5 w-5"></div>
				{$LL.reauth_verifyWithEmailCode()}
			</Button>
			{#if showTurnstileFor('email-code') && turnstileSiteKey}
				<TurnstileWidget
					siteKey={turnstileSiteKey}
					provider={humanVerificationProvider}
					mode={humanVerificationMode}
					action={turnstileAction}
					theme={turnstileTheme}
					language={turnstileLanguage}
					bind:token={turnstileToken}
					disabled={authActionLoading}
					loadingLabel={$LL.login_humanVerificationLoading()}
					errorLabel={$LL.login_humanVerificationLoadFailed()}
				/>
			{/if}
		{/if}

		<!-- Authenticator App (TOTP) -->
		{#if totpEnabled}
			{#if showPasskey || emailCodeEnabled}
				<div class="auth-divider">
					<div class="auth-divider__line"></div>
					<span class="auth-divider__text">{$LL.common_or()}</span>
					<div class="auth-divider__line"></div>
				</div>
			{/if}

			{#if totpCodeRequested}
				<Input
					label={$LL.login_totpCodeLabel()}
					type="text"
					placeholder={$LL.login_totpCodePlaceholder()}
					bind:value={totpCode}
					onkeypress={onTotpKeyPress}
					autocomplete="one-time-code"
					inputmode="numeric"
					maxlength={8}
					disabled={authActionLoading}
					required
				/>
			{/if}

			<Button
				variant="secondary"
				class="w-full"
				loading={totpLoading}
				disabled={passkeyLoading || emailCodeLoading}
				onclick={totpCodeRequested ? onTotpVerify : onTotpStart}
			>
				<div class="i-ph-device-mobile h-5 w-5"></div>
				{totpCodeRequested ? $LL.login_totpVerify() : $LL.reauth_verifyWithTotp()}
			</Button>
		{/if}
	</Card>
{/if}
