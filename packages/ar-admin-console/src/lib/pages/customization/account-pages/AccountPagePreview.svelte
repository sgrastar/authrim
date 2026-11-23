<script lang="ts">
	import type { LauncherChoice, Placement } from '#lib/api/account-pages.js';
	import type { Screen } from '#lib/api/screens.js';
	import { t, type MessageKey } from '#lib/i18n/i18n.svelte.js';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import EmptyState from '#lib/ui/patterns/EmptyState.svelte';
	import AccountWidgetSample from './AccountWidgetSample.svelte';
	import { previewBlocks, screenOf } from './account-page-model';

	/**
	 * A picture of the account page as the Login UI draws it: the header (brand, heading,
	 * description, sign out), then each place as a card in a two-column grid, a full place across
	 * both. A card holds the screen's own heading and text, and each widget with sample content
	 * (the Login UI draws the user's own). A place that is switched off or never shown is left
	 * out; one with a condition is drawn as if the condition were met.
	 */
	interface Props {
		placements: readonly Placement[];
		screens: readonly Screen[];
		title: string;
		description: string;
		/** The tenant's launchers, for a launcher slot's tiles (sample tiles when not known). */
		launchers?: readonly LauncherChoice[] | null;
	}

	let { placements, screens, title, description, launchers = null }: Props = $props();

	const shown = $derived(placements.filter((item) => item.enabled && item.condition !== 'hidden'));

	function contentOf(placement: Placement) {
		const screen = screenOf(placement, screens);
		return screen ? { blocks: previewBlocks(placement, screen) } : null;
	}

	/** The names a launcher slot shows: the chosen launchers, or every one that is switched on. */
	function launcherNames(placement: Placement): string[] | undefined {
		if (!launchers) return undefined;
		const chosen = placement.launcher_ids;
		return launchers
			.filter((launcher) => launcher.enabled && (!chosen || chosen.includes(launcher.id)))
			.map((launcher) => launcher.name);
	}

	/** A widget draws its own heading (its label, else the name of the widget). */
	const widgetTitle = (kind: string, label: string) => label || t(`sc.part.${kind}` as MessageKey);
</script>

<Callout>{t('ap.preview.note')}</Callout>
<div class="account">
	<div class="account__header">
		<div>
			<p class="brand">Authrim</p>
			<h2>{title || t('ap.preview.title')}</h2>
			{#if description}<p class="description">{description}</p>{/if}
		</div>
		<span class="signout">{t('ap.sample.signOut')}</span>
	</div>
	{#if shown.length === 0}
		<EmptyState icon="list" title={t('ap.preview.empty')} />
	{:else}
		<div class="grid">
			{#each shown as placement (placement.id)}
				{@const content = contentOf(placement)}
				<section class="card" class:card--full={placement.width === 'full'}>
					{#if !content}
						<p class="missing">{t('ap.place.missing')}: {placement.screen_key}</p>
					{:else}
						<div class="blocks" class:blocks--full={placement.width === 'full'}>
							{#each content.blocks as block (block.key)}
								<div class="block" style:--column={block.column ?? undefined}>
									{#if block.kind === 'heading'}
										<h3>{block.label}</h3>
										{#if block.text}<p class="text">{block.text}</p>{/if}
									{:else if block.kind === 'text'}
										<p class="text">{block.text || block.label}</p>
									{:else if block.kind === 'link'}
										<p class="link">{block.label}</p>
									{:else if block.kind === 'divider'}
										<hr />
									{:else}
										<h3>{widgetTitle(block.kind, block.label)}</h3>
										<AccountWidgetSample
											kind={block.kind}
											launcherNames={launcherNames(placement)}
										/>
									{/if}
								</div>
							{/each}
						</div>
					{/if}
				</section>
			{/each}
		</div>
	{/if}
</div>

<style>
	.account {
		display: grid;
		gap: 16px;
		margin-block-start: 12px;
		padding: 20px;
		border: 1px solid var(--border);
		border-radius: var(--radius-panel);
		background: var(--bg-subtle);
	}

	.account__header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 12px;
	}

	.brand {
		margin: 0 0 4px;
		color: var(--text-muted);
		font-size: var(--fs-caption);
		font-weight: var(--fw-semibold);
	}

	h2 {
		margin: 0;
		color: var(--text-primary);
		font-size: var(--fs-heading);
	}

	.description {
		margin: 4px 0 0;
		color: var(--text-secondary);
		font-size: var(--fs-body);
	}

	.signout {
		padding: 4px 12px;
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-control);
		background: var(--bg-card);
		color: var(--text-primary);
		font-size: var(--fs-small);
		white-space: nowrap;
	}

	.grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 16px;
		align-items: start;
	}

	.card {
		min-inline-size: 0;
		padding: 16px;
		border: 1px solid var(--border);
		border-radius: var(--radius-panel);
		background: var(--bg-card);
		font-size: var(--fs-body);
	}

	.blocks {
		display: grid;
		gap: 12px;
	}

	.blocks--full {
		grid-template-columns: repeat(2, minmax(0, 1fr));
	}

	.block {
		min-inline-size: 0;
		grid-column: var(--column, 1 / -1);
	}

	.card--full {
		grid-column: 1 / -1;
	}

	h3 {
		margin: 0 0 8px;
		color: var(--text-primary);
		font-size: var(--fs-body);
		font-weight: var(--fw-semibold);
	}

	.text,
	.link {
		margin: 0 0 8px;
		color: var(--text-secondary);
	}

	.link {
		color: var(--primary);
	}

	hr {
		margin: 8px 0;
		border: 0;
		border-block-start: 1px solid var(--border);
	}

	.missing {
		margin: 0;
		color: var(--text-muted);
		font-size: var(--fs-small);
	}
</style>
