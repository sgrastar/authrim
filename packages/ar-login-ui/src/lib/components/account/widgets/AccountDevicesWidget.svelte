<script lang="ts">
	/** Apps and devices linked to the account (not browser sign-ins: see the sessions widget). */
	import { LL, getLocale } from '$i18n/i18n-svelte';
	import type { AccountDevice } from '$lib/api/account';
	import { formatTimestamp } from '$lib/utils/date';
	import AccountSectionSkeleton from '../AccountSectionSkeleton.svelte';
	import AccountWidgetPanel from './AccountWidgetPanel.svelte';
	import type { AccountWidgetCommonProps } from './types';

	let {
		devices = [],
		title = '',
		headingLevel = 2,
		loading = false,
		refreshing = false,
		error = '',
		reauthNeeded = false,
		onRefresh,
		onReauthenticate
	}: AccountWidgetCommonProps & { devices?: AccountDevice[] } = $props();
</script>

<AccountWidgetPanel
	title={title || $LL.account_devices()}
	{headingLevel}
	busy={loading}
	{refreshing}
	{error}
	{reauthNeeded}
	{onRefresh}
	{onReauthenticate}
>
	<p class="description">{$LL.account_connectedDevicesDescription()}</p>
	{#if loading}
		<AccountSectionSkeleton variant="list" rows={0} />
	{:else if devices.length === 0}
		<p class="empty-text">{$LL.account_noConnectedDevices()}</p>
	{:else}
		<ul class="item-list">
			{#each devices as device (device.id)}
				<li>
					<strong>
						{device.display_name || device.fallback_display_name || device.id}
						{#if device.current}
							<span class="inline-tag">{$LL.account_currentDevice()}</span>
						{/if}
					</strong>
					<span class="meta">
						{device.platform} / {formatTimestamp(device.last_seen_at_unix, getLocale())}
					</span>
				</li>
			{/each}
		</ul>
	{/if}
</AccountWidgetPanel>

<style>
	.item-list {
		display: grid;
		gap: 8px;
		list-style: none;
		padding: 0;
		margin: 0;
	}

	.item-list li {
		display: grid;
		gap: 2px;
		padding: 10px 0;
		border-top: 1px solid var(--border);
	}

	strong,
	.meta {
		display: block;
		overflow-wrap: anywhere;
	}

	strong {
		font-size: 0.875rem;
	}

	.meta,
	.description,
	.empty-text {
		margin: 0;
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
