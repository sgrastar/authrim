<script lang="ts" module>
	export interface Column {
		key: string;
		label: string;
		/** CSS width such as '34%' or '120px'. Fixed widths keep grouped tables aligned. */
		width?: string;
		/** `center` for columns of checkboxes or marks. */
		align?: 'start' | 'center' | 'end';
		/** Header becomes a sort button. Sorting itself is up to the page (client or server). */
		sortable?: boolean;
	}

	export type SortDirection = 'asc' | 'desc';
	export interface SortState {
		key: string;
		direction: SortDirection;
	}
</script>

<script lang="ts" generics="Row">
	import type { Snippet } from 'svelte';
	import { t } from '$lib/i18n/i18n.svelte';
	import Icon from '../icons/Icon.svelte';
	import Button from '../primitives/Button.svelte';
	import Checkbox from '../primitives/Checkbox.svelte';

	interface Props {
		columns: readonly Column[];
		rows: readonly Row[];
		rowKey: (row: Row) => string;
		cell: Snippet<[Row, Column]>;
		/** Shown instead of the body when there are no rows. */
		empty?: Snippet;
		/** Accessible table name, usually the card title. */
		caption: string;
		/** Current sort. Clicking a sortable header cycles ascending → descending. */
		sort?: SortState | null;
		onsort?: (sort: SortState) => void;
		/** Adds a checkbox column. `selected` holds row keys. */
		selectable?: boolean;
		selected?: string[];
		/** Accessible name of a row for its checkbox ("Select {name}"). */
		rowLabel?: (row: Row) => string;
		/** Bulk actions shown while rows are selected. */
		bulkActions?: Snippet<[string[]]>;
		/** Rows holding an unsaved change get the change wash (with SaveScope). */
		rowChanged?: (row: Row) => boolean;
	}

	let {
		columns,
		rows,
		rowKey,
		cell,
		empty,
		caption,
		sort = $bindable(null),
		onsort,
		selectable = false,
		selected = $bindable([]),
		rowLabel,
		bulkActions,
		rowChanged
	}: Props = $props();

	const keys = $derived(rows.map(rowKey));
	const selectedSet = $derived(new Set(selected));
	const selectedHere = $derived(keys.filter((key) => selectedSet.has(key)).length);
	const allSelected = $derived(keys.length > 0 && selectedHere === keys.length);
	const someSelected = $derived(selectedHere > 0 && !allSelected);

	function toggleSort(column: Column) {
		const next: SortState =
			sort?.key === column.key && sort.direction === 'asc'
				? { key: column.key, direction: 'desc' }
				: { key: column.key, direction: 'asc' };
		sort = next;
		onsort?.(next);
	}

	function setAll(on: boolean) {
		const others = selected.filter((key) => !keys.includes(key));
		selected = on ? [...others, ...keys] : others;
	}

	function setRow(key: string, on: boolean) {
		selected = on ? [...selected, key] : selected.filter((k) => k !== key);
	}

	function ariaSort(column: Column): 'ascending' | 'descending' | 'none' | undefined {
		if (!column.sortable) return undefined;
		if (sort?.key !== column.key) return 'none';
		return sort.direction === 'asc' ? 'ascending' : 'descending';
	}
</script>

