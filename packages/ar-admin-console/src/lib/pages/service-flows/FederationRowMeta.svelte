<script lang="ts">
	import type { FederationSource } from '#lib/api/federation-sources.js';
	import { t } from '#lib/i18n/i18n.svelte.js';

	/**
	 * The line under a federation's name in the list of connections: how many entities its
	 * metadata holds. When it was last fetched is the list's "modified" column.
	 */
	interface Props {
		source: FederationSource;
	}
	let { source }: Props = $props();
	const lastSuccess = $derived(source.status?.lastSuccessAt ?? null);
</script>

<span class="meta">
	{#if source.status && source.status.entityCount !== null}
		{t('sf.fed.row.entities', { count: source.status.entityCount })}
	{:else if !lastSuccess}
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
