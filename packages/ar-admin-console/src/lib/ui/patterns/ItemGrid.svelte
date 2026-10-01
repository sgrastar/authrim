<script lang="ts">
	import { setContext, type Snippet } from 'svelte';
	import { ITEM_GRID } from './item-grid';

	/**
	 * Lays ItemCards out in as many columns as fit (one on phones). It is a list, so screen
	 * readers announce how many items there are; the cards inside render as its items.
	 */
	interface Props {
		/** Accessible name of the list, usually the section title. */
		label: string;
		/** Narrowest a card may get before the grid drops a column. */
		minWidth?: string;
		/** At most this many columns (fewer when narrow). Without it, as many as fit. */
		columns?: 2 | 3;
		children: Snippet;
	}

	let { label, minWidth = '280px', columns, children }: Props = $props();

	setContext(ITEM_GRID, true);
</script>

<ul
	class="item-grid"
	class:item-grid--capped={columns !== undefined}
	aria-label={label}
	style:--item-min={minWidth}
	style:--cols={columns}
>
	{@render children()}
</ul>

<style>
	.item-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(min(100%, var(--item-min)), 1fr));
		--gap: var(--space-grid);
		gap: var(--gap);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	/* Same rule as Columns: at most --cols columns, fewer when a card would get too narrow. */
	.item-grid--capped {
		grid-template-columns: repeat(
			auto-fill,
			minmax(
				max(
					min(100%, var(--item-min)),
					calc((100% - (var(--cols) - 1) * var(--gap)) / var(--cols))
				),
				1fr
			)
		);
	}

	.item-grid > :global(*) {
		min-width: 0;
	}
</style>
