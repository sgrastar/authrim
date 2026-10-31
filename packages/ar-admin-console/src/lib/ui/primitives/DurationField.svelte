<script lang="ts">
	import { untrack } from 'svelte';
	import { i18n, t } from '$lib/i18n/i18n.svelte';
	import { useBusy } from '../busy/busy';
	import { formatNumber } from '../format';
	import Icon from '../icons/Icon.svelte';
	import { useChangeMark, useInvalidReport } from '../save/save-scope';
	import {
		DURATION_UNITS,
		parseNumberInput,
		pickDurationUnit,
		unitSeconds,
		type DurationUnit
	} from './number-input';

	/**
	 * A length of time — token lifetimes, session timeouts, retention — always stored in
	 * seconds, shown in the unit that reads best (86400 → 1 day). The admin may type in another
	 * unit: changing the unit keeps the number and changes what it means ("30" + minutes).
	 * Under the box, the total in seconds, to match the API and the docs (`total={false}` where
	 * the API does not count in seconds, or the page lists many durations).
	 * `min` / `max` are in seconds and are explained in readable units.
	 */
	interface Props {
		label: string;
		/** Keep the label for screen readers only (the name is shown beside the field). */
		hideLabel?: boolean;
		/** Seconds; null when not set. */
		value?: number | null;
		/** Units offered, smallest first. */
		units?: readonly DurationUnit[];
		/** Seconds. */
		min?: number;
		/** Seconds. */
		max?: number;
		hint?: string;
		error?: string;
		required?: boolean;
		disabled?: boolean;
		invalid?: boolean;
		field?: string;
		changed?: boolean;
		/** Show the total in seconds under the box. */
		total?: boolean;
	}

	let {
		label,
		hideLabel = false,
		value = $bindable(null),
		units = ['seconds', 'minutes', 'hours', 'days'],
		min,
		max,
		hint,
		error,
		required = false,
		disabled = false,
		invalid = $bindable(false),
		field,
		changed,
		total: showTotal = true
	}: Props = $props();

	const uid = $props.id();
	const busy = useBusy();
	const changes = useChangeMark();
	const report = useInvalidReport();
	$effect(() => report(invalid));
	const isChanged = $derived(changed ?? changes.changed(field, value));

	const amountOf = (seconds: number | null, in_: DurationUnit) =>
		seconds === null ? '' : String(seconds / unitSeconds(in_));

	// Start from the props; later changes from the page arrive through the effect below.
	let unit = $state<DurationUnit>(untrack(() => pickDurationUnit(value, units)));
	let text = $state(untrack(() => amountOf(value, unit)));
	let message = $state<string | null>(null);
	let touched = $state(false);
	let written = value;

	$effect(() => {
		const outside = value;
		if (outside === written) return;
		written = outside;
		unit = pickDurationUnit(outside, units);
		text = amountOf(outside, unit);
		message = null;
		invalid = false;
		touched = false;
	});

	const n = (x: number) => formatNumber(x, i18n.locale);
	/** A bound in seconds, in the unit that shows it as a whole number ("1 day"). */
	function readable(seconds: number): string {
		const best = pickDurationUnit(seconds, units);
		return `${n(seconds / unitSeconds(best))} ${t(`duration.${best}`)}`;
	}

	function read() {
		const result = parseNumberInput(text, { min: 0 });
		if (result.problem) {
			message = result.problem.kind === 'whole' ? t('number.whole') : t('number.invalid');
			invalid = true;
			return;
		}
		const seconds = result.value === null ? null : result.value * unitSeconds(unit);
		if (
			seconds !== null &&
			((min !== undefined && seconds < min) || (max !== undefined && seconds > max))
		) {
			message =
				min !== undefined && max !== undefined
					? t('number.range', { min: readable(min), max: readable(max) })
					: min !== undefined
						? t('number.min', { min: readable(min) })
						: t('number.max', { max: readable(max ?? 0) });
			invalid = true;
			return;
		}
		message = null;
		invalid = false;
		written = seconds;
		value = seconds;
	}

	const shown = $derived(error ?? (touched && message ? message : undefined));
	const total = $derived(
		showTotal && value !== null && unit !== 'seconds' && !message
			? t('duration.total', { n: value })
			: ''
	);
	const describedBy = $derived(
		[hint ? `${uid}-hint` : '', total ? `${uid}-total` : '', shown ? `${uid}-error` : '']
			.filter(Boolean)
			.join(' ') || undefined
	);
	const offered = $derived(DURATION_UNITS.filter((entry) => units.includes(entry.id)));
