<script lang="ts">
	import type { FederationSource } from '#lib/api/federation-sources.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import DateTime from '#lib/ui/time/DateTime.svelte';

	/**
	 * The line under a federation's name in the list of connections: how many entities its
	 * metadata holds and when it was last fetched. Nothing is known before the first fetch.
	 */
	interface Props {
		source: FederationSource;
	}
	let { source }: Props = $props();
	const lastSuccess = $derived(source.status?.lastSuccessAt ?? null);
</script>

<span class="meta">
	{#if source.status && lastSuccess !== null}
		{#if source.status.entityCount !== null}{t('sf.fed.row.entities', {
				count: source.status.entityCount
			})} ·{/if}
		{t('sf.fed.row.lastFetched')}
		<DateTime value={new Date(lastSuccess).toISOString()} />
	{:else}
		{t('sf.fed.row.notFetched')}
	{/if}
</span>

<style>
	.meta {
		display: block;
		color: var(--text-secondary);
		font-size: var(--fs-small);
	}
</style>
