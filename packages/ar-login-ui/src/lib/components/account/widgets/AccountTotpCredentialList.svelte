<script lang="ts">
	/**
	 * Registered authenticator apps. Deleting one needs proof: a current code or a backup code,
	 * typed into that row's own field.
	 */
	import { Button } from '$lib/components';
	import { LL, getLocale } from '$i18n/i18n-svelte';
	import { isTotpDeleteProofReady } from '$lib/account/totp-proof';
	import type { AccountTotpCredential } from '$lib/api/account';
	import { formatTimestamp } from '$lib/utils/date';
	import AccountTotpCodeField from './AccountTotpCodeField.svelte';

	let {
		credentials,
		actionLoading = '',
		onDelete
	}: {
		credentials: AccountTotpCredential[];
		/** `totp:<id>` while deleting that credential. */
		actionLoading?: string;
		onDelete: (id: string, code: string) => void;
	} = $props();

	let deleteCodes = $state<Record<string, string>>({});

	function remove(id: string) {
		onDelete(id, deleteCodes[id] ?? '');
		deleteCodes[id] = '';
	}

	function credentialName(credential: AccountTotpCredential): string {
		return credential.label || $LL.account_totpDefaultName();
	}
</script>

<ul class="item-list">
	{#each credentials as credential (credential.id)}
		{@const name = credentialName(credential)}
		<li>
			<div class="summary">
				<strong>{name}</strong>
				<span>
					{credential.algorithm} / {credential.digits} / {credential.period}s
					{#if credential.status !== 'active'}
						<span class="inline-tag">{$LL.account_totpPending()}</span>
					{/if}
				</span>
				<span>
					{credential.last_used_at
						? $LL.account_totpLastUsed({
								time: formatTimestamp(credential.last_used_at, getLocale())
							})
						: formatTimestamp(credential.created_at, getLocale())}
				</span>
			</div>
			<AccountTotpCodeField
				label={`${name}: ${$LL.account_totpDeleteCode()}`}
				hideLabel
				compact
				inputmode="text"
				maxlength={32}
				placeholder={$LL.account_totpDeleteCode()}
				bind:value={
					() => deleteCodes[credential.id] ?? '', (value) => (deleteCodes[credential.id] = value)
				}
			>
				{#snippet actions()}
					<Button
						variant="danger"
						size="sm"
						loading={actionLoading === `totp:${credential.id}`}
						disabled={!isTotpDeleteProofReady(deleteCodes[credential.id] ?? '')}
						onclick={() => remove(credential.id)}
					>
						{$LL.account_delete()}
					</Button>
				{/snippet}
			</AccountTotpCodeField>
		</li>
	{/each}
</ul>

<style>
	.item-list {
		display: grid;
		gap: 8px;
		list-style: none;
		padding: 0;
		margin: 0;
	}

	.item-list li {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-start;
		justify-content: space-between;
		gap: 12px;
		padding: 10px 0;
		border-top: 1px solid var(--border);
	}

	.summary {
		min-width: 0;
	}

	strong,
	span {
		display: block;
		overflow-wrap: anywhere;
	}

	strong {
		font-size: 0.875rem;
	}

	span {
		font-size: 0.8125rem;
		color: var(--text-muted);
	}

	.inline-tag {
		display: inline-flex;
		margin-inline-start: 8px;
		font-size: 0.75rem;
		font-weight: 600;
		color: var(--text-secondary);
	}
</style>