</script>

<div
	class="duration"
	class:is-changed={isChanged}
	class:has-error={!!shown}
	class:is-off={disabled}
	role="group"
	aria-labelledby="{uid}-label"
>
	<label class="duration__label" class:sr-only={hideLabel} id="{uid}-label" for="{uid}-amount">
		{label}{#if isChanged}<span class="sr-only"> ({t('common.changed')})</span>{/if}
		{#if required}<span class="duration__req" aria-hidden="true">*</span>{/if}
	</label>
	<div class="duration__row">
		<input
			id="{uid}-amount"
			type="text"
			inputmode="numeric"
			autocomplete="off"
			bind:value={text}
			{required}
			{disabled}
			readonly={busy()}
			aria-invalid={shown ? 'true' : undefined}
			aria-describedby={describedBy}
			oninput={() => {
				read();
				if (!message) touched = false;
			}}
			onblur={() => (touched = true)}
		/>
		<span class="duration__unit">
			<select
				aria-label={t('duration.unit')}
				bind:value={unit}
				disabled={disabled || busy()}
				onchange={() => {
					touched = true;
					read();
				}}
			>
				{#each offered as entry (entry.id)}
					<option value={entry.id}>{t(`duration.${entry.id}`)}</option>
				{/each}
			</select>
			<span class="duration__caret" aria-hidden="true"><Icon name="caret" /></span>
		</span>
	</div>
	{#if hint}<p class="duration__hint" id="{uid}-hint">{hint}</p>{/if}
	{#if total}<p class="duration__hint" id="{uid}-total">{total}</p>{/if}
	{#if shown}<p class="duration__error" id="{uid}-error">{shown}</p>{/if}
</div>

<style>
	.duration {
		display: grid;
		gap: 5px;
	}

	.duration__label {
		color: var(--text-secondary);
		font-size: var(--fs-label);
		font-weight: var(--fw-semibold);
	}

	.duration__req {
		margin-inline-start: 3px;
		color: var(--danger);
	}

	/* One box: the number, then the unit. */
	.duration__row {
		display: flex;
		width: min(100%, 16rem);
		height: var(--control-h);
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-control);
		background: var(--bg-input);
	}

	.duration__row:focus-within {
		border-color: var(--focus-ring);
		outline: 2px solid color-mix(in srgb, var(--focus-ring) 35%, transparent);
	}

	input,
	select {
		border: 0;
		background: transparent;
		color: var(--text-primary);
		font: inherit;
		outline: none;
	}

	input {
		flex: 1;
		min-width: 0;
		padding: 0 10px;
		font-size: var(--fs-control);
		font-variant-numeric: tabular-nums;
		text-align: end;
	}

	.duration__unit {
		position: relative;
		display: flex;
		border-inline-start: 1px solid var(--border);
	}

	select {
		padding-inline: 10px 28px;
		color: var(--text-secondary);
		font-size: var(--fs-body);
		appearance: none;
		cursor: pointer;
	}

	/* The field's ring shows it has focus; a wash shows the unit part is the focused one. */
	select:focus-visible {
		background: var(--bg-hover);
		color: var(--text-primary);
	}

	.duration__caret {
		position: absolute;
		top: 50%;
		inset-inline-end: 9px;
		display: inline-flex;
		color: var(--text-muted);
		pointer-events: none;
		transform: translateY(-50%);
		--icon-size: var(--icon-xs);
	}

	.is-changed .duration__row {
		border-color: var(--changed-edge);
		background: linear-gradient(var(--changed-bg), var(--changed-bg)), var(--bg-input);
	}

	.has-error .duration__row {
		border-color: var(--danger);
	}

	.is-off .duration__row {
		opacity: 0.55;
	}

	.duration__hint,
	.duration__error {
		margin: 0;
		font-size: var(--fs-caption);
	}

	.duration__hint {
		color: var(--text-muted);
	}

	.duration__error {
		color: var(--danger);
	}
</style>
