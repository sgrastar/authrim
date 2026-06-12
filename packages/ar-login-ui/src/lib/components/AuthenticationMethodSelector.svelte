<script lang="ts">
	import { Button, Input, Alert } from '$lib/components';
	import { LL } from '$i18n/i18n-svelte';
	import type { ExternalProvider } from '$lib/api/authentication-methods';
	import { getExternalProviderIconClass } from '$lib/login-provider-icons';
	import { isValidImageUrl, sanitizeColor } from '$lib/utils/url-validation';

	interface Props {
		passkeyEnabled: boolean;
		emailCodeEnabled: boolean;
		directoryPasswordEnabled?: boolean;
		directoryPasswordLabel?: string;
		externalEnabled: boolean;
		externalProviders: ExternalProvider[];
		passkeyLoading?: boolean;
		emailCodeLoading?: boolean;
		directoryPasswordLoading?: boolean;
		externalIdpLoading?: string | null;
		error?: string;
		email?: string;
		directoryUsername?: string;
		directoryPassword?: string;
		onPasskeyLogin?: () => void;
		onEmailCodeSend?: (email: string) => void;
		onDirectoryPasswordLogin?: (username: string, password: string) => void;
		onExternalLogin?: (provider: ExternalProvider) => void;
		onErrorDismiss?: () => void;
	}

	let {
		passkeyEnabled,
		emailCodeEnabled,
		directoryPasswordEnabled = false,
		directoryPasswordLabel = 'Organization ID',
		externalEnabled,
		externalProviders,
		passkeyLoading = false,
		emailCodeLoading = false,
		directoryPasswordLoading = false,
		externalIdpLoading = null,
		error = '',
		email = $bindable(''),
		directoryUsername = $bindable(''),
		directoryPassword = $bindable(''),
		onPasskeyLogin,
		onEmailCodeSend,
		onDirectoryPasswordLogin,
		onExternalLogin,
		onErrorDismiss
	}: Props = $props();

	// WebAuthn support check
	const isPasskeySupported = $derived(
		typeof window !== 'undefined' &&
			window.PublicKeyCredential !== undefined &&
			typeof window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable === 'function'
	);

	const showPasskey = $derived(passkeyEnabled && isPasskeySupported);
	const visibleExternalProviders = $derived(
		externalProviders.filter((provider) => provider.loginEnabled ?? provider.enabled !== false)
	);

	function getProviderIcon(provider: ExternalProvider): string {
		return getExternalProviderIconClass(provider);
	}

	function getProviderButtonText(provider: ExternalProvider): string {
		if (provider.buttonText) return provider.buttonText;
		return $LL.login_continueWith({ provider: provider.name });
	}

	function handleKeyPress(event: KeyboardEvent) {
		if (event.key === 'Enter' && onEmailCodeSend) {
			onEmailCodeSend(email);
		}
	}

	function handleDirectoryKeyPress(event: KeyboardEvent) {
		if (event.key === 'Enter' && onDirectoryPasswordLogin) {
			onDirectoryPasswordLogin(directoryUsername, directoryPassword);
		}
	}
</script>

<!--
  AuthenticationMethodSelector
  - Renders available authentication methods based on server configuration
  - Delegates authentication actions to parent via callbacks
  - Handles passkey support detection and provider icon resolution
-->

