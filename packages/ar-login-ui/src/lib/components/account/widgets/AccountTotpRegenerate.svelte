<script lang="ts">
	/** Remaining backup codes and regenerating them with a current authenticator code. */
	import { Button } from '$lib/components';
	import { LL } from '$i18n/i18n-svelte';
	import AccountTotpCodeField from './AccountTotpCodeField.svelte';
	import { TOTP_CODE_PATTERN } from './types';

	let {
		backupCodes,
		actionLoading = '',
		onRegenerate
	}: {
		backupCodes: { total: number; remaining: number };
		/** `totp:backup-codes` while regenerating. */
		actionLoading?: string;
		onRegenerate: (code: string) => void;
	} = $props();

	let code = $state('');

	function regenerate() {
		onRegenerate(code);
		code = '';
	}
</script>

<p class="remaining">
	{$LL.account_totpBackupCodesRemaining({
		remaining: backupCodes.remaining,
		total: backupCodes.total
	})}
</p>
<AccountTotpCodeField
	label={$LL.account_totpCurrentCode()}
	placeholder={$LL.account_reauthTotpCodePlaceholder()}
	bind:value={code}
>
	{#snippet actions()}
		<Button
			variant="secondary"
			size="sm"
			loading={actionLoading === 'totp:backup-codes'}
			disabled={!TOTP_CODE_PATTERN.test(code.trim())}
			onclick={regenerate}
		>
			{$LL.account_totpRegenerateBackupCodes()}
		</Button>
	{/snippet}
</AccountTotpCodeField>

<style>
	.remaining {
		margin: 0;
		font-size: 0.8125rem;
		color: var(--text-muted);
	}
</style>
