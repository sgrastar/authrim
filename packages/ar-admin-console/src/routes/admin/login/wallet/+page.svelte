<script lang="ts">
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { adminAuthAPI, authErrorKey } from '#lib/api/admin-auth.js';
	import {
		resolveAdminAgentLoginHandoffId,
		resolveAdminLoginReturnTo
	} from '#lib/auth/admin-login-return.js';
	import { WALLET_LOGIN_RETURN_KEY } from '#lib/auth/wallet-login-return.js';
	import { t, type MessageKey } from '#lib/i18n/i18n.svelte.js';
	import Button from '#lib/ui/primitives/Button.svelte';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import AuthLayout from '#lib/ui/templates/AuthLayout.svelte';

	/**
	 * Landing page of the same-device wallet login: the wallet returns the browser here with the
	 * request id and a one-time response code. The binding cookie set when the login started proves
	 * this is the browser that started it.
	 */
	let errorKey = $state<MessageKey | null>(null);

	onMount(async () => {
		const params = new URLSearchParams(window.location.search);
		const requestId = params.get('request_id');
		const responseCode = params.get('response_code');
		// Do not keep the one-time code in the address bar or history.
		window.history.replaceState(null, '', window.location.pathname);
		if (!requestId || !responseCode) {
			errorKey = 'login.error.walletFailed';
			return;
		}
		try {
			await adminAuthAPI.completeWalletLogin(requestId, responseCode);
			// Pick the login up where it started: the validated return_to or the agent handoff.
			const startedSearch = sessionStorage.getItem(WALLET_LOGIN_RETURN_KEY) ?? '';
			sessionStorage.removeItem(WALLET_LOGIN_RETURN_KEY);
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
		} catch (error) {
			errorKey = authErrorKey(error);
		}
	});
</script>

<svelte:head>
	<meta name="referrer" content="no-referrer" />
	<title>{t('login.title')} — {t('app.brand')}</title>
</svelte:head>

<AuthLayout title={t('login.title')} busy={errorKey === null}>
	{#if errorKey}
		<Callout tone="danger" live>{t(errorKey)}</Callout>
		<Button variant="secondary" block href="/admin/login">{t('login.wallet.back')}</Button>
	{:else}
		<Callout live>{t('login.wallet.completing')}</Callout>
	{/if}
</AuthLayout>
