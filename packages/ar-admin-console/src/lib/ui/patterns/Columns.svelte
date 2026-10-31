<script lang="ts">
	import type { Snippet } from 'svelte';

	/**
	 * Lays fields, facts or cards out in up to 2 or 3 columns. The number of columns follows the
	 * room the block actually has (not the screen), so it also works inside a card or next to
	 * the left nav: when a column would get narrower than `minWidth`, one column goes.
	 * Children are placed in reading order; wrap one in ColumnSpan to give it the whole row.
	 */
	interface Props {
		columns?: 2 | 3;
		/** Narrowest a column may get before the layout drops a column. */
		minWidth?: string;
		/** `stretch` makes cards in a row equally tall; fields stay top-aligned by default. */
		align?: 'start' | 'stretch';
		children: Snippet;
	}

	let { columns = 2, minWidth = '240px', align = 'start', children }: Props = $props();
</script>

<div
	class="columns"
	class:columns--stretch={align === 'stretch'}
	style:--cols={columns}
	style:--col-min={minWidth}
>
	{@render children()}
</div>

<style>
	.columns {
		--gap-x: var(--space-columns);
		display: grid;
		/* At most --cols columns; fewer when a column would drop below --col-min. */
		grid-template-columns: repeat(
			auto-fill,
			minmax(
				max(var(--col-min), calc((100% - (var(--cols) - 1) * var(--gap-x)) / var(--cols))),
				1fr
			)
		);
		gap: var(--space-field) var(--gap-x);
		align-items: start;
	}

	.columns--stretch {
		align-items: stretch;
	}

	.columns > :global(*) {
		min-width: 0;
	}
</style>
