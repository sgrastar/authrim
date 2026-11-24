<script lang="ts">
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { adminAuthAPI, AuthError } from '#lib/api/admin-auth.js';
	import {
		resolveAdminAgentLoginHandoffId,
		resolveAdminLoginReturnTo
	} from '#lib/admin/admin-login-return.js';
	import { adminAuth } from '#lib/stores/admin-auth.svelte.js';
	import { LL } from '$i18n/i18n-svelte';

	/**
	 * Landing page of the same-device wallet login: the wallet returns the browser here with the
	 * request id and a one-time response code. The binding cookie set when the login started proves
	 * this is the browser that started it.
	 */
	let error = $state('');

	function failureMessage(err: unknown): string {
		if (err instanceof AuthError && err.code === 'wallet_login_not_allowed') {
			return $LL.admin_login_wallet_not_allowed();
		}
		return $LL.admin_login_wallet_failed();
	}

	onMount(async () => {
		const params = new URLSearchParams(window.location.search);
		const requestId = params.get('request_id');
		const responseCode = params.get('response_code');
		// Do not keep the one-time code in the address bar or history.
		window.history.replaceState(null, '', window.location.pathname);
		if (!requestId || !responseCode) {
			error = $LL.admin_login_wallet_failed();
			return;
		}
		try {
			await adminAuthAPI.completeWalletLogin(requestId, responseCode);
			await adminAuth.checkAuth();
			// Pick the login up where it started: the validated return_to or the agent handoff.
			const startedSearch = sessionStorage.getItem('authrim_admin_wallet_login_return') ?? '';
			sessionStorage.removeItem('authrim_admin_wallet_login_return');
			const handoffId = resolveAdminAgentLoginHandoffId(startedSearch);
			if (handoffId) {
				window.location.replace(await adminAuthAPI.approveAgentLoginHandoff(handoffId));
				return;
			}
			const destination = new URL(
				resolveAdminLoginReturnTo(startedSearch, window.location.origin),
				window.location.origin
			);
			await goto(`${destination.pathname}${destination.search}${destination.hash}`);
		} catch (err) {
			error = failureMessage(err);
		}
	});
</script>

<svelte:head>
	<meta name="referrer" content="no-referrer" />
	<title>{$LL.admin_login_page_title()}</title>
</svelte:head>

<main class="wallet-callback">
	{#if error}
		<p role="alert">{error}</p>
		<a href="/admin/login">{$LL.admin_login_panel()}</a>
	{:else}
		<p aria-live="polite">{$LL.admin_login_wallet_completing()}</p>
	{/if}
</main>

<style>
	.wallet-callback {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 1rem;
		min-height: 100vh;
	}
</style>
