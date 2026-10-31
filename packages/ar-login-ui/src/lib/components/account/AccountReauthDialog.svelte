<script module lang="ts">
	/** A way to re-authenticate from the account page. */
	export type AccountReauthMethod = 'passkey' | 'email' | 'totp';
</script>

<script lang="ts">
	/**
	 * Asks for a recent authentication before a sensitive account change, with the methods the
	 * tenant allows for re-authentication. The account page owns the requests; this draws them.
	 *
	 * A modal dialog: focus moves to the first method when it opens, Tab and Shift+Tab stay inside,
	 * Escape or the backdrop closes it, and focus returns to the control that opened it.
	 */
	import { Button } from '$lib/components';
	import { LL } from '$i18n/i18n-svelte';
	import { TOTP_CODE_PATTERN } from './widgets/types';

	let {
		open = false,
		passkeyAvailable = false,
		emailCodeAvailable = false,
		totpAvailable = false,
		pending = null,
		emailCodeSent = false,
		maskedEmail = '',
		emailCode = $bindable(''),
		totpCode = $bindable(''),
		error = '',
		onPasskey,
		onSendEmailCode,
		onVerifyEmailCode,
		onVerifyTotp,
		onClose
	}: {
		open?: boolean;
		passkeyAvailable?: boolean;
		/** A verified email address and an email-code method allowed for re-authentication. */
		emailCodeAvailable?: boolean;
		/** An active authenticator app and a TOTP method allowed for re-authentication. */
		totpAvailable?: boolean;
		/** The method whose request is running: its button spins and every method waits. */
		pending?: AccountReauthMethod | null;
		emailCodeSent?: boolean;
		/** Where the code went, as the API masks it. */
		maskedEmail?: string;
		emailCode?: string;
		totpCode?: string;
		error?: string;
		onPasskey: () => void;
		onSendEmailCode: () => void;
		onVerifyEmailCode: () => void;
		onVerifyTotp: () => void;
		onClose: () => void;
	} = $props();

	const id = $props.id();
	const hasMethod = $derived(passkeyAvailable || emailCodeAvailable || totpAvailable);
	const busy = $derived(pending !== null);

	let dialog = $state<HTMLDivElement | null>(null);
	let emailCodeInput = $state<HTMLInputElement | null>(null);

	const FOCUSABLE = [
		'a[href]',
		'button:not([disabled])',
		'input:not([disabled])',
		'select:not([disabled])',
		'textarea:not([disabled])',
		'[tabindex]:not([tabindex="-1"])'
	].join(', ');

	function focusables(): HTMLElement[] {
		return dialog ? [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)] : [];
	}

	// Opening: remember the opener, focus the first method (else the close button). Closing or
	// leaving the page: give focus back to the opener if it is still there.
	$effect(() => {
		if (!open || !dialog) return;
		const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		const first =
			dialog.querySelector<HTMLElement>(`.reauth-actions :is(${FOCUSABLE})`) ?? focusables()[0];
		(first ?? dialog).focus();
		return () => {
			if (opener?.isConnected) opener.focus();
		};
	});

	// The send button that had focus is replaced by the code field: continue there.
	$effect(() => {
		if (emailCodeSent) emailCodeInput?.focus();
	});

	function handleKeydown(event: KeyboardEvent) {
		if (!open || !dialog) return;
		if (event.key === 'Escape') {
			event.preventDefault();
			onClose();
			return;
		}
		if (event.key !== 'Tab') return;
		const items = focusables();
		const first = items[0];
		const last = items[items.length - 1];
		const active = document.activeElement;
		if (!first || !last) {
			event.preventDefault();
			dialog.focus();
		} else if (!(active instanceof Node) || !dialog.contains(active)) {
			event.preventDefault();
			(event.shiftKey ? last : first).focus();
		} else if (event.shiftKey && (active === first || active === dialog)) {
			event.preventDefault();
			last.focus();
		} else if (!event.shiftKey && active === last) {
			event.preventDefault();
			first.focus();
		}
	}
</script>

<svelte:window onkeydown={handleKeydown} />

