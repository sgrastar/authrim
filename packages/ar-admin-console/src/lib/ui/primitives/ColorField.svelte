<script lang="ts">
	import { untrack } from 'svelte';
	import { i18n, t } from '$lib/i18n/i18n.svelte';
	import { useBusy } from '../busy/busy';
	import { formatNumber } from '../format';
	import Icon from '../icons/Icon.svelte';
	import { useChangeMark, useInvalidReport } from '../save/save-scope';
	import { contrastRatio, normalizeHex } from './color';

	/**
	 * A colour for branding (the sign-in button, links, the header). The swatch opens the
	 * system colour picker; the hex box takes a value pasted from a brand guide ("#3F4FC4",
	 * "3f4fc4", "#abc"). Stored as lower-case #rrggbb.
	 *
	 * With `contrastWith`, the field says how readable text is on (or in) this colour — the
	 * ratio and whether it meets `minContrast` (4.5:1, WCAG AA for text) — in words and an
	 * icon, not colour alone.
	 */
	interface Props {
		label: string;
		/** "#rrggbb"; empty when not set. */
		value?: string;
		hint?: string;
		/** The colour it is read against: the text on a button, the page behind a link. */
		contrastWith?: string;
		/** What that colour is, for the sentence ("white text"). */
		contrastLabel?: string;
		minContrast?: number;
		/** A few colours to choose from with one press (the brand palette). */
		presets?: readonly string[];
		required?: boolean;
		disabled?: boolean;
		invalid?: boolean;
		field?: string;
		changed?: boolean;
	}

	let {
		label,
		value = $bindable(''),
		hint,
		contrastWith,
		contrastLabel,
		minContrast = 4.5,
		presets = [],
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
	const isChanged = $derived(changed ?? changes.changed(field, value));
	const off = $derived(disabled || busy());

	// Start from the prop; later changes from the page arrive through the effect below.
	let text = $state(untrack(() => value));
	let touched = $state(false);
	let written = value;

	$effect(() => {
		const outside = value;
		if (outside === written) return;
		written = outside;
		text = outside;
		invalid = false;
		touched = false;
	});
	$effect(() => report(invalid));

	function set(next: string) {
		written = next;
		value = next;
		text = next;
		invalid = false;
	}

	function read() {
		const hex = normalizeHex(text);
		if (text.trim() === '') {
			invalid = required;
			written = '';
			value = '';
			return;
		}
		invalid = hex === null;
		if (hex) {
			written = hex;
			value = hex;
		}
	}

	const againstHex = $derived(contrastWith ? normalizeHex(contrastWith) : null);
	const ratio = $derived(value && againstHex ? contrastRatio(value, againstHex) : null);
	const passes = $derived(ratio !== null && ratio >= minContrast);
	const shown = $derived(touched && invalid ? t('color.invalid') : undefined);
	const describedBy = $derived(
		[
			hint ? `${uid}-hint` : '',
			ratio !== null ? `${uid}-contrast` : '',
			shown ? `${uid}-error` : ''
		]
			.filter(Boolean)
			.join(' ') || undefined
	);
</script>

<div class="color" class:is-changed={isChanged} class:has-error={!!shown}>
	<label class="color__label" for="{uid}-hex">
		{label}{#if isChanged}<span class="sr-only"> ({t('common.changed')})</span>{/if}
		{#if required}<span class="color__req" aria-hidden="true">*</span>{/if}
	</label>
	<div class="color__row">
		<span class="color__swatch" style:--swatch={value || 'transparent'}>
			<input
				type="color"
				value={value || '#000000'}
				aria-label={t('color.pick', { name: label })}
				disabled={off}
				oninput={(event) => set(event.currentTarget.value)}
			/>
		</span>
		<input
			class="color__hex"
			id="{uid}-hex"
			dir="ltr"
			type="text"
			bind:value={text}
			placeholder="#RRGGBB"
			maxlength={7}
			spellcheck="false"
			autocomplete="off"
			{required}
			disabled={off}
			aria-invalid={shown ? 'true' : undefined}
			aria-describedby={describedBy}
			oninput={read}
			onblur={() => {
				touched = true;
				const hex = normalizeHex(text);
				if (hex) text = hex;
			}}
		/>
		{#if presets.length}
			<span class="color__presets" role="group" aria-label={t('color.presets')}>
				{#each presets as preset (preset)}
					<button
						type="button"
						class="color__preset"
						class:is-current={preset === value}
						style:--swatch={preset}
						aria-label={t('color.preset', { value: preset })}
						aria-pressed={preset === value}
						disabled={off}
						onclick={() => set(preset)}
					></button>
				{/each}
			</span>
		{/if}
	</div>
	{#if hint}<p class="color__hint" id="{uid}-hint">{hint}</p>{/if}
	{#if ratio !== null}
		<p class="color__contrast" class:is-low={!passes} id="{uid}-contrast">
			<Icon name={passes ? 'checkCircle' : 'warning'} />
			<span>
				{t('color.contrast', {
					against: contrastLabel ?? contrastWith ?? '',
					ratio: formatNumber(ratio, i18n.locale, { maximumFractionDigits: 1 })
				})} ·
				{passes ? t('color.pass') : t('color.fail', { min: minContrast })}
			</span>
		</p>
	{/if}
	{#if shown}<p class="color__error" id="{uid}-error">{shown}</p>{/if}
</div>

<style>
	.color {
		display: grid;
		gap: 5px;
	}

	.color__label {
		color: var(--text-secondary);
		font-size: var(--fs-label);
		font-weight: var(--fw-semibold);
	}

	.color__req {
		margin-inline-start: 3px;
		color: var(--danger);
	}

	.color__row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-related);
	}

	/* The swatch shows the colour and opens the system picker. */
	.color__swatch {
		position: relative;
		width: var(--control-h);
		height: var(--control-h);
		overflow: hidden;
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-control);
		background: var(--swatch);
	}

	.color__swatch input {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		padding: 0;
		border: 0;
		opacity: 0;
		cursor: pointer;
	}

	.color__swatch:focus-within {
		outline: 2px solid var(--focus-ring);
		outline-offset: 2px;
	}

	.color__hex {
		width: 8.5rem;
		height: var(--control-h);
		padding: 0 10px;
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-control);
		background: var(--bg-input);
		color: var(--text-primary);
		font-family: var(--font-mono);
		font-size: var(--fs-body);
		text-transform: lowercase;
	}

	.color__hex::placeholder {
		color: var(--text-muted);
		text-transform: none;
		opacity: 1;
	}

	.color__hex:focus-visible {
		border-color: var(--focus-ring);
		outline: 2px solid color-mix(in srgb, var(--focus-ring) 35%, transparent);
		outline-offset: 0;
	}

	.is-changed .color__hex {
		border-color: var(--changed-edge);
		background: linear-gradient(var(--changed-bg), var(--changed-bg)), var(--bg-input);
	}

	.has-error .color__hex {
		border-color: var(--danger);
	}

	.color__presets {
		display: flex;
		gap: 6px;
		margin-inline-start: 4px;
	}

	.color__preset {
		width: var(--control-h-xs);
		height: var(--control-h-xs);
		padding: 0;
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-round);
		background: var(--swatch);
		cursor: pointer;
	}

	.color__preset.is-current {
		box-shadow:
			0 0 0 2px var(--bg-card),
			0 0 0 4px var(--text-primary);
	}

	.color__hint,
	.color__error,
	.color__contrast {
		margin: 0;
		font-size: var(--fs-caption);
	}

	.color__hint {
		color: var(--text-muted);
	}

	.color__error {
		color: var(--danger);
	}

	.color__contrast {
		display: flex;
		align-items: flex-start;
		gap: 6px;
		color: var(--text-secondary);
		--icon-size: var(--icon-sm);
	}

	.color__contrast :global(.icon) {
		margin-top: 1px;
		color: var(--success);
	}

	.color__contrast.is-low {
		color: var(--warning-text);
	}

	.color__contrast.is-low :global(.icon) {
		color: var(--warning-text);
	}
</style>
