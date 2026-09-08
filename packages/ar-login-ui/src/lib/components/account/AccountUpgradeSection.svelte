<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { startRegistration, type RegistrationResponseJSON } from '@simplewebauthn/browser';
	import { LL } from '$i18n/i18n-svelte';
	import { accountAPI, type GuestUpgradeAttempt, type GuestUpgradeStatus } from '$lib/api/account';
	let {
		onCompleted = async () => {},
		onExistingLogin,
		title = '',
		initialStatus = null
	} = $props<{
		onCompleted?: () => Promise<unknown>;
		onExistingLogin?: () => Promise<void>;
		initialStatus?: GuestUpgradeStatus | null;
		title?: string;
	}>();
	let status = $state<GuestUpgradeStatus | null>(untrack(() => initialStatus));
	let attempt = $state<GuestUpgradeAttempt | null>(null);
	let email = $state('');
	let code = $state('');
	let busy = $state(false);
	let error = $state(false);
	let collision = $state(false);
	let pending = $state(false);
	let completed = $state(false);
	let proof: { code?: string; passkey_response?: RegistrationResponseJSON } = {};
	async function refresh() {
		const result = await accountAPI.getGuestUpgrade();
		if (result.data) {
			const recovered =
				status?.account_kind === 'guest' && result.data.account_kind === 'registered';
			status = result.data;
			if (recovered && !completed) {
				completed = true;
				await onCompleted();
			}
		}
	}
	onMount(() => {
		void refresh();
	});
	async function finish() {
		if (!attempt) return;
		busy = true;
		error = false;
		collision = false;
		try {
			const result = await accountAPI.completeGuestUpgrade(attempt, proof);
			if (result.error) {
				collision = result.error.error === 'identity_already_registered';
				error = !collision;
			} else if (result.data?.success) {
				completed = true;
				attempt = null;
				proof = {};
				code = '';
				await onCompleted();
			} else pending = true;
			await refresh();
		} catch {
			error = true;
		} finally {
			busy = false;
		}
	}
	async function begin(method: 'email' | 'passkey') {
		if (busy) return;
		busy = true;
		error = false;
		collision = false;
		pending = false;
		try {
			const result = await accountAPI.startGuestUpgrade(
				method,
				method === 'email' ? email : undefined
			);
			if (!result.data) {
				error = true;
				return;
			}
			attempt = result.data;
			if (method === 'passkey') {
				if (!attempt.options) {
					error = true;
					return;
				}
				proof = { passkey_response: await startRegistration({ optionsJSON: attempt.options }) };
				await finish();
			}
			await refresh();
		} catch {
			attempt = null;
			proof = {};
			error = true;
		} finally {
			busy = false;
		}
	}
	async function confirm(event: SubmitEvent) {
		event.preventDefault();
		if (busy) return;
		proof = { code };
		await finish();
	}
	function reset() {
		attempt = null;
		proof = {};
		code = '';
		pending = false;
		error = false;
		collision = false;
	}
</script>

{#if completed}
	<p role="status">{$LL.account_guestRegistered()}</p>
{:else if status?.account_kind === 'guest'}
	<section class="guest-registration" aria-busy={busy}>
		<h2>{title || $LL.account_guestTitle()}</h2>
		<p>{$LL.account_guestDescription()}</p>
		<p class="deadline">
			{status.deletion_due_at === null
				? $LL.account_guestNoExpiry()
				: $LL.account_guestDue({ date: new Date(status.deletion_due_at * 1000).toLocaleString() })}
		</p>
		{#if collision}
			<p role="alert">{$LL.account_guestCollision()}</p>
			<button
				type="button"
				disabled={busy}
				onclick={async () => {
					if (!onExistingLogin) return;
					busy = true;
					try {
						await onExistingLogin();
					} catch {
						error = true;
						collision = false;
					} finally {
						busy = false;
					}
				}}>{$LL.account_guestExistingLogin()}</button
			>
		{:else if error}
			<p role="alert">{$LL.account_guestError()}</p>
		{/if}
		{#if pending || status.upgrade_in_progress}
			<p role="status">{$LL.account_guestPending()}</p>
			<button type="button" disabled={busy} onclick={() => (attempt ? finish() : refresh())}
				>{$LL.account_guestRetry()}</button
			>
		{:else if attempt?.method === 'email'}
			<form onsubmit={confirm}>
				<label
					>{$LL.account_guestCode()}<input
						name="guest-confirmation-code"
						bind:value={code}
						inputmode="numeric"
						autocomplete="one-time-code"
						pattern="[0-9]{6}"
						maxlength="6"
						required
						disabled={busy}
					/></label
				>
				<button type="submit" disabled={busy}>{$LL.account_guestConfirm()}</button>
				<button type="button" disabled={busy} onclick={reset}
					>{$LL.account_guestChangeMethod()}</button
				>
			</form>
		{:else if status.upgrade_eligible}
			{#if status.allowed_methods.includes('email')}
				<form
					onsubmit={(event) => {
						event.preventDefault();
						void begin('email');
					}}
				>
					<label
						>{$LL.account_guestEmail()}<input
							type="email"
							name="guest-registration-email"
							bind:value={email}
							autocomplete="email"
							maxlength="320"
							required
							disabled={busy}
						/></label
					>
					<button type="submit" disabled={busy}>{$LL.account_guestSend()}</button>
				</form>
			{/if}
			{#if status.allowed_methods.includes('passkey')}
				<button type="button" disabled={busy} onclick={() => begin('passkey')}
					>{$LL.account_guestPasskey()}</button
				>
			{/if}
		{/if}
	</section>
{/if}

<style>
	.guest-registration {
		display: grid;
		gap: 0.75rem;
		padding: 1.25rem;
		border: 1px solid var(--border-color, #d1d5db);
		border-radius: 0.75rem;
	}
	h2,
	p {
		margin: 0;
	}
	h2 {
		font-size: 1.125rem;
	}
	form,
	label {
		display: grid;
		gap: 0.5rem;
	}
	input,
	button {
		font: inherit;
		padding: 0.625rem 0.75rem;
		border: 1px solid var(--border-color, #9ca3af);
		border-radius: 0.375rem;
	}
	input {
		background: var(--input-background, transparent);
		color: inherit;
	}
	button {
		cursor: pointer;
	}
	button:disabled {
		opacity: 0.6;
		cursor: wait;
	}
	.deadline {
		font-size: 0.875rem;
	}
</style>
