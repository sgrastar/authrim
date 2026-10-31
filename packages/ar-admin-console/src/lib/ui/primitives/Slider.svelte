<script lang="ts">
	import { useChangeMark } from '../save/save-scope';
	import { useBusy } from '../busy/busy';
	import { i18n, t } from '$lib/i18n/i18n.svelte';

	/**
	 * Numeric value on a range (native <input type="range">, so keyboard, touch and screen
	 * readers work unchanged). `format="percent"` shows 0–100 as a percentage. Ticks mark
	 * meaningful points; with `snapToTicks` the value can only land on them.
	 *
	 * Snapping drives the native range over tick positions (0…n-1, step 1) instead of rounding a
	 * free value, so the thumb itself moves from tick to tick — dragging, keys and the fill stay
	 * in step. The ticks are then spaced evenly, as a scale of discrete choices.
	 */
	interface Props {
		label: string;
		value?: number;
		min?: number;
		max?: number;
		step?: number;
		/** Tick marks: an interval (e.g. 25) or explicit values. */
		ticks?: number | readonly number[];
		/** Print values under the ticks. */
		tickLabels?: boolean;
		/** Only allow tick values (overrides `step`). */
		snapToTicks?: boolean;
		showValue?: boolean;
		format?: 'number' | 'percent';
		unit?: string;
		hint?: string;
		disabled?: boolean;
		onchange?: (value: number) => void;
		/** Path in the SaveScope draft; once the value differs from the saved one it is marked. */
		field?: string;
		/** Mark as changed explicitly (when `field` cannot express the comparison). */
		changed?: boolean;
	}

	let {
		label,
		value = $bindable(0),
		min = 0,
		max = 100,
		step = 1,
		ticks,
		tickLabels = false,
		snapToTicks = false,
		showValue = true,
		format = 'number',
		unit,
		hint,
		disabled = false,
		onchange,
		field,
		changed
	}: Props = $props();

	const changeMark = useChangeMark();
	const isChanged = $derived(changed ?? changeMark.changed(field, value));

	const busy = useBusy();
	const off = $derived(disabled || busy());

	const uid = $props.id();

	const tickValues = $derived.by(() => {
		if (ticks === undefined) return [];
		if (typeof ticks === 'number') {
			const out: number[] = [];
			for (let v = min; v <= max + 1e-9; v += ticks) out.push(Math.round(v * 1e6) / 1e6);
			return out;
		}
		return [...ticks].filter((v) => v >= min && v <= max).sort((a, b) => a - b);
	});

	const ratio = (v: number) => (max === min ? 0 : (v - min) / (max - min));
	const snapping = $derived(snapToTicks && tickValues.length > 1);
	const tickIndex = $derived(snapping ? indexOfNearest(value) : 0);

	/** Where a value sits along the track, 0–1. */
	function position(v: number): number {
		if (!snapping) return ratio(v);
		return indexOfNearest(v) / (tickValues.length - 1);
	}

	function indexOfNearest(v: number): number {
		let best = 0;
		tickValues.forEach((tick, index) => {
			if (Math.abs(tick - v) < Math.abs(tickValues[best] - v)) best = index;
		});
		return best;
	}

	function display(v: number): string {
		const formatter = new Intl.NumberFormat(
			i18n.locale,
			format === 'percent'
				? { style: 'percent', maximumFractionDigits: 1 }
				: { maximumFractionDigits: 2 }
		);
		const text = formatter.format(format === 'percent' ? v / 100 : v);
		return unit ? `${text} ${unit}` : text;
	}

	function input(event: Event & { currentTarget: HTMLInputElement }) {
		const raw = Number(event.currentTarget.value);
		const next = snapping ? tickValues[raw] : raw;
		if (next === value) return;
		value = next;
		onchange?.(value);
	}
</script>

