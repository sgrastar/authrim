<script lang="ts">
	import { t } from '$lib/i18n/i18n.svelte';
	import type { MessageKey } from '$lib/i18n/messages/ja';
	import { useBusy } from '../busy/busy';
	import Select from '../primitives/Select.svelte';
	import { useChangeMark } from '../save/save-scope';
	import type { TimeZoneMode } from '../time/format-time';
	import { timePreference } from '../time/time-preference.svelte';
	import {
		fromInputValue,
		isReversed,
		toInputValue,
		type DateRange,
		type RangePreset
	} from './date-range';

	/**
	 * A period to filter by: a recent span (the last hour, day, week, month) or a custom start
	 * and end. Custom times are typed in the zone the admin chose for timestamps (personal
	 * settings: local or UTC), and the field says which. Either end may be left open.
	 * `size="sm"` for a FilterBar. Resolve the value with `resolveRange()` when querying.
	 */
	interface Props {
		label: string;
		value?: DateRange;
		presets?: readonly RangePreset[];
		size?: 'md' | 'sm';
		/** Hide the label (a FilterBar, where the options say what it is). */
		hideLabel?: boolean;
		/** Override the zone (tests; normally the admin's choice). */
		zone?: TimeZoneMode;
		field?: string;
		changed?: boolean;
	}

	let {
		label,
		value = $bindable({ preset: '24h' }),
		presets = ['1h', '24h', '7d', '30d', 'custom'],
		size = 'md',
		hideLabel = false,
		zone,
		field,
		changed
	}: Props = $props();

	const uid = $props.id();
	const busy = useBusy();
	const changes = useChangeMark();
	const isChanged = $derived(changed ?? changes.changed(field, value));
	const inZone = $derived(zone ?? timePreference.zone);

	const presetLabel: Record<RangePreset, MessageKey> = {
		'1h': 'range.last1h',
		'24h': 'range.last24h',
		'7d': 'range.last7d',
		'30d': 'range.last30d',
		custom: 'range.custom'
	};
	const options = $derived(
		presets.map((preset) => ({
			value: preset,
			label: t(presetLabel[preset])
		}))
	);
	const reversed = $derived(isReversed(value));

	function setPreset(preset: string) {
		value =
			preset === 'custom' ? { ...value, preset: 'custom' } : { preset: preset as RangePreset };
	}

	function setBound(side: 'from' | 'to', text: string) {
		value = { ...value, preset: 'custom', [side]: fromInputValue(text, inZone) };
	}
</script>

<div class="range" class:range--sm={size === 'sm'} role="group" aria-labelledby="{uid}-label">
	<span class="range__label" class:sr-only={hideLabel} id="{uid}-label">{label}</span>
	<div class="range__row">
		<Select
			label={t('range.preset')}
			hideLabel
			size={size === 'sm' ? 'sm' : 'md'}
			{options}
			value={value.preset}
			changed={isChanged && value.preset !== 'custom'}
			onchange={setPreset}
		/>
		{#if value.preset === 'custom'}
			<label class="range__bound">
				<span class="sr-only">{t('range.from')}</span>
				<input
					type="datetime-local"
					value={toInputValue(value.from, inZone)}
					readonly={busy()}
					aria-invalid={reversed ? 'true' : undefined}
					aria-describedby="{uid}-zone{reversed ? ` ${uid}-error` : ''}"
					class:is-changed={isChanged}
					onchange={(event) => setBound('from', event.currentTarget.value)}
				/>
			</label>
			<span class="range__dash" aria-hidden="true">–</span>
			<label class="range__bound">
				<span class="sr-only">{t('range.to')}</span>
				<input
					type="datetime-local"
					value={toInputValue(value.to, inZone)}
					readonly={busy()}
					aria-invalid={reversed ? 'true' : undefined}
					aria-describedby="{uid}-zone{reversed ? ` ${uid}-error` : ''}"
					class:is-changed={isChanged}
					onchange={(event) => setBound('to', event.currentTarget.value)}
				/>
			</label>
		{/if}
	</div>
	{#if value.preset === 'custom'}
		<p class="range__note" id="{uid}-zone">
			{t('range.zone', { zone: inZone === 'utc' ? 'UTC' : t('range.local') })}
		</p>
		{#if reversed}<p class="range__error" id="{uid}-error">{t('range.order')}</p>{/if}
	{/if}
</div>

<style>
	.range {
		display: grid;
		gap: 5px;
		min-width: 0;
	}

	.range__label {
		color: var(--text-secondary);
		font-size: var(--fs-label);
		font-weight: var(--fw-semibold);
	}

	.range__row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px;
	}

	.range__bound {
		display: flex;
	}

	input {
		height: var(--control-h);
		padding: 0 8px;
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-control);
		background: var(--bg-input);
		color: var(--text-primary);
		font: inherit;
		font-size: var(--fs-control);
		font-variant-numeric: tabular-nums;
	}

	.range--sm input {
		height: var(--control-h-sm);
		font-size: var(--fs-body);
	}

	input:focus-visible {
		border-color: var(--focus-ring);
		outline: 2px solid color-mix(in srgb, var(--focus-ring) 35%, transparent);
		outline-offset: 0;
	}

	input.is-changed {
		border-color: var(--changed-edge);
		background: linear-gradient(var(--changed-bg), var(--changed-bg)), var(--bg-input);
	}

	input[aria-invalid='true'] {
		border-color: var(--danger);
	}

	.range__dash {
		color: var(--text-muted);
	}

	.range__note,
	.range__error {
		margin: 0;
		font-size: var(--fs-caption);
	}

	.range__note {
		color: var(--text-muted);
	}

	.range__error {
		color: var(--danger);
	}
</style>
