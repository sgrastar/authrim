<script lang="ts">
	/**
	 * One placement of a published account page composition: a half- or full-width cell of the
	 * account grid holding the screen's blocks in order. A full-width placement is itself two
	 * columns, and a block can ask for column 1 or 2; on narrow screens everything is one column.
	 * The account overview is drawn as a card of its own.
	 */
	import type { Snippet } from 'svelte';
	import type { AccountPageScreenField } from '$lib/api/account';

	let {
		id,
		full = false,
		overview = false,
		fields,
		block
	}: {
		/** The placement id, which `#id` links on the page jump to. */
		id: string;
		/** Spans both columns of the account grid. */
		full?: boolean;
		overview?: boolean;
		/** The screen's blocks in display order; `layout_row` markers draw nothing. */
		fields: AccountPageScreenField[];
		block: Snippet<[AccountPageScreenField]>;
	} = $props();

	function column(field: AccountPageScreenField): string | undefined {
		return full && (field.layout_column === 1 || field.layout_column === 2)
			? String(field.layout_column)
			: undefined;
	}
</script>

<section {id} class="account-screen" class:full class:overview>
	{#each fields as field, fieldIndex (`${field.block_id ?? field.field}-${fieldIndex}`)}
		{#if field.block_type !== 'layout_row'}
			<div class="account-screen__block" style:--account-block-column={column(field)}>
				{@render block(field)}
			</div>
		{/if}
	{/each}
</section>

<style>
	.account-screen {
		display: grid;
		min-width: 0;
		gap: 12px;
	}

	.account-screen.full {
		grid-column: 1 / -1;
		grid-template-columns: repeat(2, minmax(0, 1fr));
	}

	.account-screen.overview {
		border: 1px solid var(--border-glass);
		border-radius: var(--card-radius, var(--radius-xl));
		background: var(--card-surface, var(--bg-card));
		box-shadow: none;
		padding: var(--auth-card-padding, var(--card-padding, 24px));
	}

	.account-screen__block {
		min-width: 0;
		grid-column: var(--account-block-column, 1 / -1);
	}

	@media (max-width: 760px) {
		.account-screen.full {
			grid-column: auto;
			grid-template-columns: 1fr;
		}

		.account-screen__block {
			grid-column: 1;
		}
	}
</style>
