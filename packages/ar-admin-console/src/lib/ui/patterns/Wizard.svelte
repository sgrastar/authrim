<script lang="ts">
	import { tick, type Snippet } from 'svelte';
	import { t } from '$lib/i18n/i18n.svelte';
	import Button from '../primitives/Button.svelte';
	import WizardSteps, { type WizardStep } from './WizardSteps.svelte';

	/**
	 * A job too long for one form, asked one step at a time: the steps down the side, the
	 * current step's questions in the middle, Back and Next below. What the later steps ask may
	 * depend on earlier answers, so the page owns the list of steps and changes it as answers
	 * arrive; the wizard only walks it. Moving to a step puts focus on its heading, so a
	 * keyboard or screen-reader user lands on the new questions instead of on a vanished button.
	 */
	interface Props {
		steps: readonly WizardStep[];
		/** Index of the current step. */
		current?: number;
		/** What this step needs before Next works. */
		canNext?: boolean;
		/** One sentence under the heading: what this step is for. */
		description?: string;
		/** Under the steps, for the part that is not known yet. */
		stepsNote?: string;
		/** A line above "Step n of m": what is being set up, once the steps are about it. */
		context?: string;
		/** This is the last step although more steps may follow (the person has not chosen yet): the
		 *  default is the last step of the list. */
		final?: boolean;
		/** Name of the last button; "Finish" by default. */
		finishLabel?: string;
		/** Something is running: the buttons wait. */
		busy?: boolean;
		onfinish?: () => void;
		oncancel?: () => void;
		/** The questions of the current step. */
		children: Snippet<[WizardStep]>;
	}

	let {
		steps,
		current = $bindable(0),
		canNext = true,
		description,
		stepsNote,
		context,
		final,
		finishLabel,
		busy = false,
		onfinish,
		oncancel,
		children
	}: Props = $props();

	let heading = $state<HTMLHeadingElement>();
	const step = $derived(steps[Math.min(current, steps.length - 1)]);
	const last = $derived(final ?? current >= steps.length - 1);

	async function go(index: number) {
		current = Math.max(0, Math.min(index, steps.length - 1));
		await tick();
		heading?.focus();
	}
</script>

<div class="wizard">
	<div class="wizard__side">
		<WizardSteps {steps} {current} onselect={go} note={stepsNote} />
	</div>
	<div class="wizard__main">
		<div class="wizard__head">
			{#if context}<p class="wizard__context">{context}</p>{/if}
			<p class="wizard__count">
				{t('wizard.stepOf', { current: current + 1, total: steps.length })}
			</p>
			<h2 class="wizard__title" tabindex="-1" bind:this={heading}>{step.label}</h2>
			{#if description}<p class="wizard__desc">{description}</p>{/if}
		</div>
		<div class="wizard__body">
			{@render children(step)}
		</div>
		<div class="wizard__foot">
			{#if oncancel}
				<Button variant="ghost" onclick={oncancel} disabled={busy}>{t('common.cancel')}</Button>
			{/if}
			<span class="wizard__spacer"></span>
			<Button
				variant="secondary"
				icon="caretLeft"
				disabled={current === 0 || busy}
				onclick={() => go(current - 1)}>{t('wizard.back')}</Button
			>
			{#if last}
				<Button
					attention={canNext}
					disabled={!canNext || busy}
					loading={busy}
					onclick={() => onfinish?.()}>{finishLabel ?? t('wizard.finish')}</Button
				>
			{:else}
				<Button
					iconEnd="caretRight"
					attention={canNext}
					disabled={!canNext || busy}
					onclick={() => go(current + 1)}>{t('wizard.next')}</Button
				>
			{/if}
		</div>
	</div>
</div>

<style>
	.wizard {
		display: grid;
		grid-template-columns: 200px minmax(0, 1fr);
		gap: var(--space-columns);
		align-items: start;
	}

	@media (max-width: 760px) {
		.wizard {
			grid-template-columns: minmax(0, 1fr);
		}

		/* The count above the heading says where you are; Back goes one step at a time. */
		.wizard__side {
			display: none;
		}
	}

	.wizard__main {
		min-width: 0;
		border: 1px solid var(--border);
		border-radius: var(--radius-panel);
		background: var(--bg-card);
	}

	.wizard__head {
		display: flex;
		flex-direction: column;
		gap: 4px;
		padding: 20px 24px 0;
	}

	.wizard__context {
		margin: 0;
		color: var(--text-primary);
		font-size: var(--fs-small);
		font-weight: var(--fw-semibold);
	}

	.wizard__count {
		margin: 0;
		color: var(--text-muted);
		font-size: var(--fs-small);
	}

	.wizard__title {
		margin: 0;
		font-size: var(--fs-title);
		font-weight: var(--fw-semibold);
		line-height: var(--lh-tight);
	}

	.wizard__title:focus {
		outline: none;
	}

	.wizard__title:focus-visible {
		border-radius: var(--radius-xs);
		outline: 2px solid var(--focus-ring);
		outline-offset: 4px;
	}

	.wizard__desc {
		margin: 0;
		color: var(--text-secondary);
		font-size: var(--fs-body);
		line-height: var(--lh-body);
	}

	.wizard__body {
		display: flex;
		flex-direction: column;
		gap: var(--space-field);
		padding: 20px 24px 24px;
	}

	.wizard__foot {
		display: flex;
		gap: var(--space-related);
		align-items: center;
		padding: 14px 24px;
		border-block-start: 1px solid var(--border);
	}

	.wizard__spacer {
		flex: 1;
	}
</style>
