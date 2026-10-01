<script lang="ts">
	import type { Snippet } from 'svelte';

	/**
	 * Read-only facts as label/value pairs (account details, a record's properties).
	 *
	 * - default: one fact per row, labels in one column so the values line up.
	 * - `columns` 2 or 3: facts side by side, each label above its value; fewer columns when
	 *   the block gets narrow (same rule as Columns).
	 * - `size="sm"`: inside a small card; each label above its value, one column.
	 * - `ruled`: a quiet table — rows divided by a line, no vertical lines, the value stronger
	 *   than its label (settings someone may only look at). Stacks on narrow screens.
	 */
	interface Props {
		size?: 'md' | 'sm';
		columns?: 1 | 2 | 3;
		/** Narrowest a column may get before one goes (with `columns`). */
		minWidth?: string;
		/** Rows divided by a line, values emphasised (one fact per row). */
		ruled?: boolean;
		children: Snippet;
	}

	let { size = 'md', columns = 1, minWidth = '200px', ruled = false, children }: Props = $props();
</script>

<dl
	class="details"
	class:details--sm={size === 'sm'}
	class:details--cols={columns > 1}
	class:details--ruled={ruled}
	style:--cols={columns}
	style:--col-min={minWidth}
>
	{@render children()}
</dl>

<style>
	/* Default: labels | values on a shared grid, so every value starts at the same line. */
	.details {
		display: grid;
		grid-template-columns: minmax(120px, max-content) minmax(0, 1fr);
		gap: 12px var(--space-columns);
		margin: 0;
		font-size: var(--fs-body);
	}

	.details > :global(.detail) {
		display: grid;
		grid-column: 1 / -1;
		grid-template-columns: subgrid;
	}

	/* Ruled: a table without vertical lines. The name column takes two fifths, so values
	   line up in one column however long the names are. */
	.details--ruled {
		grid-template-columns: var(--row-name-col, minmax(0, 2fr)) minmax(0, 3fr);
		gap: 0 var(--space-columns);
	}

	.details--ruled > :global(.detail) {
		align-items: baseline;
		padding-block: 10px;
	}

	.details--ruled > :global(.detail:first-child) {
		padding-top: 0;
	}

	.details--ruled > :global(.detail + .detail) {
		border-top: 1px solid var(--border-subtle);
	}

	.details--ruled > :global(.detail dt) {
		color: var(--text-secondary);
	}

	.details--ruled > :global(.detail dd) {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 4px 8px;
		color: var(--text-primary);
		font-weight: var(--fw-semibold);
	}

	/* Columns: facts side by side, each a small stack. */
	.details--cols {
		--gap-x: var(--space-columns);
		grid-template-columns: repeat(
			auto-fill,
			minmax(
				max(var(--col-min), calc((100% - (var(--cols) - 1) * var(--gap-x)) / var(--cols))),
				1fr
			)
		);
		gap: var(--space-field) var(--gap-x);
	}

	.details--cols > :global(.detail),
	.details--sm > :global(.detail) {
		grid-column: auto;
		grid-template-columns: minmax(0, 1fr);
		gap: 2px;
	}

	.details--cols > :global(.detail dt) {
		font-size: var(--fs-caption);
	}

	/* Small cards: one column, label above value. */
	.details--sm {
		grid-template-columns: minmax(0, 1fr);
		gap: 8px;
		font-size: var(--fs-label);
	}

	.details--sm > :global(.detail dt) {
		font-size: var(--fs-small);
	}

	@media (max-width: 640px) {
		.details:not(.details--sm, .details--cols) {
			grid-template-columns: minmax(0, 1fr);
			gap: 10px;
		}

		.details:not(.details--sm, .details--cols) > :global(.detail) {
			grid-template-columns: minmax(0, 1fr);
			gap: 2px;
		}

		.details.details--ruled {
			gap: 0;
		}
	}
</style>
