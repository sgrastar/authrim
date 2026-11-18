<script lang="ts">
	import { t } from '#lib/i18n/i18n.svelte.js';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import Card from '#lib/ui/patterns/Card.svelte';
	import LoadingState from '#lib/ui/patterns/LoadingState.svelte';
	import Icon from '#lib/ui/icons/Icon.svelte';
	import Badge from '#lib/ui/primitives/Badge.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import ProgressBar from '#lib/ui/primitives/ProgressBar.svelte';
	import { toast } from '#lib/ui/toast/toast.svelte.js';
	import { CHECKLIST, type ChecklistItem } from './checklist';
	import { guide } from './guide.svelte';
	import { onboardingProgress } from './progress.svelte';

	/**
	 * The first-steps checklist: things to try in a new environment, each with a guide that
	 * shows where. A finished item is checked, and stays checked in every browser (the progress
	 * is the signed-in admin's, per tenant). An item can also be checked or unchecked by hand.
	 * The items come from `checklist.ts`.
	 */
	interface Props {
		items?: readonly ChecklistItem[];
		/** Starts an item's guide. */
		onstart?: (itemId: string) => void;
		/** Ends the guide in progress. */
		onstop?: () => void;
		/** The item whose guide is in progress. */
		activeItemId?: string | null;
	}

	let {
		items = CHECKLIST,
		onstart = (itemId) => guide.start(itemId),
		onstop = () => guide.stop(),
		activeItemId = guide.activeItemId
	}: Props = $props();

	const done = $derived(items.filter((item) => onboardingProgress.has(item.id)).length);
	const total = $derived(items.length);
	// The one to do next gets the primary button.
	const nextId = $derived(items.find((item) => !onboardingProgress.has(item.id))?.id ?? null);

	async function mark(item: ChecklistItem, finished: boolean) {
		const saved = await (finished
			? onboardingProgress.complete(item.id)
			: onboardingProgress.reopen(item.id));
		if (!saved) toast.error(t('ob.saveFailed'));
	}
</script>

<Card title={t('ob.title')} description={t('ob.lead')}>
	{#if onboardingProgress.phase === 'idle' || onboardingProgress.phase === 'loading'}
		<LoadingState label={t('common.loading')} />
	{:else if onboardingProgress.phase === 'failed'}
		<Callout tone="danger" live>
			{t('ob.loadFailed')}
			<Button size="sm" variant="secondary" onclick={() => onboardingProgress.load()}
				>{t('common.retry')}</Button
			>
		</Callout>
	{:else}
		<div class="progress">
			<ProgressBar
				label={t('ob.progressLabel')}
				value={total === 0 ? 0 : (done / total) * 100}
				tone={done === total ? 'success' : 'default'}
				size="sm"
			/>
			<p class="progress__count" aria-live="polite">{t('ob.progress', { done, total })}</p>
		</div>
		{#if total > 0 && done === total}
			<p class="all-done">{t('ob.allDone')}</p>
		{/if}
		<ol class="items">
			{#each items as item (item.id)}
				{@const finished = onboardingProgress.has(item.id)}
				{@const running = activeItemId === item.id}
				{@const name = t(item.title)}
				<li class="item" class:is-done={finished}>
					<span class="item__mark" aria-hidden="true">
						<Icon name={finished ? 'checkCircle' : item.icon} />
					</span>
					<div class="item__text">
						<h3 class="item__title">
							{name}
							<span class="sr-only">({t(finished ? 'ob.status.done' : 'ob.status.todo')})</span>
						</h3>
						<p class="item__desc">{t(item.description)}</p>
					</div>
					<div class="item__actions">
						{#if running}
							<Badge tone="info" dot>{t('ob.status.active')}</Badge>
							<Button size="sm" aria-label={t('ob.stopNamed', { name })} onclick={onstop}
								>{t('ob.stop')}</Button
							>
						{:else}
							<Button
								size="sm"
								variant={item.id === nextId ? 'primary' : 'secondary'}
								aria-label={t(finished ? 'ob.againNamed' : 'ob.startNamed', { name })}
								onclick={() => onstart(item.id)}
							>
								{t(finished ? 'ob.again' : 'ob.start')}
							</Button>
						{/if}
						<Button
							size="sm"
							variant="ghost"
							aria-label={t(finished ? 'ob.markTodoNamed' : 'ob.markDoneNamed', { name })}
							onclick={() => mark(item, !finished)}
						>
							{t(finished ? 'ob.markTodo' : 'ob.markDone')}
						</Button>
					</div>
				</li>
			{/each}
		</ol>
	{/if}
</Card>

<style>
	.progress {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: var(--space-related);
		align-items: center;
	}

	.progress__count {
		margin: 0;
		color: var(--text-secondary);
		font-size: var(--fs-small);
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}

	.all-done {
		margin: var(--space-related) 0 0;
		color: var(--text-secondary);
		font-size: var(--fs-small);
	}

	.items {
		display: grid;
		margin: var(--space-field) 0 0;
		padding: 0;
		list-style: none;
	}

	.item {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr) auto;
		gap: var(--space-related) var(--space-field);
		align-items: center;
		padding: 12px 0;
		border-top: 1px solid var(--border-subtle);
	}

	.item__mark {
		display: inline-flex;
		color: var(--text-muted);
		font-size: var(--icon-xl);
	}

	.item.is-done .item__mark {
		color: var(--success);
	}

	.item__title {
		margin: 0;
		font-size: var(--fs-body);
		font-weight: var(--fw-semibold);
	}

	.item__desc {
		margin: 2px 0 0;
		color: var(--text-secondary);
		font-size: var(--fs-small);
	}

	.item__actions {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		align-items: center;
		justify-content: flex-end;
	}

	@media (max-width: 640px) {
		.item {
			grid-template-columns: auto minmax(0, 1fr);
		}

		.item__actions {
			grid-column: 2;
			justify-content: flex-start;
		}
	}
</style>