<!-- Error Alert -->
{#if error}
	<Alert variant="error" dismissible={true} onDismiss={onErrorDismiss} class="mb-4">
		{error}
	</Alert>
{/if}

<!-- Passkey Button -->
{#if showPasskey}
	<Button
		variant="primary"
		class="w-full mb-4"
		loading={passkeyLoading}
		disabled={emailCodeLoading || directoryPasswordLoading || externalIdpLoading !== null}
		onclick={onPasskeyLogin}
	>
		<div class="i-heroicons-key h-5 w-5"></div>
		{$LL.login_signInWithPasskey()}
	</Button>

	{#if directoryPasswordEnabled || emailCodeEnabled}
		<div class="auth-divider">
			<div class="auth-divider__line"></div>
			<span class="auth-divider__text">{$LL.common_or()}</span>
			<div class="auth-divider__line"></div>
		</div>
	{/if}
{/if}

<!-- Directory Password -->
{#if directoryPasswordEnabled}
	<div class="mb-4">
		<Input
			label={directoryPasswordLabel}
			type="text"
			placeholder={$LL.login_directoryUsernamePlaceholder()}
			bind:value={directoryUsername}
			onkeypress={handleDirectoryKeyPress}
			autocomplete="username"
			disabled={passkeyLoading ||
				emailCodeLoading ||
				directoryPasswordLoading ||
				externalIdpLoading !== null}
			required
		/>
	</div>

	<div class="mb-4">
		<Input
			label={$LL.login_directoryPasswordLabel()}
			type="password"
			placeholder={$LL.login_directoryPasswordPlaceholder()}
			bind:value={directoryPassword}
			onkeypress={handleDirectoryKeyPress}
			autocomplete="current-password"
			disabled={passkeyLoading ||
				emailCodeLoading ||
				directoryPasswordLoading ||
				externalIdpLoading !== null}
			required
		/>
	</div>

	<Button
		variant="secondary"
		class="w-full"
		loading={directoryPasswordLoading}
		disabled={passkeyLoading || emailCodeLoading || externalIdpLoading !== null}
		onclick={() => onDirectoryPasswordLogin?.(directoryUsername, directoryPassword)}
	>
		<div class="i-heroicons-identification h-5 w-5"></div>
		{$LL.login_signInWithDirectory({ label: directoryPasswordLabel })}
	</Button>

	{#if emailCodeEnabled}
		<div class="auth-divider">
			<div class="auth-divider__line"></div>
			<span class="auth-divider__text">{$LL.common_or()}</span>
			<div class="auth-divider__line"></div>
		</div>
	{/if}
{/if}

<!-- Email Input + Email Code -->
{#if emailCodeEnabled}
	<div class="mb-4">
		<Input
			label={$LL.common_email()}
			type="email"
			placeholder={$LL.common_emailPlaceholder()}
			bind:value={email}
			onkeypress={handleKeyPress}
			autocomplete="email"
			disabled={passkeyLoading ||
				emailCodeLoading ||
				directoryPasswordLoading ||
				externalIdpLoading !== null}
			required
		>
			{#snippet icon()}
				<div class="i-heroicons-envelope h-5 w-5" style="color: var(--text-muted);"></div>
			{/snippet}
		</Input>
	</div>

	<Button
		variant="secondary"
		class="w-full"
		loading={emailCodeLoading}
		disabled={passkeyLoading || directoryPasswordLoading || externalIdpLoading !== null}
		onclick={() => onEmailCodeSend?.(email)}
	>
		<div class="i-heroicons-envelope h-5 w-5"></div>
		{$LL.login_sendCode()}
	</Button>
{/if}

<!-- External Login Section -->
{#if externalEnabled && visibleExternalProviders.length > 0}
	<div class="auth-divider" style="margin: 24px 0;">
		<div class="auth-divider__line"></div>
		<span class="auth-divider__text">{$LL.login_orContinueWith()}</span>
		<div class="auth-divider__line"></div>
	</div>

	<div class="space-y-3">
		{#each visibleExternalProviders as provider (provider.id)}
			{@const safeColor = sanitizeColor(provider.buttonColor)}
			<Button
				variant="secondary"
				class="w-full justify-center"
				loading={externalIdpLoading === provider.id}
				disabled={passkeyLoading ||
					emailCodeLoading ||
					directoryPasswordLoading ||
					(externalIdpLoading !== null && externalIdpLoading !== provider.id)}
				onclick={() => onExternalLogin?.(provider)}
				style={safeColor ? `border-color: ${safeColor}; color: ${safeColor};` : ''}
			>
				{#if provider.iconUrl && isValidImageUrl(provider.iconUrl)}
					<img
						src={provider.iconUrl}
						alt=""
						loading="lazy"
						style="width: 20px; height: 20px; object-fit: contain; flex: 0 0 20px;"
					/>
				{:else if getProviderIcon(provider)}
					<div class="{getProviderIcon(provider)} h-5 w-5"></div>
				{/if}
				{getProviderButtonText(provider)}
			</Button>
		{/each}
	</div>
{/if}
