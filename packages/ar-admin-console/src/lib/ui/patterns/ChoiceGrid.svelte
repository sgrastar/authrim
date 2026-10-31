<script lang="ts" module>
	export interface GridChoice {
		value: string;
		label: string;
		/** Second line in a quieter tone (a native name, a code). */
		detail?: string;
		/** BCP 47 tag when the label is in another language, so it is read out correctly. */
		lang?: string;
		/** Same for the detail line (a language's own name is in that language). */
		detailLang?: string;
		/** Must stay chosen (e.g. the default language); shown checked and not changeable. */
		locked?: boolean;
		/** Why it is locked, shown after the label ("Default language"). */
		note?: string;
	}
</script>

<script lang="ts">
	import { t } from '$lib/i18n/i18n.svelte';
	import Button from '../primitives/Button.svelte';
	import Checkbox from '../primitives/Checkbox.svelte';
	import { useChangeMark } from '../save/save-scope';

	/**
	 * Many short choices of the same kind (languages, scopes, countries) in a ruled grid that
	 * fills as many columns as fit. One checkbox per cell — a cell never holds two controls with
	 * different meanings; ask a second question in a second grid instead.
	 *
	 * The head row counts what is chosen and offers select all / clear. With `max`, choices
	 * beyond the limit are unavailable until one is cleared.
	 */
	interface Props {
		/** Accessible name of the set (the section title). */
		label: string;
		options: readonly GridChoice[];
		selected?: string[];
		/** Most that may be chosen. */
		max?: number;
		/** Narrowest a cell may get before the grid drops a column. */
		minWidth?: string;
		/** Select all / clear buttons (not offered with `max`). */
		bulk?: boolean;
		/** Path in the SaveScope draft; each cell that differs from the saved set is marked. */
		field?: string;
	}

	let {
		label,
		options,
		selected = $bindable([]),
		max,
		minWidth = '200px',
		bulk = true,
		field
	}: Props = $props();

	const changeMark = useChangeMark();
	const savedSet = $derived(changeMark.original(field));
	const cellChanged = (value: string) =>
		Array.isArray(savedSet) && savedSet.includes(value) !== selected.includes(value);

	const values = $derived(options.map((option) => option.value));
	const chosen = $derived(values.filter((value) => selected.includes(value)).length);
	const full = $derived(max !== undefined && chosen >= max);

	function set(value: string, on: boolean) {
		selected = on ? [...selected, value] : selected.filter((other) => other !== value);
	}

	function setAll(on: boolean) {
		const locked = options.filter((option) => option.locked).map((option) => option.value);
		const others = selected.filter((value) => !values.includes(value));
		selected = on ? [...others, ...values] : [...others, ...locked];
	}
</script>

<fieldset class="grid-choice">
	<legend class="sr-only">{label}</legend>
	<div class="grid-choice__head">
		<span class="grid-choice__count" class:is-full={full} aria-live="polite">
			{max === undefined
				? t('choice.count', { n: chosen, total: options.length })
				: t('choice.countMax', { n: chosen, max })}
		</span>
		{#if bulk && max === undefined}
			<span class="grid-choice__bulk">
				<Button
					size="sm"
					variant="ghost"
					disabled={chosen === options.length}
					onclick={() => setAll(true)}>{t('table.selectAll')}</Button
				>
				<Button size="sm" variant="ghost" disabled={chosen === 0} onclick={() => setAll(false)}
					>{t('table.clearSelection')}</Button
				>
			</span>
		{/if}
	</div>
	<div class="grid-choice__cells" style:--cell-min={minWidth}>
		{#each options as option (option.value)}
			{@const on = selected.includes(option.value)}
			<div
				class="grid-choice__cell"
				class:is-on={on || option.locked}
				class:is-changed={!option.locked && cellChanged(option.value)}
				class:is-locked={option.locked}
			>
				<Checkbox
					checked={on || !!option.locked}
					disabled={option.locked || (full && !on)}
					value={option.value}
					changed={!option.locked && cellChanged(option.value)}
					changeMark="box"
					onchange={(event) => set(option.value, event.currentTarget.checked)}
				>
					<span lang={option.lang}>{option.label}</span>
					{#if option.note}<span class="grid-choice__note">{option.note}</span>{/if}
					{#if option.detail}<span class="grid-choice__detail" lang={option.detailLang}
							>{option.detail}</span
						>{/if}
				</Checkbox>
			</div>
		{/each}
	</div>
</fieldset>

<style>
	.grid-choice {
		display: grid;
		gap: 10px;
		min-width: 0;
		margin: 0;
		padding: 0;
		border: 0;
	}

	.grid-choice__head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 6px 12px;
		min-height: 28px;
	}

	.grid-choice__count {
		color: var(--text-secondary);
		font-size: var(--fs-label);
		font-variant-numeric: tabular-nums;
	}

	.grid-choice__count.is-full {
		color: var(--warning-text);
		font-weight: var(--fw-semibold);
	}

	.grid-choice__bulk {
		display: flex;
		gap: 4px;
	}

	/* Ruled cells: each cell draws its end and bottom rule; the frame clips the outer ones. */
	.grid-choice__cells {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(min(100%, var(--cell-min)), 1fr));
		overflow: hidden;
		border: 1px solid var(--border);
		border-radius: var(--radius-control);
		background: var(--bg-card);
	}

	.grid-choice__cell {
		min-width: 0;
		padding: 11px 14px;
		box-shadow:
			calc(1px * var(--dir)) 0 0 var(--border-subtle),
			0 1px 0 var(--border-subtle);
	}

	.grid-choice__cell.is-on {
		background: color-mix(in srgb, var(--primary) 5%, transparent);
	}

	/* Changed cell: the cell itself takes the wash (not the option inside it again). */
	.grid-choice__cell.is-changed {
		background: var(--changed-bg);
	}

	/* Quiet text stays readable (AA) on the wash. */
	.grid-choice__cell.is-changed .grid-choice__detail,
	.grid-choice__cell.is-changed .grid-choice__note {
		color: var(--text-secondary);
	}

	/* Locked means "on and fixed", not "unavailable": keep the text at full strength; only
	   the box shows it cannot be changed. */
	.grid-choice__cell.is-locked :global(.checkbox.is-disabled) {
		cursor: default;
		opacity: 1;
	}

	.grid-choice__cell.is-locked :global(.checkbox__box) {
		opacity: 0.55;
	}

	/* Label on one line with its note; the detail below it. */
	.grid-choice__cell :global(.checkbox__label) {
		font-weight: var(--fw-medium);
	}

	.grid-choice__note {
		margin-inline-start: 6px;
		color: var(--text-muted);
		font-size: var(--fs-small);
		font-weight: var(--fw-regular);
	}

	.grid-choice__detail {
		display: block;
		color: var(--text-muted);
		font-size: var(--fs-small);
		font-weight: var(--fw-regular);
	}
</style>
