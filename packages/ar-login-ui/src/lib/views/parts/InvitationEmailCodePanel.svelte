<script lang="ts">
	/**
	 * The code step an invitation asks of a passkey or authenticator-app signup when the tenant
	 * requires the invited email to be proved: the code went to that email, the person enters it,
	 * and the signup continues. The route sends and checks the code.
	 */
	import { Button, Input } from '$lib/components';
	import { LL } from '$i18n/i18n-svelte';
	import { handleCodeEnterKey } from '$lib/utils/code-enter-key';
	import type { InvitationEmailCodeView } from '../auth-entry-types';

	type Props = {
		view: InvitationEmailCodeView;
		code?: string;
		/** The code is being checked or sent again. */
		loading?: boolean;
		busy?: boolean;
		onVerify?: () => void;
		onResend?: () => void;
		onCancel?: () => void;
	};

	let {
		view,
		code = $bindable(''),
		loading = false,
		busy = false,
		onVerify,
		onResend,
		onCancel
	}: Props = $props();

	const codeReady = $derived(/^\d{6}$/.test(code.trim()));
</script>

<div class="invitation-email-code mb-4" data-testid="invitation-email-code">
	<h3>{$LL.emailCode_title()}</h3>
	<p class="text-sm mb-3" style="color: var(--text-secondary);">
		{$LL.emailCode_subtitle()} <strong>{view.maskedEmail}</strong>
	</p>
	<Input
		label={$LL.emailCode_codeLabel()}
		bind:value={code}
		onkeypress={(event: KeyboardEvent) =>
			handleCodeEnterKey(event, () => {
				if (codeReady && !busy) onVerify?.();
			})}
		autocomplete="one-time-code"
		inputmode="numeric"
		maxlength={6}
		error={view.error}
	/>
	<div class="invitation-email-code__actions">
		<Button
			variant="primary"
			class="w-full"
			{loading}
			disabled={busy || !codeReady}
			onclick={() => onVerify?.()}
		>
			{$LL.emailCode_verifyButton()}
		</Button>
		<Button variant="secondary" class="w-full" disabled={busy} onclick={() => onResend?.()}>
			{$LL.emailCode_resendButton()}
		</Button>
		<Button variant="ghost" class="w-full" disabled={busy} onclick={() => onCancel?.()}>
			{$LL.dialog_cancel()}
		</Button>
	</div>
</div>

<style>
	.invitation-email-code__actions {
		display: grid;
		gap: 0.5rem;
		margin-top: 0.75rem;
	}
</style>
