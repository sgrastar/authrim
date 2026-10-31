<script lang="ts">
	/**
	 * The tenant's human-verification widget under one method. It shows only while that method is
	 * waiting on a token; the route decides when (`show`) and clears the token (`resetKey`).
	 */
	import { TurnstileWidget } from '$lib/components';
	import { LL } from '$i18n/i18n-svelte';
	import type { HumanVerificationView } from '../auth-entry-types';

	type Props = {
		show: boolean;
		verification: HumanVerificationView;
		token?: string;
		disabled?: boolean;
	};

	let { show, verification, token = $bindable(''), disabled = false }: Props = $props();
</script>

{#if show && verification.siteKey}
	<TurnstileWidget
		siteKey={verification.siteKey}
		provider={verification.provider}
		mode={verification.mode}
		action={verification.action}
		theme={verification.theme}
		language={verification.language}
		bind:token
		resetKey={verification.resetKey}
		{disabled}
		loadingLabel={$LL.login_humanVerificationLoading()}
		errorLabel={$LL.login_humanVerificationLoadFailed()}
	/>
{/if}
