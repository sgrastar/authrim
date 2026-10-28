<script lang="ts" module>
	import type { IconName } from '$lib/ui/icons/icons';

	export interface ChoiceCard {
		value: string;
		label: string;
		/** What choosing it means, in a sentence. */
		description?: string;
		icon?: IconName;
		/** A short mark beside the name ("Later", "Beta"). */
		badge?: string;
		disabled?: boolean;
	}
</script>

<script lang="ts">
	import Icon from '$lib/ui/icons/Icon.svelte';
	import Badge from '../primitives/Badge.svelte';

	/**
	 * One choice among a few that each need a sentence to tell apart (where to connect, what
	 * kind of app). For a plain list of short options use RadioGroup; for several at once,
	 * CheckboxGroup. Native radios underneath, so the arrow keys move the choice and a screen
	 * reader hears a radio group; the card is the label.
	 */
	interface Props {
		/** Name of the question ("Where do you want to connect?"). */
		label: string;
		options: readonly ChoiceCard[];
		value?: string;
		name?: string;
		/** Cards per row at most; fewer when the space is narrow. */
		columns?: 1 | 2 | 3;
		/** Keep the question for screen readers only (the page shows it already). */
		hideLabel?: boolean;
		disabled?: boolean;
		onchange?: (value: string) => void;
	}

	let {
		label,
		options,
		value = $bindable(''),
		name,
		columns = 2,
		hideLabel = false,
		disabled = false,
		onchange
	}: Props = $props();

	const uid = $props.id();
	const group = $derived(name ?? `${uid}-choice`);
</script>

<fieldset class="cards" {disabled}>
	<legend class="cards__label" class:sr-only={hideLabel}>{label}</legend>
	<div class="cards__grid" style:--cards-columns={columns}>
		{#each options as option (option.value)}
			<label class="card" class:is-selected={value === option.value} class:is-off={option.disabled}>
				<input
					class="sr-only"
					type="radio"
					name={group}
					value={option.value}
					checked={value === option.value}
					disabled={option.disabled}
					onchange={() => {
						value = option.value;
						onchange?.(option.value);
					}}
				/>
				{#if option.icon}<span class="card__icon" aria-hidden="true"
						><Icon name={option.icon} /></span
					>{/if}
				<span class="card__body">
					<span class="card__name">
						{option.label}
						{#if option.badge}<Badge>{option.badge}</Badge>{/if}
					</span>
					{#if option.description}<span class="card__desc">{option.description}</span>{/if}
				</span>
				<span class="card__mark" aria-hidden="true"
					>{#if value === option.value}<Icon name="check" />{/if}</span
				>
			</label>
		{/each}
	</div>
</fieldset>

<style>
	.cards {
		min-width: 0;
		margin: 0;
		padding: 0;
		border: 0;
	}

	.cards__label {
		margin-block-end: var(--space-related);
		padding: 0;
		color: var(--text-primary);
		font-size: var(--fs-label);
		font-weight: var(--fw-semibold);
	}

	.cards__grid {
		display: grid;
		grid-template-columns: repeat(var(--cards-columns), minmax(0, 1fr));
		gap: var(--space-grid);
	}

	@media (max-width: 640px) {
		.cards__grid {
			grid-template-columns: minmax(0, 1fr);
		}
	}

	.card {
		position: relative;
		display: flex;
		align-items: flex-start;
		gap: var(--space-grid);
		padding: 14px 16px;
		border: 1px solid var(--border);
		border-radius: var(--radius-panel);
		background: var(--bg-card);
		color: var(--text-primary);
		cursor: pointer;
	}

	.card:hover {
		background: var(--bg-subtle);
	}

	/* The whole outline, not an edge: the chosen card is ringed in the main colour. */
	.card.is-selected {
		border-color: var(--primary);
		box-shadow: inset 0 0 0 1px var(--primary);
	}

	.card:has(input:focus-visible) {
		outline: 2px solid var(--focus-ring);
		outline-offset: 2px;
	}

	.card.is-off {
		background: var(--bg-subtle);
		color: var(--text-muted);
		cursor: not-allowed;
	}

	.card__icon {
		display: grid;
		place-items: center;
		flex-shrink: 0;
		width: var(--control-h);
		height: var(--control-h);
		border-radius: var(--radius-control);
		background: var(--bg-hover);
		--icon-size: var(--icon-lg);
	}

	.card__body {
		display: flex;
		flex: 1;
		flex-direction: column;
		gap: 4px;
		min-width: 0;
	}

	.card__name {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-related);
		align-items: center;
		font-size: var(--fs-body);
		font-weight: var(--fw-semibold);
	}

	.card__desc {
		color: var(--text-secondary);
		font-size: var(--fs-small);
		line-height: var(--lh-snug);
	}

	.card.is-off .card__desc {
		color: var(--text-muted);
	}

	.card__mark {
		display: grid;
		place-items: center;
		flex-shrink: 0;
		width: var(--icon-lg);
		height: var(--icon-lg);
		color: var(--primary);
		--icon-size: var(--icon-md);
	}
</style>
