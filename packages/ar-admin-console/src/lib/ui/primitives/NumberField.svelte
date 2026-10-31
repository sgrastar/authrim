<script lang="ts">
	import { i18n, t } from '$lib/i18n/i18n.svelte';
	import { useBusy } from '../busy/busy';
	import { formatNumber } from '../format';
	import { useChangeMark, useInvalidReport } from '../save/save-scope';
	import { parseNumberInput, type NumberProblem } from './number-input';

	/**
	 * A number with its unit shown in the box ("3600 | seconds", "90 | days"): limits, counts,
	 * retention periods. For lengths of time an admin may want in other units, use
	 * DurationField.
	 *
	 * - Typed text is read leniently (full-width digits, "1,000"); the value only changes to a
	 *   number that fits the rules. Anything else is explained under the box once the admin
	 *   leaves it, and `invalid` lets the page hold its Save until it is fixed.
	 * - ↑ / ↓ step by one (Shift: by ten), within `min` and `max`.
	 * - An empty box is `null`: "not set", not zero.
	 */
	interface Props {
		label: string;
		/** Keep the label for screen readers only (the name is shown beside the field). */
		hideLabel?: boolean;
		/** `sm`: a lower box and smaller text, beside other small controls or in a dense row. */
		size?: 'md' | 'sm';
		value?: number | null;
		/** Shown at the end of the box: "seconds", "days", "requests / minute". */
		unit?: string;
		min?: number;
		max?: number;
		/** Allow decimals. Counts and times are whole numbers by default. */
		decimal?: boolean;
		hint?: string;
		/** A message from the page (e.g. from the API); shown instead of the field's own. */
		error?: string;
		required?: boolean;
		disabled?: boolean;
		/** True while the text in the box is not a number that fits. */
		invalid?: boolean;
		field?: string;
		changed?: boolean;
	}

	let {
		label,
		hideLabel = false,
		size = 'md',
		value = $bindable(null),
		unit,
		min,
		max,
		decimal = false,
		hint,
		error,
		required = false,
		disabled = false,
		invalid = $bindable(false),
		field,
		changed
	}: Props = $props();

	const uid = $props.id();
	const busy = useBusy();
	const changes = useChangeMark();
	const report = useInvalidReport();
	$effect(() => report(invalid));
	const isChanged = $derived(changed ?? changes.changed(field, value));

	const show = (n: number | null) => (n === null ? '' : String(n));
	let text = $state(show(value));
	let problem = $state<NumberProblem | null>(null);
	/** Explain only after the admin has left the box, not while they are typing. */
	let touched = $state(false);

	const rules = () => ({ min, max, whole: !decimal });

	/** The value this field last wrote; anything else came from the page. */
	let written = value;

	// The page changed the value (reset, discard): show it, and forget any half-typed text.
	$effect(() => {
		const outside = value;
		if (outside === written) return;
		written = outside;
		text = show(outside);
		problem = null;
		invalid = false;
		touched = false;
	});

	function read() {
		const result = parseNumberInput(text, rules());
		problem = result.problem;
		invalid = result.problem !== null;
		if (!result.problem) {
			written = result.value;
			value = result.value;
		}
	}

	function step(event: KeyboardEvent) {
		if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
		event.preventDefault();
		const by = (event.shiftKey ? 10 : 1) * (event.key === 'ArrowUp' ? 1 : -1);
		let next = (value ?? min ?? 0) + by;
		if (min !== undefined) next = Math.max(min, next);
		if (max !== undefined) next = Math.min(max, next);
		text = String(next);
		read();
	}

	const n = (x: number) => formatNumber(x, i18n.locale);
	function message(p: NumberProblem): string {
		switch (p.kind) {
			case 'invalid':
				return t('number.invalid');
			case 'whole':
				return t('number.whole');
			case 'range':
				return t('number.range', { min: n(p.min), max: n(p.max) });
			case 'min':
				return t('number.min', { min: n(p.min) });
			case 'max':
				return t('number.max', { max: n(p.max) });
		}
	}

	const shown = $derived(error ?? (touched && problem ? message(problem) : undefined));
	const describedBy = $derived(
		[unit ? `${uid}-unit` : '', hint ? `${uid}-hint` : '', shown ? `${uid}-error` : '']
			.filter(Boolean)
			.join(' ') || undefined
	);
</script>

<div
	class="number"
	class:number--sm={size === 'sm'}
	class:is-changed={isChanged}
	class:has-error={!!shown}
	class:is-off={disabled}
>
	<label class="number__label" class:sr-only={hideLabel} for="{uid}-input">
		{label}{#if isChanged}<span class="sr-only"> ({t('common.changed')})</span>{/if}
		{#if required}<span class="number__req" aria-hidden="true">*</span>{/if}
	</label>
	<div class="number__box">
		<input
			id="{uid}-input"
			type="text"
			inputmode={decimal ? 'decimal' : 'numeric'}
			autocomplete="off"
			bind:value={text}
			{required}
			{disabled}
			readonly={busy()}
			aria-invalid={shown ? 'true' : undefined}
			aria-describedby={describedBy}
			oninput={() => {
				read();
				if (!problem) touched = false;
			}}
			onblur={() => (touched = true)}
			onkeydown={step}
		/>
		{#if unit}<span class="number__unit" id="{uid}-unit">{unit}</span>{/if}
	</div>
	{#if hint}<p class="number__hint" id="{uid}-hint">{hint}</p>{/if}
	{#if shown}<p class="number__error" id="{uid}-error">{shown}</p>{/if}
</div>

<style>
	.number {
		display: grid;
		gap: 5px;
	}

	.number__label {
		color: var(--text-secondary);
		font-size: var(--fs-label);
		font-weight: var(--fw-semibold);
	}

	.number__req {
		margin-inline-start: 3px;
		color: var(--danger);
	}

	/* A number is short: the box does not stretch across the form. */
	.number__box {
		display: flex;
		align-items: stretch;
		width: min(100%, 14rem);
		height: var(--control-h);
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-control);
		background: var(--bg-input);
	}

	.number__box:focus-within {
		border-color: var(--focus-ring);
		outline: 2px solid color-mix(in srgb, var(--focus-ring) 35%, transparent);
	}

	input {
		flex: 1;
		min-width: 0;
		padding: 0 10px;
		border: 0;
		border-radius: var(--radius-control);
		background: transparent;
		color: var(--text-primary);
		font: inherit;
		font-size: var(--fs-control);
		font-variant-numeric: tabular-nums;
		text-align: end;
		outline: none;
	}

	.number__unit {
		display: flex;
		align-items: center;
		padding-inline: 10px;
		border-inline-start: 1px solid var(--border);
		color: var(--text-secondary);
		font-size: var(--fs-body);
		white-space: nowrap;
	}

	.number--sm .number__box {
		height: var(--control-h-sm);
	}

	.number--sm input {
		padding: 0 8px;
		font-size: var(--fs-label);
	}

	.number--sm .number__unit {
		padding-inline: 8px;
		font-size: var(--fs-label);
	}

	.is-changed .number__box {
		border-color: var(--changed-edge);
		background: linear-gradient(var(--changed-bg), var(--changed-bg)), var(--bg-input);
	}

	.has-error .number__box {
		border-color: var(--danger);
	}

	.is-off .number__box {
		opacity: 0.55;
	}

	input[readonly] {
		color: var(--text-secondary);
		cursor: progress;
	}

	.number__hint,
	.number__error {
		margin: 0;
		font-size: var(--fs-caption);
	}

	.number__hint {
		color: var(--text-muted);
	}

	.number__error {
		color: var(--danger);
	}
</style>
