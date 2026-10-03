<script lang="ts">
	/**
	 * An authenticator app enrollment in progress: the QR code and manual key with the activation
	 * code, then (once activated) the one-time backup codes.
	 */
	import { Button } from '$lib/components';
	import { LL } from '$i18n/i18n-svelte';
	import AccountTotpCodeField from './AccountTotpCodeField.svelte';
	import { TOTP_CODE_PATTERN, type AccountTotpEnrollment } from './types';

	let {
		enrollment,
		headingLevel,
		actionLoading = '',
		onActivate,
		onClear
	}: {
		enrollment: AccountTotpEnrollment;
		/** One below the widget's own heading. */
		headingLevel: 3 | 4;
		/** `totp:activate:<credentialId>` while activating. */
		actionLoading?: string;
		onActivate: (code: string) => void;
		onClear: () => void;
	} = $props();

	let activationCode = $state('');
	let qrDataUrl = $state('');

	function activate() {
		onActivate(activationCode);
		activationCode = '';
	}

	// The QR library is only needed while enrolling, so it is loaded on demand.
	$effect(() => {
		const uri = enrollment.otpauthUri;
		if (!uri) {
			qrDataUrl = '';
			return;
		}
		import('qrcode')
			.then(({ toDataURL }) => toDataURL(uri, { margin: 1, width: 192 }))
			.then((value) => {
				if (enrollment.otpauthUri === uri) qrDataUrl = value;
			})
			.catch(() => {
				if (enrollment.otpauthUri === uri) qrDataUrl = '';
			});
	});
</script>

<div class="enrollment">
	{#if enrollment.backupCodes.length > 0}
		<svelte:element this={`h${headingLevel}`}>{$LL.account_totpBackupCodes()}</svelte:element>
		<ul class="backup-code-list">
			{#each enrollment.backupCodes as backupCode (backupCode)}
				<li><code>{backupCode}</code></li>
			{/each}
		</ul>
		<div>
			<Button variant="secondary" size="sm" onclick={() => onClear()}>
				{$LL.account_totpDone()}
			</Button>
		</div>
	{:else}
		<svelte:element this={`h${headingLevel}`}>{$LL.account_totpSetupTitle()}</svelte:element>
		{#if qrDataUrl}
			<img class="qr" src={qrDataUrl} alt={$LL.account_totpQrAlt()} />
		{/if}
		<div class="manual-key">
			<span>{$LL.account_totpManualKey()}</span>
			<code>{enrollment.secret}</code>
		</div>
		<AccountTotpCodeField
			label={$LL.account_totpActivationCode()}
			placeholder={$LL.account_reauthTotpCodePlaceholder()}
			bind:value={activationCode}
		>
			{#snippet actions()}
				<Button
					variant="primary"
					size="sm"
					loading={actionLoading === `totp:activate:${enrollment.credentialId}`}
					disabled={!TOTP_CODE_PATTERN.test(activationCode.trim())}
					onclick={activate}
				>
					{$LL.account_totpActivate()}
				</Button>
				<Button variant="secondary" size="sm" onclick={() => onClear()}>
					{$LL.dialog_cancel()}
				</Button>
			{/snippet}
		</AccountTotpCodeField>
	{/if}
</div>

<style>
	.enrollment {
		display: grid;
		gap: 10px;
		padding: 12px;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		background: color-mix(in srgb, var(--bg-card) 92%, var(--primary) 8%);
	}

	.enrollment :global(h3),
	.enrollment :global(h4) {
		margin: 0;
		font-size: 0.875rem;
	}

	.qr {
		width: 192px;
		max-width: 100%;
		height: auto;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		/* A QR code needs a light quiet zone in every theme. */
		background: #ffffff;
		padding: 8px;
	}

	.manual-key {
		display: grid;
		gap: 8px;
	}

	.manual-key span {
		font-size: 0.8125rem;
		color: var(--text-muted);
	}

	code {
		font-size: 0.8125rem;
		overflow-wrap: anywhere;
	}

	.backup-code-list {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
		gap: 8px;
		padding: 0;
		margin: 0;
		list-style: none;
	}

	.backup-code-list li {
		padding: 8px 10px;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		background: var(--bg-card);
	}
</style>
