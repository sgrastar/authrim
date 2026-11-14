<script lang="ts">
	import { t, type MessageKey } from '#lib/i18n/i18n.svelte.js';
	import { tick, untrack } from 'svelte';
	import FlowCanvas from '#lib/ui/flow/FlowCanvas.svelte';
	import FlowEdge from '#lib/ui/flow/FlowEdge.svelte';
	import FlowEndpoint from '#lib/ui/flow/FlowEndpoint.svelte';
	import FlowScope from '#lib/ui/flow/FlowScope.svelte';
	import FlowSequence from '#lib/ui/flow/FlowSequence.svelte';
	import FlowStepGroup from '#lib/ui/flow/FlowStepGroup.svelte';
	import { revealPanel } from '#lib/ui/flow/reveal-panel.js';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import Card from '#lib/ui/patterns/Card.svelte';
	import DetailItem from '#lib/ui/patterns/DetailItem.svelte';
	import DetailList from '#lib/ui/patterns/DetailList.svelte';
	import PageHeader from '#lib/ui/patterns/PageHeader.svelte';
	import PanelHeader from '#lib/ui/patterns/PanelHeader.svelte';
	import Badge from '#lib/ui/primitives/Badge.svelte';
	import BackLink from '#lib/ui/primitives/BackLink.svelte';
	import RequiredBadge from '#lib/ui/primitives/RequiredBadge.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import { copyValue, Draft } from '#lib/ui/save/draft.svelte.js';
	import SaveScope from '#lib/ui/save/SaveScope.svelte';
	import {
		aboutPart,
		FLOWS,
		flowName,
		generalParts,
		groupDef,
		groupLabel,
		partDef,
		groupState,
		isSyncFlow,
		isReady,
		partLabel,
		partTitle,
		titleKey,
		partState,
		stillToDo,
		summaryRows,
		stepOrder,
		visibleGroups,
		type FlowId,
		type AccountFlowState,
		type PartState
	} from './account-flow-model';
	import RunNowCard from './RunNowCard.svelte';
	import UnsavedChangesDialog from './UnsavedChangesDialog.svelte';
	import AccountFlowStatus from './AccountFlowStatus.svelte';
	import AccountFlowStep from './AccountFlowStep.svelte';
	import { isExitKeyOf } from './screen-exits';
	import IconButton from '#lib/ui/primitives/IconButton.svelte';
	import TitleEditor from '#lib/ui/patterns/TitleEditor.svelte';

	/**
	 * A sign-up or sign-in flow: the same contract wherever it is used (the Login UI, a separate
	 * login screen, a UI of your own, or one connection), told apart by its name and its place. Laid out like a connection's flow: the caller at both ends, Authrim's own steps
	 * between (each with its settings and how far it has got), and the chosen setting on the right.
	 * It opens on the overview. The optional step (consent at sign-up, an additional sign-in) is
	 * added with the flow's "+" and taken away with its ×. Dummy: nothing is saved anywhere.
	 */
	interface Props {
		flow: FlowId;
		form: AccountFlowState;
		/** Back to the list of flows. */
		onback?: () => void;
		/** Move focus to the title when it appears. */
		focusTitle?: boolean;
		/**
		 * Saves the flow where it lives (the sign-up flow on the live page: its Flow, published).
		 * Absent: it is kept in the page only. A failure is shown, and the draft is kept.
		 */
		onsave?: (state: AccountFlowState) => Promise<void>;
		/** The sign-in cannot hold consent (no completion to put it before): its setting is shown disabled. */
		consentUnavailable?: boolean;
	}

	let {
		flow,
		form = $bindable(),
		onback,
		focusTitle = false,
		onsave,
		consentUnavailable = false
	}: Props = $props();

	// What is on screen is a draft of the flow; `form` (the saved flow) changes only with Save.
	const draft = new Draft<AccountFlowState>(untrack(() => form));
	async function save() {
		const saved = copyValue(draft.value);
		await onsave?.(saved);
		form = saved;
	}

	let asking = $state(false);
	/** Going back in place asks first when there are unsaved changes. */
	function goBack() {
		if (draft.dirty) asking = true;
		else onback?.();
	}

	let titleElement = $state<HTMLHeadingElement | null>(null);
	$effect(() => {
		if (focusTitle) titleElement?.focus();
	});

	const def = $derived(FLOWS[flow]);
	const groups = $derived(visibleGroups(flow, draft.value));
	const name = $derived(flowName(flow, draft.value));
	const ready = $derived(isReady(flow, draft.value));
	const todo = $derived(stillToDo(flow, draft.value));
	const overview = $derived(t('sf.detail.overview'));
	/** Settings for the whole flow, shown in place of the overview when the flow has them. */
	const general = $derived(generalParts(flow));
	/** What the right-hand side shows when no setting is open: the general settings or the overview. */
	const home = $derived(general.length > 0 ? t('af.group.general') : overview);

	/** The setting shown on the right; empty is the overview. */
	let current = $state('');
	let panel = $state<HTMLElement | null>(null);

	/** Opens a setting on the right, and brings the page up to it if the flow had scrolled away. */
	async function select(id: string) {
		current = id;
		await tick();
		revealPanel(panel);
	}

	const STATUS: Record<PartState, MessageKey> = {
		done: 'sf.status.done',
		required: 'sf.status.todo',
		todo: 'sf.status.todo'
	};

	/** The flow's own settings, at the top of the overview. */
	let about = $state<HTMLElement | null>(null);

	/** The flow's own settings are on the overview; any other setting opens on the right. */
	function open(id: string) {
		if (id !== aboutPart(flow)) {
			void select(id);
			return;
		}
		current = '';
		// Once the overview is back, move to the first field.
		queueMicrotask(() => about?.querySelector<HTMLElement>('input, select')?.focus());
	}

	/** A step added with the "+" opens on its first setting. */
	function add(id: string) {
		draft.value.added = [...draft.value.added, id];
		void select(groupDef(flow, id)?.parts[0] ?? '');
	}

	/** The title of the setting open on the right is being edited. */
	let editingTitle = $state(false);
	let editTitleButton = $state<HTMLButtonElement>();
	const renamable = $derived(current !== '' && partDef(current).renamable === true);
	$effect(() => {
		// Another setting opened: an edit of the one before is dropped.
		void current;
		editingTitle = false;
	});
	function finishTitle(value: string) {
		// The default name is not kept as a title of its own: it follows the language.
		if (value === partLabel(current)) delete draft.value.values[titleKey(current)];
		else draft.value.values[titleKey(current)] = value;
		closeTitle();
	}
	function closeTitle() {
		editingTitle = false;
		void tick().then(() => editTitleButton?.focus());
	}

	function remove(id: string) {
		const group = groupDef(flow, id);
		draft.value.added = draft.value.added.filter((other) => other !== id);
		// A step of a repeatable group takes its settings with it (another one starts unset).
		if (group?.repeatable) {
			for (const part of group.parts) {
				delete draft.value.values[titleKey(part)];
				for (const field of partDef(part).fields) {
					delete draft.value.values[field.key];
					// And where the ways out of the screen it chose led.
					for (const key of Object.keys(draft.value.values)) {
						if (isExitKeyOf(field.key, key)) delete draft.value.values[key];
					}
				}
			}
		}
		// A way out of another screen that led to it goes on to the next step again.
		for (const [key, value] of Object.entries(draft.value.values)) {
			if (key.includes('>') && value === id) delete draft.value.values[key];
		}
		if (group?.parts.includes(current)) current = '';
	}
