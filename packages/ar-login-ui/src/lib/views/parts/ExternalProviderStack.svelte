<script lang="ts">
	/**
	 * "Or continue with" and one button per external identity provider, each with the
	 * human-verification widget it may be waiting on. Shared by the login and signup views.
	 */
	import { Button } from '$lib/components';
	import { LL } from '$i18n/i18n-svelte';
	import { isValidImageUrl } from '$lib/utils/url-validation';
	import type { ExternalProviderButton, HumanVerificationView } from '../auth-entry-types';
	import HumanVerification from './HumanVerification.svelte';

	type Props = {
		providers: ExternalProviderButton[];
		/** The provider whose sign-in is starting. */
		loadingId?: string | null;
		disabled?: boolean;
		showTurnstileFor?: (target: string) => boolean;
		verification: HumanVerificationView;
		token?: string;
		onSelect?: (providerId: string) => void;
	};

	let {
		providers,
		loadingId = null,
		disabled = false,
		showTurnstileFor = () => false,
		verification,
		token = $bindable(''),
		onSelect
	}: Props = $props();
</script>

<div class="auth-divider" style="margin: 24px 0;">
	<div class="auth-divider__line"></div>
	<span class="auth-divider__text">{$LL.login_orContinueWith()}</span>
	<div class="auth-divider__line"></div>
</div>

<div class="auth-provider-stack space-y-3">
	{#each providers as provider (provider.id)}
		<Button
			variant="secondary"
			class="w-full justify-center"
			loading={loadingId === provider.id}
			{disabled}
			onclick={() => onSelect?.(provider.id)}
			style={provider.style}
		>
			{#if provider.iconUrl && isValidImageUrl(provider.iconUrl)}
				<img
					src={provider.iconUrl}
					alt=""
					loading="lazy"
					style="width: 20px; height: 20px; object-fit: contain; flex: 0 0 20px;"
				/>
			{:else if provider.iconClass}
				<div class="{provider.iconClass} h-5 w-5"></div>
			{/if}
			{provider.text}
		</Button>
		<HumanVerification
			show={showTurnstileFor(`external:${provider.id}`)}
			{verification}
			bind:token
			{disabled}
		/>
	{/each}
</div>
