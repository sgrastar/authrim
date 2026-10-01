<script lang="ts" module>
	import type { IconName } from '../icons/icons';

	export interface PaletteEntry {
		kind: string;
		label: string;
		/** What the part is for; shown from the "?" next to its name. */
		description?: string;
		icon?: IconName;
		/** Id of the PaletteGroup it is listed under. */
		group?: string;
	}

	export interface PaletteGroup {
		id: string;
		label: string;
	}

	/** Drag data for a new part coming from the palette (LayoutCanvas reads it). */
	export const NEW_PART_TYPE = 'application/x-authrim-new-part';
</script>

<script lang="ts">
	import { t } from '$lib/i18n/i18n.svelte';
	import { useBusy } from '../busy/busy';
	import Icon from '../icons/Icon.svelte';
	import InfoTip from '../primitives/InfoTip.svelte';

	/**
	 * The parts that can be added to a page, by name (grouped when there are many). What a part
	 * is for shows from its "?" and is read out with the part. Drag one onto the canvas, or
	 * click it (Enter, Space) to add it after the selected part — dragging is never the only way.
	 */
	interface Props {
		label?: string;
		entries: readonly PaletteEntry[];
		groups?: readonly PaletteGroup[];
		onadd: (kind: string) => void;
	}

	let { label = t('builder.parts'), entries, groups, onadd }: Props = $props();

	const uid = $props.id();
	const busy = useBusy();

	const sections = $derived(
		groups?.length
			? groups
					.map((group) => ({
						group,
						entries: entries.filter((entry) => entry.group === group.id)
					}))
					.filter((section) => section.entries.length > 0)
			: [{ group: null, entries }]
	);
</script>

{#snippet entryItem(entry: PaletteEntry)}
	{@const tipId = `${uid}-${entry.kind}-tip`}
	<li class="palette__item">
		<button
			type="button"
			class="palette__part"
			draggable={!busy()}
			disabled={busy()}
			aria-label={t('builder.add', { name: entry.label })}
			aria-describedby={entry.description ? tipId : undefined}
			ondragstart={(event) => {
				event.dataTransfer?.setData(NEW_PART_TYPE, entry.kind);
				event.dataTransfer?.setData('text/plain', entry.label);
				if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copy';
			}}
			onclick={() => onadd(entry.kind)}
		>
			{#if entry.icon}<span class="palette__icon"><Icon name={entry.icon} /></span>{/if}
			<span class="palette__name">{entry.label}</span>
			<span class="palette__add" aria-hidden="true"><Icon name="plus" /></span>
		</button>
		{#if entry.description}
			<InfoTip
				id={tipId}
				label={t('builder.about', { name: entry.label })}
				text={entry.description}
			/>
		{/if}
	</li>
{/snippet}

<div class="palette" role="group" aria-label={label}>
	{#each sections as section (section.group?.id ?? 'all')}
		{#if section.group}<p class="palette__group" aria-hidden="true">{section.group.label}</p>{/if}
		<ul aria-label={section.group?.label ?? label}>
			{#each section.entries as entry (entry.kind)}{@render entryItem(entry)}{/each}
		</ul>
	{/each}
</div>

<style>
	.palette {
		display: grid;
		gap: 6px;
	}

	.palette__group {
		margin: 8px 2px 0;
		color: var(--text-muted);
		font-size: var(--fs-small);
		font-weight: var(--fw-semibold);
		letter-spacing: 0.03em;
	}

	.palette__group:first-child {
		margin-top: 0;
	}

	ul {
		display: grid;
		gap: 4px;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.palette__item {
		display: flex;
		align-items: center;
		gap: 2px;
		padding-inline-end: 4px;
		border: 1px solid var(--border);
		border-radius: var(--radius-control);
		background: var(--bg-card);
	}

	.palette__item:hover {
		border-color: var(--border-strong);
	}

	.palette__part {
		display: flex;
		flex: 1;
		align-items: center;
		gap: 9px;
		min-width: 0;
		padding: 8px 6px 8px 10px;
		border: 0;
		border-radius: var(--radius-control);
		background: none;
		color: var(--text-primary);
		text-align: start;
		cursor: grab;
	}

	.palette__part:active:not(:disabled) {
		cursor: grabbing;
	}

	.palette__icon {
		flex-shrink: 0;
		color: var(--text-secondary);
		--icon-size: var(--icon-md);
	}

	.palette__name {
		flex: 1;
		min-width: 0;
		font-size: var(--fs-body);
		font-weight: var(--fw-name);
		overflow-wrap: anywhere;
	}

	/* The "+" tells that a click adds it, too. */
	.palette__add {
		flex-shrink: 0;
		color: var(--text-muted);
		opacity: 0;
		transition: opacity 120ms;
		--icon-size: var(--icon-sm);
	}

	.palette__item:hover .palette__add,
	.palette__part:focus-visible .palette__add {
		opacity: 1;
	}
</style>