</script>

{#snippet titleAction()}
	<IconButton
		icon="pencil"
		size="sm"
		label={t('af.title.edit')}
		bind:element={editTitleButton}
		onclick={() => (editingTitle = true)}
	/>
{/snippet}

{#snippet titleEditor()}
	<TitleEditor
		value={partTitle(current, draft.value)}
		label={t('af.title.label')}
		hint={t('af.title.hint')}
		requiredMessage={t('af.title.required')}
		maxlength={40}
		doneLabel={t('af.title.done')}
		ondone={finishTitle}
		oncancel={closeTitle}
	/>
{/snippet}

{#snippet backToList()}
	<BackLink onclick={goBack}>{t('sf.detail.back')}</BackLink>
{/snippet}

<SaveScope {draft} onsave={save}>
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
					actionLabel={home}
					onselect={() => (current = '')}
				/>
				<FlowEdge length={24} tip={false} />
				<FlowScope label={t('af.scope')}>
					<FlowSequence
						order={stepOrder(flow, draft.value)}
						visible={groups.map((group) => group.id)}
						lead={36}
						trail={6}
						menuTitle={name}
						option={(id) => {
							const group = groupDef(flow, id);
							if (!group) return { id, label: id };
							// Another screen by the name its setting will have ("Screen 2").
							const named = group.parts.length === 1 && partDef(group.parts[0]).renamable;
							return {
								id,
								label: named ? partTitle(group.parts[0], draft.value) : groupLabel(group)
							};
						}}
						onadd={add}
					>
						{#snippet step(id, { exiting })}
							{@const group = groupDef(flow, id)!}
							<!-- One of several of a kind (a screen, a consent step) goes by its setting's name too. -->
							{@const named =
								group.parts.length === 1 &&
								(partDef(group.parts[0]).renamable || group.repeatable !== undefined)}
							<FlowStepGroup
								name={groupLabel(group)}
								label={named
									? `${groupLabel(group)}: ${partTitle(group.parts[0], draft.value)}`
									: undefined}
								state={groupState(group, flow, draft.value)}
								items={group.parts.map((part) => ({
									id: part,
									label: partTitle(part, draft.value),
									status: t(STATUS[partState(part, flow, draft.value)]),
									required: partState(part, flow, draft.value) === 'required',
									state: partState(part, flow, draft.value)
								}))}
								{current}
								onselect={select}
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
					actionLabel={home}
					onselect={() => (current = '')}
				/>
			</FlowCanvas>
		</div>

		<div class="detail__side">
			{#if current === ''}
				<!-- The flow's own settings are not part of the overview: a frame of their own above it. -->
				<div bind:this={about}>
					<Card title={t('af.general')}>
						<div class="detail__general">
							<AccountFlowStep part={aboutPart(flow)} bind:form={draft.value} />
						</div>
					</Card>
				</div>
			{/if}
			{#if current === '' && general.length > 0}
				<!-- Settings for the whole flow, not one of its steps: they take the overview's place,
				     each in a frame of its own. -->
				{#each general as part (part)}
					<Card title={partLabel(part)}>
						<div class="detail__general">
							<AccountFlowStep {part} bind:form={draft.value} />
						</div>
					</Card>
				{/each}
			{:else}
				<section
					class="detail__panel"
					bind:this={panel}
					aria-label={current ? partTitle(current, draft.value) : overview}
				>
					<PanelHeader
						title={current ? partTitle(current, draft.value) : overview}
						titleAction={renamable && !editingTitle ? titleAction : undefined}
						titleEditor={renamable && editingTitle ? titleEditor : undefined}
					>
						{#snippet back()}
							{#if current}<BackLink onclick={() => (current = '')}>{home}</BackLink>{/if}
						{/snippet}
					</PanelHeader>
					<div class="detail__body">
						{#if current === ''}
							{#if !isSyncFlow(flow)}<p class="detail__lead">{t('af.contract.ui')}</p>{/if}
							<section class="detail__section" aria-labelledby="entered">
								<h3 class="detail__sub" id="entered">{t('sf.detail.entered')}</h3>
								<DetailList columns={1} ruled>
									{#each summaryRows(flow, draft.value) as row, index (index)}
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
												{#if part.state === 'required'}<RequiredBadge />{:else}<Badge
														tone="neutral"
														dot>{t('sf.status.todo')}</Badge
													>{/if}
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
							<AccountFlowStep part={current} bind:form={draft.value} {flow} {consentUnavailable} />
						{/if}
					</div>
				</section>
			{/if}
			{#if current === '' && def.run}
				<!-- Running it is not a step of the flow: a frame of its own below the overview. -->
				<RunNowCard kind={def.run} {ready} />
			{/if}
		</div>
	</div>
</SaveScope>

<UnsavedChangesDialog
	open={asking}
	onleave={() => {
		asking = false;
		draft.discard();
		onback?.();
	}}
	onstay={() => (asking = false)}
/>

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
