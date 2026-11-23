<script lang="ts">
	import type { Placement } from '#lib/api/account-pages.js';
	import type { Screen } from '#lib/api/screens.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import Card from '#lib/ui/patterns/Card.svelte';
	import EmptyState from '#lib/ui/patterns/EmptyState.svelte';
	import Badge from '#lib/ui/primitives/Badge.svelte';
	import IconButton from '#lib/ui/primitives/IconButton.svelte';
	import { placementRows, screenOf } from './account-page-model';

	/**
	 * The page as it is laid out: each place is a card, a full place across the page and two half
	 * places side by side. A card is selected to be set at the side, and moved up or down with its
	 * buttons (no dragging, so it works from the keyboard too).
	 */
	interface Props {
		placements: readonly Placement[];
		screens: readonly Screen[];
		selected: string | null;
		disabled?: boolean;
		/** Places that are new or changed since saving. */
		changed?: (placement: Placement) => boolean;
		onselect: (id: string) => void;
		onmove: (id: string, step: -1 | 1) => void;
	}

	let {
		placements,
		screens,
		selected,
		disabled = false,
		changed,
		onselect,
		onmove
	}: Props = $props();

	const rows = $derived(placementRows(placements));
	const nameOf = (placement: Placement) =>
		screenOf(placement, screens)?.display_name ?? placement.screen_key;
</script>

<Card title={t('ap.page.title')}>
	{#if placements.length === 0}
		<EmptyState icon="list" title={t('ap.page.empty')} />
	{:else}
		<ol class="canvas">
			{#each rows as row (row[0].id)}
				<li class="row" style:--cols={row.length}>
					{#each row as placement (placement.id)}
						{@const name = nameOf(placement)}
						{@const index = placements.findIndex((item) => item.id === placement.id)}
						<div
							class="place"
							class:place--half={placement.width === 'half' && row.length === 1}
							class:place--selected={selected === placement.id}
							class:place--off={!placement.enabled}
							class:place--changed={changed?.(placement)}
						>
							<button
								type="button"
								class="place__main"
								aria-pressed={selected === placement.id}
								aria-label={t('ap.place.select', { name })}
								onclick={() => onselect(placement.id)}
							>
								<span class="place__name">{name}</span>
								<span class="place__marks">
									<Badge size="sm">
										{placement.width === 'half' ? t('ap.place.half') : t('ap.place.full')}
									</Badge>
									{#if !placement.enabled}
										<Badge size="sm" tone="warning">{t('ap.place.hidden')}</Badge>
									{:else if placement.condition !== 'always'}
										<Badge size="sm" tone="info">{t('ap.place.conditional')}</Badge>
									{/if}
									{#if !screenOf(placement, screens)}
										<Badge size="sm" tone="danger">{t('ap.place.missing')}</Badge>
									{/if}
								</span>
							</button>
							{#if !disabled}
								<span class="place__move">
									<IconButton
										icon="arrowUp"
										size="sm"
										label={t('ap.place.up', { name })}
										disabled={index === 0}
										onclick={() => onmove(placement.id, -1)}
									/>
									<IconButton
										icon="arrowDown"
										size="sm"
										label={t('ap.place.down', { name })}
										disabled={index === placements.length - 1}
										onclick={() => onmove(placement.id, 1)}
									/>
								</span>
							{/if}
						</div>
					{/each}
				</li>
			{/each}
		</ol>
	{/if}
</Card>

<style>
	.canvas {
		display: grid;
		gap: 8px;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.row {
		display: grid;
		grid-template-columns: repeat(var(--cols), minmax(0, 1fr));
		gap: 8px;
	}

	.place {
		display: flex;
		align-items: center;
		gap: 4px;
		min-inline-size: 0;
		padding: 4px 4px 4px 0;
		border: 1px solid var(--border);
		border-radius: var(--radius-control);
		background: var(--bg-card);
	}

	/* A half place with no half place beside it takes half of the row, as the page draws it. */
	.place--half {
		inline-size: calc(50% - 4px);
	}

	.place--selected {
		border-color: var(--primary);
		background: var(--bg-hover);
	}

	.place--off {
		opacity: 0.7;
	}

	.place--changed {
		background: var(--changed-bg);
	}

	.place__main {
		display: grid;
		flex: 1;
		gap: 4px;
		min-inline-size: 0;
		padding: 8px 12px;
		border: 0;
		background: transparent;
		color: var(--text-primary);
		font: inherit;
		text-align: start;
		cursor: pointer;
	}

	.place__name {
		overflow: hidden;
		font-size: var(--fs-body);
		font-weight: var(--fw-semibold);
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.place__marks {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
	}

	.place__move {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
</style>
