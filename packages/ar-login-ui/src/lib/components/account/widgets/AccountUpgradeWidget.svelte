<script lang="ts">
	/**
	 * Registering a guest account: the deletion deadline, then one of the registration methods the
	 * tenant allows, the email confirmation code, a pending registration to retry, or the outcome.
	 * Nothing renders for an account that is already registered.
	 */
	import { Button, Input } from '$lib/components';
	import { LL, getLocale } from '$i18n/i18n-svelte';
	import type { GuestUpgradeStatus } from '$lib/api/account';
	import { formatTimestamp } from '$lib/utils/date';
	import AccountWidgetPanel from './AccountWidgetPanel.svelte';
	import type { AccountWidgetHeadingLevel } from './types';

	let {
		status,
		completed = false,
		attemptMethod = null,
		busy = false,
		error = false,
		collision = false,
		pending = false,
		title = '',
		headingLevel = 2,
		onStartEmail,
		onStartPasskey,
		onConfirmCode,
		onChangeMethod,
		onRetry,
		onExistingLogin
	}: {
		status: GuestUpgradeStatus | null;
		/** The registration finished in this session. */
		completed?: boolean;
		/** The method of the registration attempt started here, if any. */
		attemptMethod?: 'email' | 'passkey' | null;
		/** A request is running: every control waits. */
		busy?: boolean;
		error?: boolean;
		/** The email or passkey already belongs to another account. */
		collision?: boolean;
		/** The registration was accepted but has not finished yet. */
		pending?: boolean;
		title?: string;
		headingLevel?: AccountWidgetHeadingLevel;
		onStartEmail: (email: string) => void;
		onStartPasskey: () => void;
		onConfirmCode: (code: string) => void;
		onChangeMethod: () => void;
		onRetry: () => void;
		/** Omit to hide the sign-in offer on a collision. */
		onExistingLogin?: () => void;
	} = $props();

	let email = $state('');
	let code = $state('');

	const deadline = $derived(
		status?.deletion_due_at == null
			? $LL.account_guestNoExpiry()
			: $LL.account_guestDue({ date: formatTimestamp(status.deletion_due_at, getLocale()) })
	);

	function startEmail(event: SubmitEvent) {
		event.preventDefault();
		if (busy) return;
		onStartEmail(email);
	}

	function confirm(event: SubmitEvent) {
		event.preventDefault();
		if (busy) return;
		onConfirmCode(code);
	}

	function changeMethod() {
		code = '';
		onChangeMethod();
	}
</script>

{#if completed}
	<p class="guest-registered" role="status">{$LL.account_guestRegistered()}</p>
{:else if status?.registration_state === 'guest'}
	<AccountWidgetPanel title={title || $LL.account_guestTitle()} {headingLevel} {busy}>
		<div class="guest-registration">
			<p class="description">{$LL.account_guestDescription()}</p>
			<p class="deadline">{deadline}</p>

			{#if collision}
				<div class="guest-alert">
					<p role="alert">{$LL.account_guestCollision()}</p>
					{#if onExistingLogin}
						<Button variant="secondary" size="sm" disabled={busy} onclick={() => onExistingLogin()}>
							{$LL.account_guestExistingLogin()}
						</Button>
					{/if}
				</div>
			{:else if error}
				<p class="guest-alert" role="alert">{$LL.account_guestError()}</p>
			{/if}

			{#if pending || status.upgrade_in_progress}
				<div class="guest-pending">
					<p role="status">{$LL.account_guestPending()}</p>
					<Button variant="secondary" loading={busy} onclick={() => onRetry()}>
						{$LL.account_guestRetry()}
					</Button>
				</div>
			{:else if attemptMethod === 'email'}
				<form class="guest-form" onsubmit={confirm}>
					<Input
						label={$LL.account_guestCode()}
						name="guest-confirmation-code"
						bind:value={code}
						inputmode="numeric"
						autocomplete="one-time-code"
						pattern={'[0-9]{6}'}
						maxlength={6}
						required
						disabled={busy}
					/>
					<div class="guest-actions">
						<Button variant="primary" type="submit" loading={busy}>
							{$LL.account_guestConfirm()}
						</Button>
						<Button variant="secondary" disabled={busy} onclick={changeMethod}>
							{$LL.account_guestChangeMethod()}
						</Button>
					</div>
				</form>
			{:else if status.upgrade_eligible}
				{#if status.allowed_methods.includes('email')}
					<form class="guest-form" onsubmit={startEmail}>
						<Input
							label={$LL.account_guestEmail()}
							type="email"
							name="guest-registration-email"
							bind:value={email}
							autocomplete="email"
							maxlength={320}
							required
							disabled={busy}
						/>
						<Button variant="primary" type="submit" disabled={busy}>
							{$LL.account_guestSend()}
						</Button>
					</form>
				{/if}
				{#if status.allowed_methods.includes('passkey')}
					<Button variant="secondary" disabled={busy} onclick={() => onStartPasskey()}>
						{$LL.account_guestPasskey()}
					</Button>
				{/if}
			{/if}
		</div>
	</AccountWidgetPanel>
{/if}

<style>
	.guest-registration,
	.guest-form,
	.guest-pending,
	.guest-alert {
		display: grid;
		gap: 12px;
	}

	.guest-pending,
	.guest-alert {
		justify-items: start;
		gap: 8px;
	}

	p {
		margin: 0;
	}

	.description,
	.deadline {
		font-size: 0.875rem;
		color: var(--text-secondary);
	}

	.guest-alert p,
	p.guest-alert {
		font-size: 0.8125rem;
		color: var(--danger-fg);
	}

	.guest-pending p {
		font-size: 0.8125rem;
		color: var(--text-secondary);
	}

	.guest-form :global(.form-group) {
		margin-bottom: 0;
	}

	.guest-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}
</style>
