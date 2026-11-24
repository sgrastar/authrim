<script lang="ts">
	import { onDestroy } from 'svelte';
	import {
		adminAuthAPI,
		AuthError,
		type WalletLoginFlow,
		type WalletLoginStart
	} from '#lib/api/admin-auth.js';
	import { LL } from '$i18n/i18n-svelte';

	interface Props {
		/** Called once the Admin session exists. */
		onSignedIn: () => Promise<void>;
		disabled?: boolean;
	}

	let { onSignedIn, disabled = false }: Props = $props();

	const POLL_INTERVAL_MS = 2_000;

	let started = $state<WalletLoginStart | null>(null);
	let flow = $state<WalletLoginFlow | null>(null);
	let qrImage = $state('');
	let message = $state('');
	let busy = $state(false);
	let stage = $state<'idle' | 'waiting' | 'processing' | 'completing'>('idle');
	let timer: ReturnType<typeof setTimeout> | null = null;
	let generation = 0;
	let failures = 0;

	const MAX_POLL_FAILURES = 5;
	const RETURN_KEY = 'authrim_admin_wallet_login_return';

	/** Stops the timer only; a login being completed keeps its generation. */
	function pauseTimer(): void {
		if (timer) clearTimeout(timer);
		timer = null;
	}

	/** Abandons the login: any answer still on its way is ignored. */
	function stopPolling(): void {
		generation += 1;
		pauseTimer();
	}

	function reset(): void {
		stopPolling();
		started = null;
		flow = null;
		qrImage = '';
		stage = 'idle';
		busy = false;
	}

	function describe(error: unknown): string {
		if (error instanceof AuthError) {
			if (error.code === 'wallet_login_not_allowed') return $LL.admin_login_wallet_not_allowed();
			if (error.code === 'wallet_login_unavailable') return $LL.admin_login_wallet_unavailable();
		}
		return $LL.admin_login_wallet_failed();
	}

	async function complete(requestId: string, responseCode?: string): Promise<void> {
		stage = 'completing';
		await adminAuthAPI.completeWalletLogin(requestId, responseCode);
		await onSignedIn();
	}

	async function poll(requestId: string, myGeneration: number): Promise<void> {
		if (myGeneration !== generation) return;
		try {
			const status = await adminAuthAPI.getWalletLoginStatus(requestId);
			if (myGeneration !== generation) return;
			failures = 0;
			if (status === 'verified') {
				// The same-device wallet returns through the callback page; here only the cross-device
				// flow completes in place.
				if (flow === 'cross_device') {
					pauseTimer();
					await complete(requestId);
				}
				return;
			}
			if (status === 'expired') {
				message = $LL.admin_login_wallet_expired();
				reset();
				return;
			}
			if (status === 'failed') {
				message = $LL.admin_login_wallet_failed();
				reset();
				return;
			}
			stage = status === 'processing' ? 'processing' : 'waiting';
			timer = setTimeout(() => void poll(requestId, myGeneration), POLL_INTERVAL_MS);
		} catch (error) {
			if (myGeneration !== generation) return;
			// A rate limit or a network blip while the person takes the wallet: try again, slower.
			const transient =
				stage !== 'completing' &&
				!(error instanceof AuthError && error.code === 'not_found') &&
				failures + 1 < MAX_POLL_FAILURES;
			if (transient) {
				failures += 1;
				timer = setTimeout(() => void poll(requestId, myGeneration), POLL_INTERVAL_MS * 3);
				return;
			}
			message = describe(error);
			reset();
		}
	}

	async function start(nextFlow: WalletLoginFlow): Promise<void> {
		message = '';
		busy = true;
		failures = 0;
		try {
			const result = await adminAuthAPI.startWalletLogin(nextFlow);
			flow = nextFlow;
			started = result;
			stage = 'waiting';
			if (nextFlow === 'cross_device' && result.qr) {
				const { toDataURL } = await import('qrcode');
				qrImage = await toDataURL(result.qr, { margin: 2, width: 220, errorCorrectionLevel: 'M' });
			}
			if (nextFlow === 'same_device' && result.deepLink) {
				// The wallet brings the browser back to the callback page; remember where to go on.
				sessionStorage.setItem(RETURN_KEY, window.location.search);
				// Hand over to the wallet app; it returns to the callback page after the presentation.
				window.location.assign(result.deepLink);
			}
			stopPolling();
			void poll(result.requestId, generation);
		} catch (error) {
			message = describe(error);
			reset();
		} finally {
			busy = false;
		}
	}

	onDestroy(stopPolling);
</script>

<div class="wallet-login">
	{#if message}
		<p class="wallet-message" role="alert">{message}</p>
	{/if}

	{#if started === null}
		<div class="wallet-divider"><span>{$LL.admin_login_wallet_divider()}</span></div>
		<div class="wallet-actions">
			<button
				type="button"
				class="wallet-btn"
				disabled={disabled || busy}
				onclick={() => start('same_device')}
			>
				<i class="i-ph-wallet w-5 h-5" aria-hidden="true"></i>
				<span>{$LL.admin_login_wallet_same_device()}</span>
			</button>
			<button
				type="button"
				class="wallet-btn"
				disabled={disabled || busy}
				onclick={() => start('cross_device')}
			>
				<i class="i-ph-qr-code w-5 h-5" aria-hidden="true"></i>
				<span>{$LL.admin_login_wallet_cross_device()}</span>
			</button>
		</div>
	{:else}
		<div class="wallet-pending" aria-live="polite">
			{#if qrImage}
				<img class="wallet-qr" src={qrImage} alt={$LL.admin_login_wallet_qr_alt()} />
				<p class="wallet-hint">{$LL.admin_login_wallet_scan_hint()}</p>
			{/if}
			<p class="wallet-status">
				<i class="i-ph-circle-notch animate-spin w-4 h-4" aria-hidden="true"></i>
				{#if stage === 'processing'}
					{$LL.admin_login_wallet_processing()}
				{:else if stage === 'completing'}
					{$LL.admin_login_wallet_completing()}
				{:else}
					{$LL.admin_login_wallet_waiting()}
				{/if}
			</p>
			<button type="button" class="wallet-cancel" onclick={reset}>
				{$LL.admin_login_wallet_cancel()}
			</button>
		</div>
	{/if}
</div>

<style>
	.wallet-login {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		margin-top: 1rem;
	}

	.wallet-divider {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		color: var(--text-muted, #6b7280);
		font-size: 0.8125rem;
	}

	.wallet-divider::before,
	.wallet-divider::after {
		content: '';
		flex: 1;
		height: 1px;
		background: var(--border, #d1d5db);
	}

	.wallet-actions {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.wallet-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.5rem;
		padding: 0.625rem 1rem;
		border: 1px solid var(--border, #d1d5db);
		border-radius: 0.5rem;
		background: transparent;
		color: inherit;
		font: inherit;
		cursor: pointer;
	}

	.wallet-btn:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}

	.wallet-pending {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.5rem;
	}

	.wallet-qr {
		width: 220px;
		height: 220px;
		background: #fff;
		border-radius: 0.5rem;
	}

	.wallet-hint,
	.wallet-status {
		margin: 0;
		font-size: 0.8125rem;
		text-align: center;
	}

	.wallet-status {
		display: flex;
		align-items: center;
		gap: 0.375rem;
	}

	.wallet-message {
		margin: 0;
		font-size: 0.8125rem;
		color: var(--danger, #b91c1c);
	}

	.wallet-cancel {
		background: none;
		border: none;
		color: inherit;
		font: inherit;
		text-decoration: underline;
		cursor: pointer;
	}
</style>
