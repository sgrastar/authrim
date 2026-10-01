<script lang="ts">
	import { i18n } from '$lib/i18n/i18n.svelte';

	/**
	 * Progress of a task. Without `value` it loops (the duration is unknown); with `value`
	 * (0–100) it fills, and `showValue` adds the percentage.
	 */
	interface Props {
		/** Accessible name, e.g. what is being uploaded or processed. */
		label: string;
		/** 0–100. Omit for an indeterminate (looping) bar. */
		value?: number;
		showValue?: boolean;
		/** Show the label above the bar instead of keeping it for screen readers only. */
		showLabel?: boolean;
		tone?: 'default' | 'success' | 'danger';
		size?: 'md' | 'sm';
	}

	let {
		label,
		value,
		showValue = false,
		showLabel = false,
		tone = 'default',
		size = 'md'
	}: Props = $props();

	const clamped = $derived(value === undefined ? undefined : Math.min(100, Math.max(0, value)));
	const percent = $derived(
		clamped === undefined
			? ''
			: new Intl.NumberFormat(i18n.locale, { style: 'percent', maximumFractionDigits: 0 }).format(
					clamped / 100
				)
	);
</script>

<div class="progress progress--{tone} progress--{size}">
	{#if showLabel || (showValue && clamped !== undefined)}
		<div class="progress__meta" aria-hidden="true">
			{#if showLabel}<span class="progress__label">{label}</span>{/if}
			{#if showValue && clamped !== undefined}<span class="progress__value">{percent}</span>{/if}
		</div>
	{/if}
	<div
		class="progress__track"
		role="progressbar"
		aria-label={label}
		aria-valuemin={clamped === undefined ? undefined : 0}
		aria-valuemax={clamped === undefined ? undefined : 100}
		aria-valuenow={clamped === undefined ? undefined : Math.round(clamped)}
		aria-busy={clamped === undefined ? 'true' : undefined}
	>
		{#if clamped === undefined}
			<span class="progress__loop"></span>
		{:else}
			<span class="progress__fill" style:width="{clamped}%"></span>
		{/if}
	</div>
</div>

<style>
	.progress {
		--progress-color: var(--primary);
		display: grid;
		gap: 6px;
	}

	.progress--success {
		--progress-color: var(--success);
	}

	.progress--danger {
		--progress-color: var(--danger);
	}

	.progress__meta {
		display: flex;
		justify-content: space-between;
		gap: 12px;
		font-size: var(--fs-caption);
	}

	.progress__label {
		min-width: 0;
		overflow-wrap: anywhere;
		color: var(--text-secondary);
	}

	.progress__value {
		margin-inline-start: auto;
		font-variant-numeric: tabular-nums;
		font-weight: var(--fw-semibold);
		color: var(--text-primary);
	}

	.progress__track {
		position: relative;
		height: 6px;
		overflow: hidden;
		border-radius: var(--radius-round);
		background: var(--bg-hover);
		box-shadow: inset 0 0 0 1px var(--border-subtle);
	}

	.progress--sm .progress__track {
		height: 4px;
	}

	.progress__fill {
		position: absolute;
		inset-block: 0;
		inset-inline-start: 0;
		border-radius: inherit;
		background: var(--progress-color);
		transition: width 240ms ease;
	}

	/* Unknown duration: a segment travels along the track in the reading direction. */
	.progress__loop {
		position: absolute;
		inset-block: 0;
		inset-inline-start: 0;
		width: 38%;
		border-radius: inherit;
		background: var(--progress-color);
		animation: progress-loop 1.3s cubic-bezier(0.65, 0, 0.35, 1) infinite;
	}

	@keyframes progress-loop {
		from {
			transform: translateX(calc(-100% * var(--dir)));
		}
		to {
			transform: translateX(calc(265% * var(--dir)));
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.progress__fill {
			transition: none;
		}
		.progress__loop {
			width: 100%;
			animation: progress-pulse 2s ease-in-out infinite;
		}
		@keyframes progress-pulse {
			50% {
				opacity: 0.45;
			}
		}
	}
</style>
