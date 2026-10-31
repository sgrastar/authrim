<script lang="ts">
	import { t } from '$lib/i18n/i18n.svelte';
	import Icon from '../icons/Icon.svelte';

	/**
	 * One step Authrim runs in the flow. Name and status are stacked on two lines so long
	 * German names never collide with the status. The status stays quiet (the page body is
	 * where it is explained); `state` only decides that required steps cannot be removed.
	 */
	interface Props {
		name: string;
		/** Status line, e.g. "Configured", "Required — not set". */
		status: string;
		state?: 'done' | 'partial' | 'todo' | 'required';
		current?: boolean;
		onselect?: () => void;
		/** Shown as × on hover/focus for optional steps. The page confirms if settings exist. */
		onremove?: () => void;
		/** Being removed: plays its exit and can no longer be used (set by FlowSequence). */
		exiting?: boolean;
	}

	let {
		name,
		status,
		state = 'todo',
		current = false,
		onselect,
		onremove,
		exiting = false
	}: Props = $props();
</script>

<div class="step-item" inert={exiting} aria-hidden={exiting ? 'true' : undefined}>
	<div class="step-wrap">
		<button
			type="button"
			class="step step--{state}"
			class:is-current={current}
			class:is-exiting={exiting}
			aria-current={current ? 'step' : undefined}
			onclick={onselect}
		>
			<span class="step__text">
				<strong>{name}</strong>
				<span class="step__status">{status}</span>
			</span>
			<span class="step__chevron" aria-hidden="true">›</span>
		</button>
		{#if onremove && state !== 'required' && !exiting}
			<button
				type="button"
				class="step__remove"
				aria-label={t('flow.remove', { name })}
				title={t('flow.remove', { name })}
				onclick={onremove}><Icon name="close" /></button
			>
		{/if}
	</div>
</div>

<style>
	.step-item {
		display: flex;
		justify-content: center;
		width: 100%;
	}

	.step-wrap {
		position: relative;
		width: var(--flow-node-w);
	}

	.step {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		min-height: 46px;
		padding: 6px 13px;
		border: 1px solid var(--border);
		border-radius: min(7px, var(--radius-control));
		background: var(--bg-card);
		color: var(--text-secondary);
		text-align: start;
		animation: step-arrive 220ms ease-out both;
	}

	.step:hover {
		border-color: var(--border-strong);
	}

	.step.is-current {
		border-color: var(--primary);
		background: var(--bg-hover);
	}

	.step__text {
		display: grid;
		min-width: 0;
		flex: 1;
		gap: 1px;
	}

	.step__text strong {
		color: var(--text-primary);
		font-size: var(--fs-caption);
		font-weight: var(--fw-name);
		line-height: var(--lh-tight);
		overflow-wrap: anywhere;
	}

	.step__status {
		color: var(--text-muted);
		font-size: var(--fs-overline);
		line-height: var(--lh-tight);
		overflow-wrap: anywhere;
	}

	.step__chevron {
		color: var(--text-muted);
		font-size: var(--fs-caption);
	}

	:global([dir='rtl']) .step__chevron {
		transform: scaleX(-1);
	}

	/* Only the step being touched shows its ×; showing all of them makes the diagram noisy. */
	.step__remove {
		position: absolute;
		top: -7px;
		inset-inline-end: -7px;
		display: grid;
		place-items: center;
		width: 20px;
		height: 20px;
		padding: 0;
		border: 1px solid var(--border);
		border-radius: 50%;
		background: var(--bg-card);
		color: var(--text-muted);
		opacity: 0;
		transform: scale(0.85);
		transition:
			opacity 120ms,
			transform 120ms;
		--icon-size: var(--icon-xs);
	}

	.step-wrap:hover .step__remove,
	.step-wrap:focus-within .step__remove {
		opacity: 1;
		transform: none;
	}

	.step__remove:hover {
		border-color: var(--danger);
		color: var(--danger);
	}

	/* A removed step fades where it stood before the gap closes over it. */
	.step.is-exiting {
		animation: step-depart 220ms ease-in both;
	}

	@keyframes step-depart {
		to {
			opacity: 0;
			transform: translateY(-4px);
		}
	}

	@keyframes step-arrive {
		from {
			opacity: 0;
			transform: translateY(-4px);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.step,
		.step.is-exiting {
			animation: none;
		}
		.step__remove {
			transition: none;
		}
	}
</style>