{#if selectable && selected.length > 0}
	<div class="bulk" role="region" aria-label={t('table.selected', { n: selected.length })}>
		<span class="bulk__count">{t('table.selected', { n: selected.length })}</span>
		{#if !allSelected}
			<Button size="sm" variant="ghost" onclick={() => setAll(true)}>{t('table.selectAll')}</Button>
		{/if}
		<Button size="sm" variant="ghost" onclick={() => (selected = [])}
			>{t('table.clearSelection')}</Button
		>
		{#if bulkActions}<div class="bulk__actions">{@render bulkActions(selected)}</div>{/if}
	</div>
{/if}

<div class="table-wrap">
	<table class="data">
		<caption class="sr-only">{caption}</caption>
		<colgroup>
			{#if selectable}<col class="data__select-col" />{/if}
			{#each columns as column (column.key)}<col style:width={column.width} />{/each}
		</colgroup>
		<thead>
			<tr>
				{#if selectable}
					<th scope="col" class="data__select">
						<Checkbox
							hideLabel
							checked={allSelected}
							indeterminate={someSelected}
							disabled={keys.length === 0}
							onchange={(event) => setAll(event.currentTarget.checked)}
						>
							{t('table.selectAllRows')}
						</Checkbox>
					</th>
				{/if}
				{#each columns as column (column.key)}
					<th
						scope="col"
						class:end={column.align === 'end'}
						class:center={column.align === 'center'}
						aria-sort={ariaSort(column)}
					>
						{#if column.sortable}
							<button
								type="button"
								class="sort"
								class:is-active={sort?.key === column.key}
								title={t('table.sortBy', { column: column.label })}
								onclick={() => toggleSort(column)}
							>
								{column.label}
								<Icon
									name={sort?.key !== column.key
										? 'sort'
										: sort.direction === 'asc'
											? 'arrowUp'
											: 'arrowDown'}
								/>
							</button>
						{:else}
							{column.label}
						{/if}
					</th>
				{/each}
			</tr>
		</thead>
		<tbody>
			{#each rows as row (rowKey(row))}
				{@const key = rowKey(row)}
				<tr
					class:is-selected={selectable && selectedSet.has(key)}
					class:is-changed={rowChanged?.(row) ?? false}
				>
					{#if selectable}
						<td class="data__select">
							<Checkbox
								hideLabel
								checked={selectedSet.has(key)}
								onchange={(event) => setRow(key, event.currentTarget.checked)}
							>
								{t('table.selectRow', { name: rowLabel?.(row) ?? key })}
							</Checkbox>
						</td>
					{/if}
					{#each columns as column (column.key)}
						<td class:end={column.align === 'end'} class:center={column.align === 'center'}
							>{@render cell(row, column)}</td
						>
					{/each}
				</tr>
			{:else}
				{#if empty}
					<tr>
						<td class="data__empty" colspan={columns.length + (selectable ? 1 : 0)}
							>{@render empty()}</td
						>
					</tr>
				{/if}
			{/each}
		</tbody>
	</table>
</div>

<style>
	/* Narrow screens scroll the table sideways; collapsing columns would break the reading. */
	.table-wrap {
		overflow-x: auto;
	}

	.data {
		width: 100%;
		border-collapse: collapse;
		table-layout: fixed;
		font-size: var(--fs-body);
	}

	.data__select-col {
		width: 44px;
	}

	th {
		padding: 9px 16px;
		border-bottom: 1px solid var(--border-subtle);
		background: var(--bg-subtle);
		color: var(--text-muted);
		font-size: var(--fs-small);
		font-weight: var(--fw-semibold);
		letter-spacing: 0.03em;
		text-align: start;
		white-space: nowrap;
	}

	td {
		padding: 11px 16px;
		border-bottom: 1px solid var(--border-subtle);
		vertical-align: middle;
		overflow-wrap: anywhere;
	}

	th.data__select,
	td.data__select {
		padding-inline: 14px 0;
	}

	/* End-aligned columns hold numbers: equal-width digits keep the places lined up. */
	.end {
		text-align: end;
		font-variant-numeric: tabular-nums;
	}

	/* Headers of narrow centred columns may wrap ("Re-authentication"). */
	.center {
		text-align: center;
	}

	th.center {
		white-space: normal;
		/* Long single words (German "Kontoverknüpfung") hyphenate instead of spilling over. */
		overflow-wrap: break-word;
		hyphens: auto;
	}

	.sort {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		margin: -3px -6px;
		padding: 3px 6px;
		border: 0;
		border-radius: var(--radius-xs);
		background: none;
		color: inherit;
		font: inherit;
		letter-spacing: inherit;
		--icon-size: var(--icon-xs);
	}

	.sort :global(svg) {
		opacity: 0.55;
	}

	.sort:hover {
		background: var(--bg-hover);
		color: var(--text-primary);
	}

	.sort.is-active {
		color: var(--text-primary);
	}

	.sort.is-active :global(svg) {
		opacity: 1;
	}

	tbody tr:last-child td {
		border-bottom: 0;
	}

	tbody tr:hover td:not(.data__empty) {
		background: var(--bg-hover);
	}

	tbody tr.is-selected td {
		background: color-mix(in srgb, var(--primary) 7%, transparent);
	}

	/* A row with an unsaved change; the changed control inside it carries a ring. */
	tbody tr.is-changed td {
		background: var(--changed-bg);
	}

	/* Quiet text in a changed row stays readable (AA) on the wash. */
	tbody tr.is-changed :global(.na) {
		color: var(--text-secondary);
	}

	.data__empty {
		padding: 0;
	}

	.bulk {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px 10px;
		padding: 8px 14px;
		border-bottom: 1px solid var(--border-subtle);
		background: color-mix(in srgb, var(--primary) 7%, var(--bg-card));
	}

	.bulk__count {
		font-size: var(--fs-body);
		font-weight: var(--fw-semibold);
	}

	.bulk__actions {
		display: flex;
		gap: 8px;
		margin-inline-start: auto;
	}

	@media (max-width: 640px) {
		.data {
			min-width: 560px;
		}
	}
</style>
