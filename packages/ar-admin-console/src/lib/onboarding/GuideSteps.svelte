<script lang="ts">
	import { t } from '#lib/i18n/i18n.svelte.js';
	import Icon from '#lib/ui/icons/Icon.svelte';
	import IconButton from '#lib/ui/primitives/IconButton.svelte';
	import ProgressBar from '#lib/ui/primitives/ProgressBar.svelte';
	import type { ChecklistItem } from './checklist';

	/**
	 * The steps of the guide that is running, at the bottom start of the screen: where the person
	 * is in the lesson, what they have been through and what is left. It only shows; the guide's
	 * own popover is what leads. Closing it ends the guide. Below 1000px wide it is not drawn: it
	 * would sit over the save bar and the notifications at the bottom, and the guide's own
	 * popover is enough there.
	 */
	interface Props {
		item: ChecklistItem;
		/** The step the guide is at (0-based). */
		index: number;
		/** Ends the guide. */
		onstop: () => void;
	}

	let { item, index, onstop }: Props = $props();

	const name = $derived(t(item.title));
	const total = $derived(item.steps.length);
	const current = $derived(Math.min(Math.max(index, 0), total - 1));
</script>

<aside class="guide-steps" aria-label={t('ob.steps.label', { name })}>
	<div class="guide-steps__head">
		<h2 class="guide-steps__title">{name}</h2>
		<IconButton icon="close" size="sm" label={t('ob.stopNamed', { name })} onclick={onstop} />
	</div>
	<div class="guide-steps__progress">
		<ProgressBar
			label={t('ob.steps.progress', { name })}
			value={((current + 1) / total) * 100}
			size="sm"
		/>
		<p class="guide-steps__count" aria-live="polite">
			{t('ob.stepOf', { current: current + 1, total })}
		</p>
	</div>
	<ol class="guide-steps__list">
		{#each item.steps as step, at (at)}
			{@const state = at < current ? 'done' : at === current ? 'current' : 'next'}
			<li class="step step--{state}" aria-current={state === 'current' ? 'step' : undefined}>
				<span class="step__mark" aria-hidden="true">
					{#if state === 'done'}<Icon name="check" />{/if}
				</span>
				<span class="step__title">{t(step.title)}</span>
				{#if state !== 'next'}
					<span class="sr-only"
						>({t(state === 'done' ? 'ob.status.done' : 'ob.status.active')})</span
					>
				{/if}
			</li>
		{/each}
	</ol>
</aside>

<style>
	.guide-steps {
		position: fixed;
		inset-block-end: var(--space-section);
		inset-inline-start: var(--space-section);
		z-index: var(--z-guide);
		display: grid;
		gap: 10px;
		width: min(320px, calc(100vw - 2 * var(--space-section)));
		max-height: min(60vh, 460px);
		padding: 14px 16px;
		overflow: auto;
		border: 1px solid var(--border);
		border-radius: var(--radius-panel);
		background-color: var(--bg-card);
		box-shadow: var(--shadow-lg);
		color: var(--text-primary);
		align-content: start;
	}

	.guide-steps__head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
	}

	.guide-steps__title {
		margin: 0;
		font-size: var(--fs-title);
		font-weight: var(--fw-semibold);
		line-height: var(--lh-snug);
	}

	.guide-steps__progress {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		align-items: center;
		gap: 10px;
	}

	.guide-steps__count {
		margin: 0;
		color: var(--text-secondary);
		font-size: var(--fs-small);
		white-space: nowrap;
	}

	.guide-steps__list {
		display: grid;
		gap: 2px;
		margin: 0;
		padding: 10px 0 0;
		border-top: 1px solid var(--border-subtle);
		list-style: none;
	}

	.step {
		display: grid;
		grid-template-columns: 18px minmax(0, 1fr);
		align-items: start;
		gap: 10px;
		padding: 6px 0;
		color: var(--text-secondary);
		font-size: var(--fs-body);
		line-height: var(--lh-snug);
	}

	/* The circle: empty while ahead, ringed at the current step, checked once it is behind. */
	.step__mark {
		display: grid;
		place-items: center;
		box-sizing: border-box;
		width: 18px;
		height: 18px;
		margin-top: 1px;
		border: 1.5px solid var(--border-strong);
		border-radius: 50%;
		color: var(--text-inverse);
		font-size: var(--fs-small);
	}

	.step--current {
		color: var(--text-primary);
		font-weight: var(--fw-semibold);
	}

	.step--current .step__mark {
		border-color: var(--text-primary);
		border-width: 5px;
	}

	.step--done .step__mark {
		border-color: var(--text-primary);
		background-color: var(--text-primary);
	}

	.step--done .step__title {
		text-decoration: line-through;
	}

	@media (max-width: 1000px) {
		.guide-steps {
			display: none;
		}
	}
</style>
