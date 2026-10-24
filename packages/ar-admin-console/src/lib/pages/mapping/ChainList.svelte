<script lang="ts">
	import type { ChainEntry, EffectiveSelection, MappingTier } from '$lib/api/identity-mapping';
	import { t } from '$lib/i18n/i18n.svelte';
	import DataTable from '$lib/ui/patterns/DataTable.svelte';
	import Badge from '$lib/ui/primitives/Badge.svelte';
	import { chainValueText, tierLabel } from './labels';

	/**
	 * The levels of the order as the selection found them (the API's `chain`), with the one that
	 * decided marked from the selection the API returned. Nothing is worked out here: the row
	 * that decides is the selection's tier, or the level whose "none" / failure stopped it.
	 */
	interface Props {
		chain: readonly ChainEntry[];
		selection: EffectiveSelection;
		caption?: string;
	}

	let { chain, selection, caption = t('mc.chain.title') }: Props = $props();

	/** The level that decided, as the selection says. */
	const decidedAt = $derived<MappingTier | null>(
		selection.kind === 'bound'
			? selection.tier
			: selection.kind === 'failed'
				? (selection.tier ?? null)
				: selection.reason === 'client_opt_out'
					? 'client'
					: selection.reason === 'tenant_opt_out'
						? 'tenant_default'
						: null
	);
	const decidedIndex = $derived(chain.findIndex((entry) => entry.tier === decidedAt));
</script>

<DataTable
	{caption}
	columns={[
		{ key: 'level', label: t('mc.chain.col.level'), width: '30%' },
		{ key: 'value', label: t('mc.chain.col.value') },
		{ key: 'status', label: t('mc.chain.col.status'), width: '28%' }
	]}
	rows={chain}
	rowKey={(entry) => entry.tier}
>
	{#snippet cell(entry, column)}
		{#if column.key === 'level'}
			{tierLabel(entry.tier)}
		{:else if column.key === 'value'}
			<span class:muted={entry.state === 'unset' || entry.state === 'not_consulted'}>
				{chainValueText(entry)}
			</span>
		{:else if entry.tier === decidedAt}
			<Badge tone={selection.kind === 'failed' ? 'warning' : 'info'} dot>
				{selection.kind === 'bound'
					? t('mc.chain.applies')
					: selection.kind === 'none'
						? t('mc.chain.stops')
						: t('mc.state.invalid')}
			</Badge>
		{:else if decidedIndex >= 0 && chain.indexOf(entry) > decidedIndex && entry.state !== 'unset'}
			<span class="muted">{t('mc.chain.above')}</span>
		{:else}
			<span class="muted">—</span>
		{/if}
	{/snippet}
</DataTable>

<style>
	.muted {
		color: var(--text-secondary);
	}
</style>
