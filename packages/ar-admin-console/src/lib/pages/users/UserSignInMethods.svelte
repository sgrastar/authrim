<script lang="ts">
	import type { AdminUserPasskey, AdminUserTotp } from '#lib/api/admin-users.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import Card from '#lib/ui/patterns/Card.svelte';
	import CellText from '#lib/ui/patterns/CellText.svelte';
	import DataTable from '#lib/ui/patterns/DataTable.svelte';
	import Badge from '#lib/ui/primitives/Badge.svelte';
	import DateTime from '#lib/ui/time/DateTime.svelte';
	import AuthenticatorIcon from './AuthenticatorIcon.svelte';

	/** How the user signs in: their passkeys and authenticator apps, read only. */
	interface Props {
		passkeys: readonly AdminUserPasskey[];
		totp: readonly AdminUserTotp[];
	}

	let { passkeys, totp }: Props = $props();

	const passkeyColumns = $derived([
		{ key: 'device', label: t('usr.d.col.device') },
		{ key: 'created', label: t('usr.d.col.created'), width: '24%' },
		{ key: 'used', label: t('usr.d.col.lastUsed'), width: '24%' }
	]);
	const totpColumns = $derived([
		{ key: 'label', label: t('usr.d.col.label') },
		{ key: 'status', label: t('usr.d.col.status'), width: '24%' },
		{ key: 'used', label: t('usr.d.col.lastUsed'), width: '24%' }
	]);
	const statusLabel = (status: string) =>
		status === 'active'
			? t('usr.d.totp.active')
			: status === 'pending'
				? t('usr.d.totp.pending')
				: status;
</script>

<Card title={t('usr.d.methods')} flush={passkeys.length > 0 || totp.length > 0}>
	{#if passkeys.length === 0 && totp.length === 0}
		<p class="muted">{t('usr.d.methods.empty')}</p>
	{/if}
	{#if passkeys.length > 0}
		<DataTable
			caption={t('usr.d.passkeys')}
			columns={passkeyColumns}
			rows={passkeys}
			rowKey={(row) => row.id}
		>
			{#snippet cell(row, column)}
				{#if column.key === 'device'}
					<span class="method">
						<AuthenticatorIcon logo={row.providerIcon} fallback="fingerprint" />
						<CellText
							title={row.deviceName ?? t('usr.d.passkey.unnamed')}
							description={row.provider ?? undefined}
						/>
					</span>
				{:else if column.key === 'created'}
					{#if row.createdAt}<DateTime value={row.createdAt} stacked />{:else}—{/if}
				{:else if row.lastUsedAt}
					<DateTime value={row.lastUsedAt} stacked />
				{:else}
					<span class="muted">{t('usr.d.neverUsed')}</span>
				{/if}
			{/snippet}
		</DataTable>
	{/if}
	{#if totp.length > 0}
		<DataTable caption={t('usr.d.totp')} columns={totpColumns} rows={totp} rowKey={(row) => row.id}>
			{#snippet cell(row, column)}
				{#if column.key === 'label'}
					<span class="method">
						<AuthenticatorIcon fallback="deviceMobile" />
						<CellText title={row.label ?? t('usr.d.totp.unnamed')} />
					</span>
				{:else if column.key === 'status'}
					<Badge tone={row.status === 'active' ? 'success' : 'neutral'} dot>
						{statusLabel(row.status)}
					</Badge>
				{:else if row.lastUsedAt}
					<DateTime value={row.lastUsedAt} stacked />
				{:else}
					<span class="muted">{t('usr.d.neverUsed')}</span>
				{/if}
			{/snippet}
		</DataTable>
	{/if}
</Card>

<style>
	.method {
		display: flex;
		gap: 10px;
		align-items: center;
		min-width: 0;
	}

	.muted {
		margin: 0;
		color: var(--text-muted);
	}
</style>
