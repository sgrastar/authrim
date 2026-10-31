<script lang="ts">
	import { formatNumber } from '../format';
	import { i18n, t } from '$lib/i18n/i18n.svelte';
	import Icon from '../icons/Icon.svelte';
	import Select from '../primitives/Select.svelte';
	import { pageItems } from './pagination';

	/**
	 * Paging for long lists: the visible range, page buttons with gaps, and an optional
	 * rows-per-page choice. Pages are 1-based. The page decides whether to page on the client or
	 * send `page`/`pageSize` to the API.
	 */
	interface Props {
		page?: number;
		pageSize?: number;
		total: number;
		/** Offer a rows-per-page choice. */
		pageSizes?: readonly number[];
		/** Pages shown on each side of the current one. */
		siblings?: number;
		onchange?: (page: number, pageSize: number) => void;
	}

	let {
		page = $bindable(1),
		pageSize = $bindable(20),
		total,
		pageSizes,
		siblings = 1,
		onchange
	}: Props = $props();

	const pageCount = $derived(Math.max(1, Math.ceil(total / pageSize)));
	const from = $derived(total === 0 ? 0 : (page - 1) * pageSize + 1);
	const to = $derived(Math.min(total, page * pageSize));
	const number = (n: number) => formatNumber(n, i18n.locale);

	function go(next: number) {
		const target = Math.min(Math.max(1, next), pageCount);
		if (target === page) return;
		page = target;
		onchange?.(page, pageSize);
	}
</script>

<nav class="pager" aria-label={t('pager.label')}>
	<p class="pager__range">
		{t('pager.range', { from: number(from), to: number(to), total: number(total) })}
	</p>

	{#if pageSizes?.length}
		<div class="pager__size">
			<Select
				label={t('pager.perPage')}
				size="sm"
				inline
				value={String(pageSize)}
				options={pageSizes.map((size) => ({ value: String(size), label: String(size) }))}
				onchange={(value) => {
					pageSize = Number(value);
					page = 1;
					onchange?.(page, pageSize);
				}}
			/>
		</div>
	{/if}

	<ul class="pager__pages">
		<li>
			<button
				type="button"
				class="pager__step"
				aria-label={t('pager.prev')}
				title={t('pager.prev')}
				disabled={page <= 1}
				onclick={() => go(page - 1)}><Icon name="caretLeft" /></button
			>
		</li>
		{#each pageItems(page, pageCount, siblings) as item, index (typeof item === 'number' ? item : `gap-${index}`)}
			<li>
				{#if item === 'gap'}
					<span class="pager__gap" aria-hidden="true">…</span>
				{:else}
					<button
						type="button"
						class="pager__page"
						aria-label={t('pager.page', { n: number(item) })}
						aria-current={item === page ? 'page' : undefined}
						onclick={() => go(item)}>{number(item)}</button
					>
				{/if}
			</li>
		{/each}
		<li>
			<button
				type="button"
				class="pager__step"
				aria-label={t('pager.next')}
				title={t('pager.next')}
				disabled={page >= pageCount}
				onclick={() => go(page + 1)}><Icon name="caretRight" /></button
			>
		</li>
	</ul>
</nav>

<style>
	.pager {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 10px 16px;
		padding: 10px 14px;
		font-size: var(--fs-label);
	}

	.pager__range {
		margin: 0;
		color: var(--text-secondary);
		font-variant-numeric: tabular-nums;
	}

	.pager__size {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.pager__pages {
		display: flex;
		align-items: center;
		gap: 2px;
		margin: 0;
		margin-inline-start: auto;
		padding: 0;
		list-style: none;
	}

	.pager__page,
	.pager__step {
		display: grid;
		place-items: center;
		min-width: var(--control-h-sm);
		height: var(--control-h-sm);
		padding: 0 6px;
		border: 1px solid transparent;
		border-radius: var(--radius-control);
		background: transparent;
		color: var(--text-secondary);
		font-variant-numeric: tabular-nums;
		--icon-size: var(--icon-sm);
	}

	.pager__page:hover,
	.pager__step:hover:not(:disabled) {
		background: var(--bg-hover);
		color: var(--text-primary);
	}

	.pager__page[aria-current='page'] {
		border-color: var(--border-strong);
		background: var(--bg-card);
		color: var(--text-primary);
		font-weight: var(--fw-semibold);
	}

	.pager__step:disabled {
		opacity: 0.4;
	}

	.pager__gap {
		display: grid;
		place-items: center;
		min-width: 22px;
		color: var(--text-muted);
	}

	@media (max-width: 640px) {
		.pager__pages {
			width: 100%;
			justify-content: center;
			margin-inline-start: 0;
		}
	}
</style>
