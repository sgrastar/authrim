<script lang="ts">
	import { Button, Input, Alert } from '$lib/components';
	import { LL } from '$i18n/i18n-svelte';
	import type { ExternalProvider } from '$lib/api/login-methods';
	import { sanitizeColor } from '$lib/utils/url-validation';

	interface Props {
		passkeyEnabled: boolean;
		emailCodeEnabled: boolean;
		externalEnabled: boolean;
		externalProviders: ExternalProvider[];
		passkeyLoading?: boolean;
		emailCodeLoading?: boolean;
		externalIdpLoading?: string | null;
		error?: string;
		email?: string;
		onPasskeyLogin?: () => void;
		onEmailCodeSend?: (email: string) => void;
		onExternalLogin?: (provider: ExternalProvider) => void;
		onErrorDismiss?: () => void;
	}

	let {
		passkeyEnabled,
		emailCodeEnabled,
		externalEnabled,
		externalProviders,
		passkeyLoading = false,
		emailCodeLoading = false,
		externalIdpLoading = null,
		error = '',
		email = $bindable(''),
		onPasskeyLogin,
		onEmailCodeSend,
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

	function getProviderIcon(provider: ExternalProvider): string {
		if (provider.iconUrl) return provider.iconUrl;
		if (provider.type === 'saml') return 'i-heroicons-building-office-2';
		if (provider.type === 'vc') return 'i-heroicons-identification';
		const name = (provider.name || '').toLowerCase();
		if (name.includes('google')) return 'i-logos-google-icon';
		if (name.includes('github')) return 'i-logos-github-icon';
		if (name.includes('microsoft') || name.includes('azure')) return 'i-logos-microsoft-icon';
		if (name.includes('apple')) return 'i-logos-apple';
		if (name.includes('facebook')) return 'i-logos-facebook';
		return 'i-heroicons-arrow-right-end-on-rectangle';
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
</script>

<!--
  LoginMethodSelector
  - Renders available login methods based on server configuration
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
		disabled={emailCodeLoading}
		onclick={onPasskeyLogin}
	>
		<div class="i-heroicons-key h-5 w-5"></div>
		{$LL.login_signInWithPasskey()}
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
		disabled={passkeyLoading || externalIdpLoading !== null}
		onclick={() => onEmailCodeSend?.(email)}
	>
		<div class="i-heroicons-envelope h-5 w-5"></div>
		{$LL.login_sendCode()}
	</Button>
{/if}

<!-- External Login Section -->
{#if externalEnabled && externalProviders.length > 0}
	<div class="auth-divider" style="margin: 24px 0;">
		<div class="auth-divider__line"></div>
		<span class="auth-divider__text">{$LL.login_orContinueWith()}</span>
		<div class="auth-divider__line"></div>
	</div>

	<div class="space-y-3">
		{#each externalProviders as provider (provider.id)}
			{@const safeColor = sanitizeColor(provider.buttonColor)}
			<Button
				variant="secondary"
				class="w-full justify-center"
				loading={externalIdpLoading === provider.id}
				disabled={passkeyLoading ||
					emailCodeLoading ||
					(externalIdpLoading !== null && externalIdpLoading !== provider.id)}
				onclick={() => onExternalLogin?.(provider)}
				style={safeColor ? `border-color: ${safeColor}; color: ${safeColor};` : ''}
			>
				{#if provider.iconUrl}
					<img
						src={provider.iconUrl}
						alt=""
						loading="lazy"
						style="width: 20px; height: 20px; object-fit: contain; flex: 0 0 20px;"
					/>
				{:else}
					<div class="{getProviderIcon(provider)} h-5 w-5"></div>
				{/if}
				{getProviderButtonText(provider)}
			</Button>
		{/each}
	</div>
{/if}
