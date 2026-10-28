<script lang="ts">
	import { t, type MessageKey } from '$lib/i18n/i18n.svelte';
	import FlowCanvas from '$lib/ui/flow/FlowCanvas.svelte';
	import FlowEdge from '$lib/ui/flow/FlowEdge.svelte';
	import FlowEndpoint from '$lib/ui/flow/FlowEndpoint.svelte';
	import FlowScope from '$lib/ui/flow/FlowScope.svelte';
	import FlowSequence from '$lib/ui/flow/FlowSequence.svelte';
	import FlowStepGroup from '$lib/ui/flow/FlowStepGroup.svelte';
	import Callout from '$lib/ui/patterns/Callout.svelte';
	import Card from '$lib/ui/patterns/Card.svelte';
	import DetailItem from '$lib/ui/patterns/DetailItem.svelte';
	import DetailList from '$lib/ui/patterns/DetailList.svelte';
	import PageHeader from '$lib/ui/patterns/PageHeader.svelte';
	import PanelHeader from '$lib/ui/patterns/PanelHeader.svelte';
	import Badge from '$lib/ui/primitives/Badge.svelte';
	import BackLink from '$lib/ui/primitives/BackLink.svelte';
	import Button from '$lib/ui/primitives/Button.svelte';
	import {
		aboutPart,
		FLOWS,
		flowName,
		groupLabel,
		groupState,
		isReady,
		partLabel,
		partState,
		stillToDo,
		summaryRows,
		visibleGroups,
		type AccountFlowId,
		type AccountFlowState,
		type PartState
	} from './account-flow-model';
	import AccountFlowStatus from './AccountFlowStatus.svelte';
	import AccountFlowStep from './AccountFlowStep.svelte';

	/**
	 * A sign-up or sign-in flow: the same contract wherever it is used (the Login UI, a separate
	 * login screen, a UI of your own, or one connection), told apart by its name and its place. Laid out like a connection's flow: the caller at both ends, Authrim's own steps
	 * between (each with its settings and how far it has got), and the chosen setting on the right.
	 * It opens on the overview. The optional step (consent at sign-up, an additional sign-in) is
	 * added with the flow's "+" and taken away with its ×. Dummy: nothing is saved anywhere.
	 */
	interface Props {
		flow: AccountFlowId;
		form: AccountFlowState;
		/** Back to the list of flows. */
		onback?: () => void;
		/** Move focus to the title when it appears. */
		focusTitle?: boolean;
	}

	let { flow, form = $bindable(), onback, focusTitle = false }: Props = $props();

	let titleElement = $state<HTMLHeadingElement | null>(null);
	$effect(() => {
		if (focusTitle) titleElement?.focus();
	});

	const def = $derived(FLOWS[flow]);
	const groups = $derived(visibleGroups(flow, form));
	const name = $derived(flowName(flow, form));
	const ready = $derived(isReady(flow, form));
	const todo = $derived(stillToDo(flow, form));
	const overview = $derived(t('sf.detail.overview'));

	/** The setting shown on the right; empty is the overview. */
	let current = $state('');

	const GROUP_STATUS: Record<'done' | 'partial' | 'todo' | 'required', MessageKey> = {
		done: 'sf.status.done',
		partial: 'sf.status.partial',
		todo: 'sf.status.todo',
		required: 'sf.status.todo'
	};
	const STATUS: Record<PartState, MessageKey> = {
		done: 'sf.status.done',
		required: 'sf.status.todo',
		todo: 'sf.status.todo'
	};

	/** The flow's own settings, at the top of the overview. */
	let general = $state<HTMLElement | null>(null);

	/** The flow's own settings are on the overview; any other setting opens on the right. */
	function open(id: string) {
		if (id !== aboutPart(flow)) {
			current = id;
			return;
		}
		current = '';
		// Once the overview is back, move to the first field.
		queueMicrotask(() => general?.querySelector<HTMLElement>('input, select')?.focus());
	}

	/** A step added with the "+" opens on its first setting. */
	function add(id: string) {
		form.added = [...form.added, id];
		current = def.groups.find((group) => group.id === id)?.parts[0] ?? '';
	}

	function remove(id: string) {
		const group = def.groups.find((candidate) => candidate.id === id);
		form.added = form.added.filter((other) => other !== id);
		if (group?.parts.includes(current)) current = '';
	}
</script>