{#if open}
	<!-- Pointer users can dismiss by clicking outside; keyboard users have Escape and Close. -->
	<div class="reauth-backdrop" aria-hidden="true" onclick={() => onClose()}></div>
	<div
		bind:this={dialog}
		class="reauth-dialog"
		role="dialog"
		aria-modal="true"
		aria-labelledby={`${id}-title`}
		aria-describedby={`${id}-description`}
		tabindex="-1"
	>
		<div class="reauth-dialog__header">
			<h2 id={`${id}-title`}>{$LL.account_reauthTitle()}</h2>
			<button
				type="button"
				class="reauth-dialog__close"
				aria-label={$LL.dialog_close()}
				onclick={() => onClose()}
			>
				<span class="i-ph-x" aria-hidden="true"></span>
			</button>
		</div>
		<p id={`${id}-description`}>{$LL.account_reauthDescription()}</p>
		{#if error}
			<p class="reauth-dialog__error" role="alert">{error}</p>
		{/if}
		{#if !hasMethod}
			<p class="reauth-dialog__error" role="alert">{$LL.account_reauthNoMethods()}</p>
		{/if}
		<div class="reauth-actions">
			{#if passkeyAvailable}
				<Button
					variant="primary"
					loading={pending === 'passkey'}
					disabled={busy}
					onclick={() => onPasskey()}
				>
					{$LL.account_reauthWithPasskey()}
				</Button>
			{/if}
			{#if emailCodeAvailable}
				{#if emailCodeSent}
					<div class="reauth-code">
						<p>{$LL.account_reauthEmailCodeSent({ email: maskedEmail })}</p>
						<label for={`${id}-email-code`}>{$LL.emailCode_codeLabel()}</label>
						<input
							bind:this={emailCodeInput}
							id={`${id}-email-code`}
							class="reauth-code__input"
							autocomplete="one-time-code"
							inputmode="numeric"
							maxlength={6}
							placeholder={$LL.account_reauthEmailCodePlaceholder()}
							bind:value={emailCode}
						/>
						<Button
							variant="primary"
							loading={pending === 'email'}
							disabled={busy || emailCode.trim().length !== 6}
							onclick={() => onVerifyEmailCode()}
						>
							{$LL.account_reauthVerifyEmailCode()}
						</Button>
					</div>
				{:else}
					<Button
						variant="secondary"
						loading={pending === 'email'}
						disabled={busy}
						onclick={() => onSendEmailCode()}
					>
						{$LL.account_reauthWithEmailCode()}
					</Button>
				{/if}
			{/if}
			{#if totpAvailable}
				<div class="reauth-code">
					<label for={`${id}-totp-code`}>{$LL.login_totpCodeLabel()}</label>
					<input
						id={`${id}-totp-code`}
						class="reauth-code__input"
						autocomplete="one-time-code"
						inputmode="numeric"
						maxlength={8}
						placeholder={$LL.account_reauthTotpCodePlaceholder()}
						bind:value={totpCode}
					/>
					<Button
						variant="secondary"
						loading={pending === 'totp'}
						disabled={busy || !TOTP_CODE_PATTERN.test(totpCode.trim())}
						onclick={() => onVerifyTotp()}
					>
						{$LL.account_reauthWithTotp()}
					</Button>
				</div>
			{/if}
			<Button variant="secondary" onclick={() => onClose()}>
				{$LL.dialog_cancel()}
			</Button>
		</div>
	</div>
{/if}

<style>
	.reauth-backdrop {
		position: fixed;
		inset: 0;
		z-index: var(--z-modal-backdrop);
		background: rgb(0 0 0 / 0.62);
		backdrop-filter: blur(3px);
		-webkit-backdrop-filter: blur(3px);
	}

	.reauth-dialog {
		position: fixed;
		z-index: var(--z-modal);
		top: 50%;
		left: 50%;
		width: min(calc(100vw - 32px), 420px);
		max-height: calc(100dvh - 32px);
		overflow-y: auto;
		transform: translate(-50%, -50%);
		display: grid;
		gap: 16px;
		padding: 24px;
		border-radius: 16px;
		border: 1px solid var(--border);
		/* A card as it looks on the page: glass themes have a translucent --bg-card, which over the
		   dimmed page would let the widgets behind show through the dialog. */
		background: linear-gradient(var(--bg-card), var(--bg-card)), var(--bg-page);
		color: var(--text-primary);
		box-shadow: 0 24px 70px rgb(0 0 0 / 0.28);
		isolation: isolate;
	}

	.reauth-dialog:focus {
		outline: none;
	}

	.reauth-dialog__header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
	}

	h2,
	p {
		margin: 0;
	}

	h2 {
		font-size: 1.125rem;
	}

	p {
		color: var(--text-muted);
		line-height: 1.6;
	}

	.reauth-dialog__close {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex: none;
		width: 32px;
		height: 32px;
		padding: 0;
		border: 1px solid var(--border);
		border-radius: 999px;
		background: transparent;
		color: var(--text-muted);
		cursor: pointer;
	}

	.reauth-dialog__close span {
		width: 16px;
		height: 16px;
	}

	.reauth-dialog__close:hover {
		color: var(--text-primary);
	}

	.reauth-dialog__close:focus-visible {
		outline: 2px solid var(--primary);
		outline-offset: 2px;
	}

	.reauth-dialog__error {
		color: var(--danger-fg);
		font-weight: 600;
	}

	.reauth-actions {
		display: grid;
		gap: 8px;
	}

	.reauth-code {
		display: grid;
		gap: 10px;
	}

	.reauth-code label {
		margin-bottom: -4px;
		font-size: 0.8125rem;
		font-weight: 600;
		color: var(--text-primary);
	}

	.reauth-code__input {
		width: 100%;
		min-height: 44px;
		border: 1px solid var(--border);
		border-radius: 12px;
		background: var(--bg-card);
		color: var(--text-primary);
		font: inherit;
		letter-spacing: 0.08em;
		padding: 0 14px;
	}

	.reauth-code__input::placeholder {
		color: var(--text-muted);
		letter-spacing: normal;
	}

	.reauth-code__input:focus {
		outline: none;
		border-color: var(--primary);
		box-shadow: 0 0 0 3px var(--primary-light);
	}
</style>
