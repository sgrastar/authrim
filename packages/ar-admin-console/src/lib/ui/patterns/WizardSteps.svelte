<script lang="ts" module>
	export interface WizardStep {
		id: string;
		label: string;
		/** One line under the name, when the name alone does not say what the step is for. */
		hint?: string;
	}
</script>

<script lang="ts">
	import { untrack } from 'svelte';
	import { t } from '$lib/i18n/i18n.svelte';
	import Icon from '$lib/ui/icons/Icon.svelte';

	/**
	 * Where you are in a wizard: the steps in order, those behind you ticked, the current one
	 * marked, the rest still to come. A finished step can be reopened to change an answer; the
	 * ones ahead cannot be jumped to, because what they ask depends on the answers before them.
	 */
	interface Props {
		/** Name of the list; "Steps" by default. */
		label?: string;
		steps: readonly WizardStep[];
		/** Index of the current step. */
		current: number;
		/** Called with the index of a finished step the person chose to reopen. */
		onselect?: (index: number) => void;
		/** Under the list, for steps that are not known yet ("The rest depends on your choice"). */
		note?: string;
	}

	let { label, steps, current, onselect, note }: Props = $props();

	// A step that was not in the list a moment ago rises into place, the way the rows of the left
	// navigation do when a category opens. The steps present at the start do not move.
	let known = untrack(() => steps.map((step) => step.id));
	let entering = $state<string[]>([]);
	let timer: ReturnType<typeof setTimeout> | undefined;
	$effect(() => {
		const ids = steps.map((step) => step.id);
		const added = ids.filter((id) => !known.includes(id));
		known = ids;
		if (added.length === 0) return;
		entering = added;
		clearTimeout(timer);
		timer = setTimeout(() => (entering = []), 360 + added.length * 40 + 120);
	});
	$effect(() => () => clearTimeout(timer));
</script>

<div class="steps">
	<ol class="steps__list" aria-label={label ?? t('wizard.steps')}>
		{#each steps as step, index (step.id)}
			{@const state = index < current ? 'done' : index === current ? 'current' : 'todo'}
			<li
				class="step is-{state}"
				class:is-entering={entering.includes(step.id)}
				style:--fi={entering.indexOf(step.id)}
				aria-current={state === 'current' ? 'step' : undefined}
			>
				<span class="step__marker" aria-hidden="true">
					{#if state === 'done'}<Icon name="check" />{:else}{index + 1}{/if}
				</span>
				<span class="step__text">
					{#if state === 'done' && onselect}
						<button
							type="button"
							class="step__label step__label--link"
							onclick={() => onselect(index)}
						>
							{step.label}<span class="sr-only">, {t('wizard.stepDone')}</span>
						</button>
					{:else}
						<span class="step__label">
							{step.label}{#if state !== 'todo'}<span class="sr-only"
									>, {state === 'done' ? t('wizard.stepDone') : t('wizard.stepCurrent')}</span
								>{/if}
						</span>
					{/if}
					{#if step.hint}<span class="step__hint">{step.hint}</span>{/if}
				</span>
			</li>
		{/each}
	</ol>
	{#if note}<p class="steps__note">{note}</p>{/if}
</div>

<style>
	.steps__list {
		display: flex;
		flex-direction: column;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.step {
		position: relative;
		display: flex;
		gap: var(--space-grid);
		padding-block-end: var(--space-section);
	}

	/* The line from one marker to the next. */
	.step:not(:last-child)::after {
		content: '';
		position: absolute;
		inset-block: calc(var(--control-h-xs) + 4px) 4px;
		inset-inline-start: calc(var(--control-h-xs) / 2);
		width: 1px;
		background: var(--border-strong);
	}

	/* The same rise as the rows of the left navigation (SubNav), one after another. */
	.step.is-entering {
		animation: step-rise 360ms var(--flip-ease) both;
		animation-delay: calc(var(--fi, 0) * 40ms);
		backface-visibility: hidden;
	}

	@keyframes step-rise {
		from {
			opacity: 0;
			transform: perspective(500px) rotateX(90deg);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.step.is-entering {
			animation: none;
		}
	}

	.step__marker {
		display: grid;
		place-items: center;
		flex-shrink: 0;
		width: var(--control-h-xs);
		height: var(--control-h-xs);
		border: 1px solid var(--border-strong);
		border-radius: 50%;
		background: var(--bg-card);
		color: var(--text-secondary);
		font-size: var(--fs-caption);
		font-variant-numeric: tabular-nums;
		font-weight: var(--fw-semibold);
		--icon-size: var(--icon-sm);
	}

	.is-done .step__marker {
		border-color: var(--primary);
		background: var(--primary);
		color: var(--text-inverse);
	}

	.is-current .step__marker {
		border-color: var(--primary);
		box-shadow: inset 0 0 0 1px var(--primary);
		color: var(--text-primary);
	}

	.step__text {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
		padding-block-start: 2px;
	}

	.step__label {
		padding: 0;
		border: 0;
		background: none;
		color: var(--text-secondary);
		font: inherit;
		font-size: var(--fs-body);
		text-align: start;
	}

	.is-current .step__label {
		color: var(--text-primary);
		font-weight: var(--fw-semibold);
	}

	.is-done .step__label {
		color: var(--text-primary);
	}

	.step__label--link {
		cursor: pointer;
	}

	.step__label--link:hover {
		text-decoration: underline;
	}

	.step__label--link:focus-visible {
		border-radius: var(--radius-xs);
		outline: 2px solid var(--focus-ring);
		outline-offset: 2px;
	}

	.step__hint {
		color: var(--text-muted);
		font-size: var(--fs-small);
	}

	.steps__note {
		margin: 0;
		padding-inline-start: calc(var(--control-h-xs) + var(--space-grid));
		color: var(--text-muted);
		font-size: var(--fs-small);
		line-height: var(--lh-snug);
	}
</style>
