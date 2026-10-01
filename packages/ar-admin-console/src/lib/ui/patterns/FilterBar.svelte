<script lang="ts">
	import type { Snippet } from 'svelte';
	import { t } from '$lib/i18n/i18n.svelte';
	import Button from '../primitives/Button.svelte';

	/**
	 * The row above a list that narrows it: a SearchField, then filters (Select, SelectMenu,
	 * DateRangeField — all `size="sm"`, so they line up), then the number of results and a way
	 * back to everything. Sits directly above the table's card.
	 *
	 * - The result count is announced when it changes, so a screen-reader user hears the effect
	 *   of each filter.
	 * - "Clear filters" appears only while something narrows the list (`active`).
	 * - Wraps on narrow screens; the search box takes the space that is left.
	 */
	interface Props {
		/** Accessible name of the search landmark. */
		label?: string;
		/** The search box (SearchField size="sm"). */
		search?: Snippet;
		/** Filters, in the order people narrow by. */
		children?: Snippet;
		/** Number of results after filtering; omit while loading. */
		results?: number;
		/** Whether any search text or filter is set. */
		active?: boolean;
		onclear?: () => void;
	}

	let {
		label = t('filter.region'),
		search,
		children,
		results,
		active = false,
		onclear
	}: Props = $props();
</script>

<div class="filter-bar" role="search" aria-label={label}>
	{#if search}<div class="filter-bar__search">{@render search()}</div>{/if}
	{#if children}<div class="filter-bar__filters">{@render children()}</div>{/if}
	<div class="filter-bar__end">
		<p class="filter-bar__count" aria-live="polite">
			{results === undefined ? '' : t('filter.results', { n: results })}
		</p>
		{#if active && onclear}
			<Button size="sm" variant="ghost" icon="close" onclick={onclear}
				>{t('filter.clearAll')}</Button
			>
		{/if}
	</div>
</div>

<style>
	.filter-bar {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		gap: var(--space-related) 12px;
	}

	.filter-bar__search {
		flex: 1 1 240px;
		max-width: 360px;
	}

	.filter-bar__filters {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		gap: var(--space-related);
	}

	.filter-bar__end {
		display: flex;
		align-items: center;
		gap: var(--space-related);
		min-height: var(--control-h-sm);
		margin-inline-start: auto;
	}

	.filter-bar__count {
		margin: 0;
		color: var(--text-secondary);
		font-size: var(--fs-caption);
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}
</style>
