<script lang="ts">
	import type { Snippet } from 'svelte';
	import { t } from '$lib/i18n/i18n.svelte';
	import InfoTip from '../primitives/InfoTip.svelte';

	/**
	 * One field of a settings form laid out as a table row: its name on the start side (what it
	 * does behind a "?"), the control on the end side, rows divided by a line. The same columns as a
	 * ruled DetailList, so a page reads the same whether the admin may change it or only look.
	 *
	 * The name shown here is for the eye; give the control the same label with `hideLabel` so
	 * assistive tech still reads it with the control. Narrow screens stack name over control.
	 */
	interface Props {
		label: string;
		/** What the setting does, behind a "?" next to its name. */
		info?: string;
		/** Marks after the name: where the value comes from ("Set for this tenant"). */
		badges?: Snippet;
		/**
		 * What the control side starts with, so the name lines up with it: a field's box
		 * (`field`, default) or a line of text or a checkbox (`text`).
		 */
		align?: 'field' | 'text';
		/** The control, with its own label hidden (`hideLabel`). */
		children: Snippet;
	}

	let { label, info, badges, align = 'field', children }: Props = $props();
</script>

<div class="field-row" class:field-row--text={align === 'text'}>
	<div class="field-row__name">
		<span class="field-row__label" aria-hidden="true">{label}</span>
		{#if info}<InfoTip label={t('common.moreInfo')} text={info} />{/if}
		{#if badges}<span class="field-row__badges">{@render badges()}</span>{/if}
	</div>
	<div class="field-row__control">{@render children()}</div>
</div>

<style>
	/* `--row-name-col`: set by a page whose rows must line up across nested boxes. */
	.field-row {
		display: grid;
		grid-template-columns: var(--row-name-col, minmax(0, 2fr)) minmax(0, 3fr);
		gap: 8px var(--space-columns);
		padding-block: 14px;
	}

	.field-row:first-child {
		padding-top: 0;
	}

	.field-row:not(:first-child) {
		border-top: 1px solid var(--border-subtle);
	}

	/* The name's first line sits level with the text in the control beside it. */
	.field-row__name {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-start;
		gap: 4px 6px;
		min-width: 0;
		padding-top: 6px;
		font-size: var(--fs-body);
		line-height: var(--lh-snug);
	}

	.field-row--text .field-row__name {
		padding-top: 0;
	}

	/* The "?" is taller than a line of text: centre it on the name's first line. */
	.field-row__name > :global(.info-tip) {
		margin-block: calc((1lh - var(--control-h-xs)) / 2);
	}

	.field-row__badges {
		display: inline-flex;
		gap: 6px;
	}

	.field-row__label {
		color: var(--text-primary);
		font-size: var(--fs-body);
		font-weight: var(--fw-semibold);
	}

	.field-row__control {
		min-width: 0;
	}

	@media (max-width: 640px) {
		.field-row {
			grid-template-columns: minmax(0, 1fr);
		}
	}
</style>
