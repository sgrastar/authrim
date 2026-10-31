<script lang="ts">
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { startAuthentication, WebAuthnAbortService } from '@simplewebauthn/browser';
	import { adminAuthAPI, authErrorKey } from '$lib/api/admin-auth';
	import {
		resolveAdminAgentLoginHandoffId,
		resolveAdminLoginReturnTo
	} from '$lib/auth/admin-login-return';
	import { AdminLoginTimeoutError, withAdminLoginTimeout } from '$lib/auth/admin-login-timeout';
	import { t, type MessageKey } from '$lib/i18n/i18n.svelte';
	import DisplayMenu from '$lib/shell/DisplayMenu.svelte';
	import LanguageSwitch from '$lib/shell/LanguageSwitch.svelte';
	import Button from '$lib/ui/primitives/Button.svelte';
	import Callout from '$lib/ui/patterns/Callout.svelte';
	import AuthLayout from '$lib/ui/templates/AuthLayout.svelte';

	const ADMIN_API_TIMEOUT_MS = 30_000;
	const PASSKEY_CEREMONY_TIMEOUT_MS = 120_000;

	let errorKey = $state<MessageKey | null>(null);
	let loading = $state(false);

	async function resumeAfterLogin(): Promise<void> {
		const handoffId = resolveAdminAgentLoginHandoffId(window.location.search);
		if (handoffId) {
			const consumeUrl = await adminAuthAPI.approveAgentLoginHandoff(handoffId);
			// Do not keep the one-time code URL behind the login page in browser history.
			window.location.replace(consumeUrl);
			return;
		}
		const destination = resolveAdminLoginReturnTo(window.location.search, window.location.origin);
		const resolved = new URL(destination, window.location.origin);
		await goto(`${resolved.pathname}${resolved.search}${resolved.hash}`);
	}

	// An Admin Agent handoff can resume without a new ceremony when a session already exists.
	onMount(async () => {
		if (!resolveAdminAgentLoginHandoffId(window.location.search)) return;
		loading = true;
		try {
			const session = await adminAuthAPI.checkSession();
			if (session) await resumeAfterLogin();
		} catch (error) {
			errorKey = authErrorKey(error);
		} finally {
			loading = false;
		}
	});

	async function signIn() {
		errorKey = null;
		loading = true;
		try {
			const { options, challengeId } = await withAdminLoginTimeout(
				adminAuthAPI.getLoginOptions(),
				ADMIN_API_TIMEOUT_MS
			);
			const credential = await withAdminLoginTimeout(
				startAuthentication({ optionsJSON: options }),
				PASSKEY_CEREMONY_TIMEOUT_MS,
				() => WebAuthnAbortService.cancelCeremony()
			);
			await withAdminLoginTimeout(
				adminAuthAPI.verifyLogin(challengeId, credential),
				ADMIN_API_TIMEOUT_MS
			);
			await resumeAfterLogin();
		} catch (error) {
			errorKey =
				error instanceof AdminLoginTimeoutError ? 'login.error.timeout' : authErrorKey(error);
		} finally {
			loading = false;
		}
	}
</script>

<svelte:head><title>{t('login.title')} — {t('app.brand')}</title></svelte:head>

<AuthLayout title={t('login.title')} subtitle={t('login.subtitle')} busy={loading}>
	{#if errorKey}
		<Callout tone="danger" live>{t(errorKey)}</Callout>
	{/if}
	<Button variant="primary" icon="fingerprint" block {loading} onclick={signIn}>
		{loading ? t('login.authenticating') : t('login.passkey')}
	</Button>
	<Callout>{t('login.hint')}</Callout>
	{#snippet footer()}
		<LanguageSwitch />
		<DisplayMenu />
	{/snippet}
</AuthLayout>
