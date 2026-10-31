<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import { startRegistration } from '@simplewebauthn/browser';
	import {
		adminSetupAPI,
		SetupError,
		setupErrorKey,
		type SetupUserInfo
	} from '$lib/api/admin-setup';
	import { t, type MessageKey } from '$lib/i18n/i18n.svelte';
	import DisplayMenu from '$lib/shell/DisplayMenu.svelte';
	import LanguageSwitch from '$lib/shell/LanguageSwitch.svelte';
	import Button from '$lib/ui/primitives/Button.svelte';
	import Callout from '$lib/ui/patterns/Callout.svelte';
	import SettingRow from '$lib/ui/patterns/SettingRow.svelte';
	import AuthLayout from '$lib/ui/templates/AuthLayout.svelte';

	/**
	 * First administrator: the initial setup on the router issues a one-time token and links
	 * here (`/setup/complete?token=`). The passkey is registered for this host (RP ID).
	 */
	let status = $state<'verifying' | 'ready' | 'registering' | 'done' | 'failed'>('verifying');
	let errorKey = $state<MessageKey | null>(null);
	let user = $state<SetupUserInfo | null>(null);
	let token = '';

	onMount(async () => {
		token = page.url.searchParams.get('token') ?? '';
		if (!token) {
			status = 'failed';
			errorKey = 'setup.error.noToken';
			return;
		}
		try {
			const result = await adminSetupAPI.verifyToken(token);
			if (result.valid && result.user) {
				user = result.user;
				status = 'ready';
			} else {
				status = 'failed';
				errorKey = 'setup.error.invalid';
			}
		} catch (error) {
			status = 'failed';
			errorKey = setupErrorKey(error);
		}
	});

	async function register() {
		if (!token || !user) return;
		status = 'registering';
		errorKey = null;
		try {
			const { options, challenge_id } = await adminSetupAPI.getPasskeyOptions(
				token,
				window.location.hostname
			);
			const credential = await startRegistration({ optionsJSON: options });
			const result = await adminSetupAPI.completePasskeyRegistration(
				token,
				challenge_id,
				credential,
				window.location.origin
			);
			if (!result.success)
				throw new SetupError('registration_failed', 'Passkey registration failed.');
			status = 'done';
			setTimeout(() => goto('/admin/login'), 3000);
		} catch (error) {
			status = 'ready';
			errorKey = setupErrorKey(error);
		}
	}
</script>

<svelte:head><title>{t('setup.title')} — {t('app.brand')}</title></svelte:head>

<AuthLayout
	title={status === 'done' ? t('setup.done.title') : t('setup.title')}
	subtitle={status === 'done' ? t('setup.done.body') : t('setup.subtitle')}
	busy={status === 'registering'}
>
	{#if errorKey}
		<Callout tone="danger" live>{t(errorKey)}</Callout>
	{/if}
	{#if status === 'verifying'}
		<p role="status">{t('setup.verifying')}</p>
	{:else if status === 'done'}
		<Button variant="primary" block href="/admin/login">{t('setup.goLogin')}</Button>
	{:else if user}
		<SettingRow bare icon="users" title={user.name || user.email} description={user.email} />
		<Button
			variant="primary"
			icon="fingerprint"
			block
			loading={status === 'registering'}
			onclick={register}
		>
			{status === 'registering' ? t('setup.registering') : t('setup.register')}
		</Button>
	{/if}
	{#snippet footer()}
		<LanguageSwitch />
		<DisplayMenu />
	{/snippet}
</AuthLayout>
