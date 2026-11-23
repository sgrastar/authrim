<script lang="ts">
	import { adminAuthAPI, authErrorKey } from '#lib/api/admin-auth.js';
	import { WALLET_LOGIN_RETURN_KEY } from '#lib/auth/wallet-login-return.js';
	import { t, type MessageKey } from '#lib/i18n/i18n.svelte.js';
	import Button from '#lib/ui/primitives/Button.svelte';
	import Callout from '#lib/ui/patterns/Callout.svelte';

	/**
	 * Sign-in with a wallet, on this device only: the console hands the browser to the wallet app,
	 * which brings it back to `/admin/login/wallet` after the presentation. There is no QR option,
	 * because nothing would tie the person answering a QR to this browser.
	 */
	interface Props {
		disabled?: boolean;
	}

	let { disabled = false }: Props = $props();

	let errorKey = $state<MessageKey | null>(null);
	let busy = $state(false);

	async function start(): Promise<void> {
		errorKey = null;
		busy = true;
		try {
			const started = await adminAuthAPI.startWalletLogin();
			if (!started.deepLink) throw new Error('wallet_login_failed');
			// The callback page picks the sign-in up again (return_to, agent handoff).
			sessionStorage.setItem(WALLET_LOGIN_RETURN_KEY, window.location.search);
			window.location.assign(started.deepLink);
		} catch (error) {
			errorKey = authErrorKey(error);
			busy = false;
		}
	}
</script>

<div class="wallet">
	{#if errorKey}
		<Callout tone="danger" live>{t(errorKey)}</Callout>
	{/if}
	<div class="wallet__divider"><span>{t('login.wallet.divider')}</span></div>
	<Button
		variant="secondary"
		icon="deviceMobile"
		block
		loading={busy}
		disabled={disabled || busy}
		onclick={start}
	>
		{t('login.wallet.sameDevice')}
	</Button>
</div>

<style>
	.wallet {
		display: flex;
		flex-direction: column;
		gap: var(--space-3, 0.75rem);
	}

	.wallet__divider {
		display: flex;
		align-items: center;
		gap: var(--space-3, 0.75rem);
		color: var(--text-muted, #6b7280);
		font-size: 0.8125rem;
	}

	.wallet__divider::before,
	.wallet__divider::after {
		content: '';
		flex: 1;
		height: 1px;
		background: var(--border, #d1d5db);
	}
</style>