{#snippet backToList()}
	<BackLink onclick={onback}>{t('sf.detail.back')}</BackLink>
{/snippet}

<PageHeader
	title={name}
	description={t(def.summary)}
	back={onback ? backToList : undefined}
	bind:titleElement
>
	{#snippet badges()}
		<Badge tone="info">{t(def.title)}</Badge>
		<AccountFlowStatus {ready} />
	{/snippet}
</PageHeader>

<div class="detail">
	<div class="detail__flow">
		<FlowCanvas label={name} heading={t(def.title)} detail={t(def.subtitle)}>
			<FlowEndpoint
				title={t(def.start.title)}
				detail={t(def.start.detail)}
				actionLabel={overview}
				onselect={() => (current = '')}
			/>
			<FlowEdge length={24} tip={false} />
			<FlowScope label={t('af.scope')}>
				<FlowSequence
					order={def.groups.map((group) => group.id)}
					visible={groups.map((group) => group.id)}
					lead={36}
					trail={6}
					menuTitle={name}
					option={(id) => {
						const group = def.groups.find((candidate) => candidate.id === id);
						return { id, label: group ? groupLabel(group) : id };
					}}
					onadd={add}
				>
					{#snippet step(id, { exiting })}
						{@const group = def.groups.find((candidate) => candidate.id === id)!}
						<FlowStepGroup
							name={groupLabel(group)}
							status={t(GROUP_STATUS[groupState(group, flow, form)])}
							state={groupState(group, flow, form)}
							required={groupState(group, flow, form) === 'required'}
							items={group.parts.map((part) => ({
								id: part,
								label: partLabel(part),
								status: t(STATUS[partState(part, flow, form)]),
								required: partState(part, flow, form) === 'required'
							}))}
							{current}
							onselect={(part) => (current = part)}
							onremove={group.optional ? () => remove(group.id) : undefined}
							{exiting}
						/>
					{/snippet}
				</FlowSequence>
			</FlowScope>
			<FlowEdge length={14} />
			<FlowEndpoint
				title={t(def.end.title)}
				detail={t(def.end.detail)}
				actionLabel={overview}
				onselect={() => (current = '')}
			/>
		</FlowCanvas>
	</div>

	<div class="detail__side">
		{#if current === ''}
			<!-- The flow's own settings are not part of the overview: a frame of their own above it. -->
			<div bind:this={general}>
				<Card title={t('af.general')}>
					<div class="detail__general">
						<AccountFlowStep part={aboutPart(flow)} bind:form />
					</div>
				</Card>
			</div>
		{/if}
		<section class="detail__panel" aria-label={current ? partLabel(current) : overview}>
			<PanelHeader title={current ? partLabel(current) : overview}>
				{#snippet back()}
					{#if current}<BackLink onclick={() => (current = '')}>{overview}</BackLink>{/if}
				{/snippet}
			</PanelHeader>
			<div class="detail__body">
				{#if current === ''}
					<p class="detail__lead">{t('af.contract.ui')}</p>
					<section class="detail__section" aria-labelledby="entered">
						<h3 class="detail__sub" id="entered">{t('sf.detail.entered')}</h3>
						<DetailList columns={1} ruled>
							{#each summaryRows(flow, form) as row, index (index)}
								<DetailItem label={row.label}>{row.value}</DetailItem>
							{/each}
						</DetailList>
					</section>
					<section class="detail__section" aria-labelledby="todo">
						<h3 class="detail__sub" id="todo">{t('sf.detail.todo')}</h3>
						{#if todo.length > 0}
							<ul class="todo">
								{#each todo as part (part.id)}
									<li>
										<Badge tone={part.state === 'required' ? 'warning' : 'neutral'} dot
											>{t(
												part.state === 'required' ? 'sf.value.required' : 'sf.status.todo'
											)}</Badge
										>
										<Button variant="ghost" size="sm" onclick={() => open(part.id)}
											>{part.label}</Button
										>
									</li>
								{/each}
							</ul>
						{:else}
							<Callout tone="info">{t('af.allSet')}</Callout>
						{/if}
					</section>
				{:else}
					<AccountFlowStep part={current} bind:form />
				{/if}
			</div>
		</section>
	</div>
</div>

<style>
	.detail {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr);
		gap: var(--space-columns);
		align-items: start;
	}

	@media (max-width: 900px) {
		.detail {
			grid-template-columns: minmax(0, 1fr);
		}
	}

	/* The frames of the right-hand side, one above the other. */
	.detail__side {
		display: flex;
		flex-direction: column;
		gap: var(--space-columns);
		min-width: 0;
	}

	.detail__general {
		display: flex;
		flex-direction: column;
		gap: var(--space-field);
	}

	.detail__panel {
		min-width: 0;
		border: 1px solid var(--border);
		border-radius: var(--radius-panel);
		background: var(--bg-card);
	}

	.detail__body {
		display: flex;
		flex-direction: column;
		gap: var(--space-field);
		padding: 16px 24px 24px;
	}

	.detail__section {
		display: flex;
		flex-direction: column;
		gap: var(--space-related);
	}

	.detail__sub {
		margin: 0;
		color: var(--text-secondary);
		font-size: var(--fs-label);
		font-weight: var(--fw-semibold);
	}

	.detail__lead {
		margin: 0;
		color: var(--text-secondary);
	}

	.todo {
		display: flex;
		flex-direction: column;
		gap: var(--space-related);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.todo li {
		display: flex;
		gap: var(--space-related);
		align-items: center;
	}
</style>
