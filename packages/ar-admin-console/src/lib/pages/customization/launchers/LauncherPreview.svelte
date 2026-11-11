<script lang="ts">
	import type { ComponentProps } from 'svelte';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import { GRID_COLUMNS } from './launcher-model';
	import LauncherTile from './LauncherTile.svelte';

	/**
	 * Where a launcher's tile sits on the account page: its row of eight columns drawn as empty
	 * cells, the tile spanning as many of them as it is wide. What the tile looks like follows
	 * every change before it is saved.
	 */
	type Props = ComponentProps<typeof LauncherTile> & {
		/** Columns of the eight the tile takes. */
		width: number;
	};

	let { width, ...tile }: Props = $props();

	const span = $derived(Math.min(GRID_COLUMNS, Math.max(1, Math.round(width))));
</script>

<figure class="launcher-preview">
	<div class="launcher-preview__grid" style:--launcher-span={span}>
		{#each { length: GRID_COLUMNS } as _, index (index)}
			<span class="launcher-preview__cell" style:grid-column={String(index + 1)} aria-hidden="true"
			></span>
		{/each}
		<div class="launcher-preview__tile">
			<LauncherTile {...tile} />
		</div>
	</div>
	<figcaption>{t('ln.preview.caption', { n: span, total: GRID_COLUMNS })}</figcaption>
</figure>

<style>
	.launcher-preview {
		display: grid;
		gap: var(--space-related);
		margin: 0;
	}

	.launcher-preview__grid {
		display: grid;
		grid-template-columns: repeat(8, minmax(0, 1fr));
		gap: var(--space-grid);
		padding: var(--space-grid);
		border-radius: var(--radius-panel);
		background: var(--bg-subtle);
	}

	.launcher-preview__cell {
		grid-row: 1;
		min-block-size: 132px;
		border: 1px dashed var(--border);
		border-radius: var(--radius-panel);
	}

	.launcher-preview__tile {
		grid-row: 1;
		grid-column: 1 / span var(--launcher-span);
		min-inline-size: 0;
	}

	figcaption {
		color: var(--text-muted);
		font-size: var(--fs-caption);
	}

	@media (max-width: 640px) {
		.launcher-preview__grid {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}

		.launcher-preview__cell:nth-child(n + 3) {
			display: none;
		}

		.launcher-preview__tile {
			grid-column: 1 / -1;
		}
	}
</style>
