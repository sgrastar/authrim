<script lang="ts">
	import type { Placement } from '#lib/api/account-pages.js';
	import type { Screen } from '#lib/api/screens.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import EmptyState from '#lib/ui/patterns/EmptyState.svelte';
	import { fieldsToBuilder } from '../screens/screen-layout';
	import ScreenPreview from '../screens/ScreenPreview.svelte';
	import { placementRows, screenOf } from './account-page-model';

	/**
	 * A rough picture of the account page: its heading and description, then the places in the
	 * rows the page draws (the Login UI draws the real page). A place that is switched off or
	 * never shown is left out; one with a condition is drawn as if the condition were met.
	 */
	interface Props {
		placements: readonly Placement[];
		screens: readonly Screen[];
		title: string;
		description: string;
	}

	let { placements, screens, title, description }: Props = $props();

	const shown = $derived(placements.filter((item) => item.enabled && item.condition !== 'hidden'));
	const rows = $derived(placementRows(shown));

	function pictureOf(placement: Placement) {
		const screen = screenOf(placement, screens);
		if (!screen) return null;
		let next = 0;
		return { screen, built: fieldsToBuilder(screen.fields, (prefix) => `${prefix}-${next++}`) };
	}
</script>

<Callout>{t('ap.preview.note')}</Callout>
<div class="page">
	<h2>{title || t('ap.preview.title')}</h2>
	{#if description}<p class="description">{description}</p>{/if}
	{#if shown.length === 0}
		<EmptyState icon="list" title={t('ap.preview.empty')} />
	{:else}
		{#each rows as row (row[0].id)}
			<div class="row" style:--cols={row.length}>
				{#each row as placement (placement.id)}
					{@const picture = pictureOf(placement)}
					<section class="panel" class:panel--half={placement.width === 'half' && row.length === 1}>
						{#if picture}
							<ScreenPreview
								rows={picture.built.rows}
								settings={picture.built.settings}
								rowSettings={picture.built.rowSettings}
							/>
						{:else}
							<p class="missing">{t('ap.place.missing')}: {placement.screen_key}</p>
						{/if}
					</section>
				{/each}
			</div>
		{/each}
	{/if}
</div>

<style>
	.page {
		display: grid;
		gap: 12px;
		margin-block-start: 12px;
		padding: 16px;
		border: 1px solid var(--border);
		border-radius: var(--radius-panel);
		background: var(--bg-subtle);
	}

	h2 {
		margin: 0;
		color: var(--text-primary);
		font-size: var(--fs-heading);
	}

	.description {
		margin: 0;
		color: var(--text-secondary);
		font-size: var(--fs-body);
	}

	.row {
		display: grid;
		grid-template-columns: repeat(var(--cols), minmax(0, 1fr));
		gap: 12px;
	}

	.panel {
		min-inline-size: 0;
		padding: 12px;
		border: 1px solid var(--border);
		border-radius: var(--radius-panel);
		background: var(--bg-card);
	}

	.panel--half {
		inline-size: calc(50% - 6px);
	}

	.missing {
		margin: 0;
		color: var(--text-muted);
		font-size: var(--fs-small);
	}
</style>
