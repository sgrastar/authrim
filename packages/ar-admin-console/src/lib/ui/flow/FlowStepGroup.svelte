<script lang="ts" module>
	export interface FlowSubStep {
		id: string;
		label: string;
		/** Status line, e.g. "Not set". */
		status: string;
	}
</script>

<script lang="ts">
	import { t } from '$lib/i18n/i18n.svelte';
	import Icon from '../icons/Icon.svelte';

	/**
	 * A step made of parts that are set one by one (Sign-in → "Methods & sources", "Validation
	 * rules"). The heading names the step and its overall status; each part opens on its own.
	 * Removable like FlowStep unless required.
	 */
	interface Props {
		name: string;
		status: string;
		state?: 'done' | 'partial' | 'todo' | 'required';
		items: readonly FlowSubStep[];
		/** The part being edited, if it is one of these. */
		current?: string;
		/** Who acts in this step when it is not the user at the sign-in screen ("On the wallet"). */
		note?: string;
		onselect?: (id: string) => void;
		onremove?: () => void;
		exiting?: boolean;
	}

	let {
		name,
		status,
		state = 'todo',
		items,
		current,
		note,
		onselect,
		onremove,
		exiting = false
	}: Props = $props();

	const isCurrent = $derived(items.some((item) => item.id === current));
	const uid = $props.id();
</script>

<div class="group-item" inert={exiting} aria-hidden={exiting ? 'true' : undefined}>
	<div class="group-wrap">
		<section
			class="group group--{state}"
			class:is-current={isCurrent}
			class:is-exiting={exiting}
			aria-labelledby="{uid}-name"
		>
			<div class="group__heading">
				<strong id="{uid}-name">{name}</strong>
				<span class="group__status">{status}</span>
			</div>
			{#if note}<p class="group__note">{note}</p>{/if}
			{#each items as item (item.id)}
				<button
					type="button"
					class="group__part"
					aria-current={current === item.id ? 'step' : undefined}
					onclick={() => onselect?.(item.id)}
				>
					<span class="group__text">
						<span class="group__part-name">{item.label}</span>
						<span class="group__part-status">{item.status}</span>
					</span>
					<span class="group__chevron" aria-hidden="true">›</span>
				</button>
			{/each}
		</section>
		{#if onremove && state !== 'required' && !exiting}
			<button
				type="button"
				class="group__remove"
				aria-label={t('flow.remove', { name })}
				title={t('flow.remove', { name })}
				onclick={onremove}><Icon name="close" /></button
			>
		{/if}
	</div>
</div>

<style>
	.group-item {
		display: flex;
		justify-content: center;
		width: 100%;
	}

	.group-wrap {
		position: relative;
		width: var(--flow-node-w);
	}

	.group {
		display: flex;
		flex-direction: column;
		padding: 6px;
		border: 1px solid var(--border);
		border-radius: min(7px, var(--radius-control));
		background: var(--bg-card);
		color: var(--text-secondary);
		animation: group-arrive 220ms ease-out both;
	}

	.group.is-current {
		border-color: var(--primary);
		background: var(--bg-hover);
	}

	.group.is-exiting {
		animation: group-depart 220ms ease-in both;
	}

	.group__heading {
		display: grid;
		gap: 1px;
		padding: 6px 5px 5px;
	}

	.group__heading strong {
		color: var(--text-primary);
		font-size: var(--fs-caption);
		font-weight: var(--fw-name);
		line-height: var(--lh-tight);
		overflow-wrap: anywhere;
	}

	.group__status {
		color: var(--text-muted);
		font-size: var(--fs-overline);
		line-height: var(--lh-tight);
	}

	.group__note {
		margin: 0;
		padding: 0 5px 4px;
		color: var(--text-muted);
		font-size: var(--fs-overline);
	}

	.group__part {
		display: flex;
		align-items: center;
		gap: 6px;
		width: 100%;
		min-height: 36px;
		padding: 4px 8px;
		border: 0;
		border-radius: min(4px, var(--radius-xs));
		background: transparent;
		color: var(--text-secondary);
		text-align: start;
	}

	.group__part:hover,
	.group__part[aria-current='step'] {
		background: var(--bg-hover);
		color: var(--text-primary);
	}

	.group.is-current .group__part[aria-current='step'] {
		background: color-mix(in srgb, var(--text-primary) 7%, transparent);
	}

	.group__text {
		display: grid;
		flex: 1;
		min-width: 0;
		gap: 1px;
	}

	.group__part-name {
		font-size: var(--fs-small);
		line-height: var(--lh-tight);
		overflow-wrap: anywhere;
	}

	.group__part-status {
		color: var(--text-muted);
		font-size: var(--fs-overline);
		line-height: var(--lh-tight);
	}

	.group__chevron {
		color: var(--text-muted);
		font-size: var(--fs-caption);
	}

	:global([dir='rtl']) .group__chevron {
		transform: scaleX(-1);
	}

	/* Same × as FlowStep: only on the step being touched. */
	.group__remove {
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

	.group-wrap:hover .group__remove,
	.group-wrap:focus-within .group__remove {
		opacity: 1;
		transform: none;
	}

	.group__remove:hover {
		border-color: var(--danger);
		color: var(--danger);
	}

	@keyframes group-arrive {
		from {
			opacity: 0;
			transform: translateY(-4px);
		}
	}

	@keyframes group-depart {
		to {
			opacity: 0;
			transform: translateY(-4px);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.group,
		.group.is-exiting {
			animation: none;
		}
		.group__remove {
			transition: none;
		}
	}
</style>