<div class="slider" class:is-disabled={off} class:is-changed={isChanged}>
	<div class="slider__top">
		<label class="slider__label" for="{uid}-input"
			>{label}{#if isChanged}<span class="sr-only"> ({t('common.changed')})</span>{/if}</label
		>
		{#if showValue}<output class="slider__value" for="{uid}-input">{display(value)}</output>{/if}
	</div>
	<div class="slider__control" style:--fill="{position(value) * 100}%">
		<input
			id="{uid}-input"
			type="range"
			min={snapping ? 0 : min}
			max={snapping ? tickValues.length - 1 : max}
			step={snapping ? 1 : step}
			value={snapping ? tickIndex : value}
			disabled={off}
			aria-valuetext={display(value)}
			aria-describedby={hint ? `${uid}-hint` : undefined}
			oninput={input}
		/>
		{#if tickValues.length}
			<div class="slider__ticks" aria-hidden="true">
				{#each tickValues as tick (tick)}
					<span class="slider__tick" class:is-passed={tick <= value} style:--at={position(tick)}>
						{#if tickLabels}<span class="slider__tick-label">{display(tick)}</span>{/if}
					</span>
				{/each}
			</div>
		{/if}
	</div>
	{#if hint}<p class="slider__hint" id="{uid}-hint">{hint}</p>{/if}
</div>

<style>
	.slider {
		--thumb: 18px;
		display: grid;
		gap: 6px;
	}

	.slider.is-disabled {
		opacity: 0.5;
	}

	.slider__top {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 12px;
	}

	.slider__label {
		font-size: var(--fs-label);
		font-weight: var(--fw-semibold);
		color: var(--text-secondary);
	}

	.slider__value {
		font-size: var(--fs-body);
		font-variant-numeric: tabular-nums;
		font-weight: var(--fw-semibold);
	}

	.slider__control {
		position: relative;
		padding-bottom: 2px;
	}

	input {
		width: 100%;
		height: var(--thumb);
		margin: 0;
		background: transparent;
		appearance: none;
		-webkit-appearance: none;
		cursor: pointer;
	}

	/* Changed, not saved yet: the thumb gets a ring in the change colour. */
	.is-changed input::-webkit-slider-thumb {
		box-shadow: 0 0 0 4px var(--changed-ring);
	}

	.is-changed input::-moz-range-thumb {
		box-shadow: 0 0 0 4px var(--changed-ring);
	}

	input:disabled {
		cursor: not-allowed;
	}

	/* Track: filled part in the accent, rest neutral. Fills from the reading start. */
	input::-webkit-slider-runnable-track {
		height: 6px;
		border-radius: var(--radius-round);
		background: linear-gradient(
			to var(--slider-to, right),
			var(--primary) var(--fill),
			var(--bg-hover) var(--fill)
		);
		box-shadow: inset 0 0 0 1px var(--border-subtle);
	}

	input::-moz-range-track {
		height: 6px;
		border-radius: var(--radius-round);
		background: var(--bg-hover);
		box-shadow: inset 0 0 0 1px var(--border-subtle);
	}

	input::-moz-range-progress {
		height: 6px;
		border-radius: var(--radius-round);
		background: var(--primary);
	}

	input::-webkit-slider-thumb {
		width: var(--thumb);
		height: var(--thumb);
		margin-top: calc((6px - var(--thumb)) / 2);
		border: 2px solid var(--primary);
		border-radius: 50%;
		background: var(--bg-card);
		box-shadow: var(--shadow-sm);
		-webkit-appearance: none;
	}

	input::-moz-range-thumb {
		width: var(--thumb);
		height: var(--thumb);
		box-sizing: border-box;
		border: 2px solid var(--primary);
		border-radius: 50%;
		background: var(--bg-card);
	}

	input:focus-visible {
		outline: none;
	}

	input:focus-visible::-webkit-slider-thumb {
		outline: 2px solid var(--focus-ring);
		outline-offset: 2px;
	}

	input:focus-visible::-moz-range-thumb {
		outline: 2px solid var(--focus-ring);
		outline-offset: 2px;
	}

	:global([dir='rtl']) .slider {
		--slider-to: left;
	}

	/* Ticks sit under the thumb centre: the thumb travels from half its width to width minus half. */
	.slider__ticks {
		position: relative;
		height: 8px;
		margin-top: 2px;
	}

	.slider__tick {
		position: absolute;
		top: 0;
		inset-inline-start: calc(var(--thumb) / 2 + (100% - var(--thumb)) * var(--at));
		width: 1.5px;
		height: 6px;
		background: var(--border-strong);
		transform: translateX(calc(-50% * var(--dir)));
	}

	.slider__tick.is-passed {
		background: var(--primary);
	}

	.slider__tick-label {
		position: absolute;
		top: 9px;
		left: 50%;
		color: var(--text-muted);
		font-size: var(--fs-small);
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
		transform: translateX(-50%);
	}

	.slider__control:has(.slider__tick-label) {
		padding-bottom: 18px;
	}

	.slider__hint {
		margin: 0;
		font-size: var(--fs-caption);
		color: var(--text-muted);
	}
</style>
