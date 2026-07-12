<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		children: Snippet;
		compact?: boolean;
		width?: 'default' | 'wide' | 'xwide';
	}

	let { children, compact = false, width = 'default' }: Props = $props();
</script>

<div
	class="admin-data-table-wrap"
	class:admin-data-table-wrap--compact={compact}
	class:admin-data-table-wrap--wide={width === 'wide'}
	class:admin-data-table-wrap--xwide={width === 'xwide'}
>
	<table class="admin-data-table">
		{@render children()}
	</table>
</div>

<style>
	.admin-data-table-wrap {
		--admin-data-table-min-width: 760px;
		width: 100%;
		overflow-x: auto;
		border: var(--table-wrap-border, 1px solid var(--table-border, var(--color-border)));
		border-radius: var(--table-radius, var(--radius-panel, var(--radius-md)));
		background: var(--table-bg, var(--color-surface));
		box-shadow: var(--table-shadow, var(--shadow-sm));
	}

	.admin-data-table-wrap--wide {
		--admin-data-table-min-width: 900px;
	}

	.admin-data-table-wrap--xwide {
		--admin-data-table-min-width: 1040px;
	}

	.admin-data-table {
		width: 100%;
		min-width: var(--admin-data-table-min-width);
		border-collapse: collapse;
		color: var(--color-text);
		font-size: var(--table-font-size, 0.84rem);
	}

	.admin-data-table :global(th) {
		padding: var(--table-header-padding, 10px 12px);
		border-bottom: var(
			--table-header-border-bottom,
			1px solid var(--table-border, var(--color-border))
		);
		color: var(--table-header-color, var(--color-text-subtle));
		font-family: var(--font-meta, var(--font-body));
		font-size: var(--table-header-size, 0.68rem);
		font-weight: 700;
		letter-spacing: var(--table-header-letter-spacing, 0.08em);
		text-align: left;
		text-transform: uppercase;
		white-space: nowrap;
		background: var(--table-header-bg, var(--color-surface-raised));
	}

	.admin-data-table :global(td) {
		padding: var(--table-cell-padding, 12px);
		border-bottom: var(
			--table-row-border-bottom,
			1px solid var(--table-row-border, var(--color-border-muted))
		);
		vertical-align: middle;
	}

	.admin-data-table :global(tbody tr:last-child td) {
		border-bottom: 0;
	}

	.admin-data-table :global(tbody tr[data-clickable='true']) {
		cursor: pointer;
	}

	.admin-data-table :global(tbody tr[data-clickable='true']:hover) {
		background: var(--table-row-hover-bg, color-mix(in srgb, var(--color-accent) 7%, transparent));
	}

	.admin-data-table :global(tbody tr.selected) {
		background: var(
			--table-row-selected-bg,
			var(--table-row-hover-bg, color-mix(in srgb, var(--color-accent) 7%, transparent))
		);
	}

	.admin-data-table :global(tbody tr[data-clickable='true']:focus-visible) {
		outline: 2px solid var(--color-focus, var(--color-accent));
		outline-offset: -2px;
	}

	.admin-data-table :global(.text-right) {
		text-align: right;
	}

	.admin-data-table :global(.admin-data-table__truncate) {
		max-width: var(--truncate-max-width, 280px);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.admin-data-table-wrap--compact .admin-data-table :global(td) {
		padding-block: var(--table-compact-cell-padding-y, 9px);
	}
</style>
