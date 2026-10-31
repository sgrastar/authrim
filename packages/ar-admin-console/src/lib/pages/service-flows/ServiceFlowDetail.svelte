<script lang="ts">
	import { t, type MessageKey } from '$lib/i18n/i18n.svelte';
	import { tick, untrack } from 'svelte';
	import FlowCanvas from '$lib/ui/flow/FlowCanvas.svelte';
	import FlowEdge from '$lib/ui/flow/FlowEdge.svelte';
	import FlowEndpoint from '$lib/ui/flow/FlowEndpoint.svelte';
	import FlowScope from '$lib/ui/flow/FlowScope.svelte';
	import FlowSequence from '$lib/ui/flow/FlowSequence.svelte';
	import FlowStepGroup from '$lib/ui/flow/FlowStepGroup.svelte';
	import { revealPanel } from '$lib/ui/flow/reveal-panel';
	import Callout from '$lib/ui/patterns/Callout.svelte';
	import Card from '$lib/ui/patterns/Card.svelte';
	import DetailItem from '$lib/ui/patterns/DetailItem.svelte';
	import DetailList from '$lib/ui/patterns/DetailList.svelte';
	import PageHeader from '$lib/ui/patterns/PageHeader.svelte';
	import PanelHeader from '$lib/ui/patterns/PanelHeader.svelte';
	import Badge from '$lib/ui/primitives/Badge.svelte';
	import BackLink from '$lib/ui/primitives/BackLink.svelte';
	import RequiredBadge from '$lib/ui/primitives/RequiredBadge.svelte';
	import Button from '$lib/ui/primitives/Button.svelte';
	import { copyValue, Draft } from '$lib/ui/save/draft.svelte';
	import SaveScope from '$lib/ui/save/SaveScope.svelte';
	import {
		canActivate,
		EXTRA_PARTS,
		FLOW_GROUPS,
		GENERAL_PARTS,
		groupLabel,
		groupState,
		KIND_MARK,
		kindRole,
		KINDS_OF,
		labelOf,
		missingParts,
		nameOf,
		partState,
		reviewRows,
		SHARE_PART,
		stillToDo,
		visibleGroups,
		type Answers,
		type ConnectionKind,
		type PartState
	} from './connection-model';
	import ExtraSteps from './ExtraSteps.svelte';
	import InSteps from './InSteps.svelte';
	import RpSteps from './RpSteps.svelte';
	import SpSteps from './SpSteps.svelte';
	import UnsavedChangesDialog from './UnsavedChangesDialog.svelte';

	/**
	 * A connection's service flow: the screen the wizard hands over to. The wizard only helped with
	 * the first input, so this opens on the overview: what was entered, and what is still to do.
	 * On the left are the parts of the flow, top to bottom (the other side of the connection at one
	 * end, Authrim's own steps between, each with its settings and how far it has got); choosing
	 * one shows that setting on the right, as a form. The flow can grow: the "+" between steps adds
	 * an optional one (consent, an extra sign-in), and its × takes it away again. Dummy: nothing is
	 * saved anywhere.
	 */
	interface Props {
		answers: Answers;
		/** Back to the list of connections. */
		onback?: () => void;
		/** Move focus to the title when it appears (the wizard hands over to this screen). */
		focusTitle?: boolean;
	}

	let { answers = $bindable(), onback, focusTitle = false }: Props = $props();

	// What is on screen is a draft of the connection; `answers` (the saved one) changes only with
	// Save. "Activate" is not a setting but an action, so it takes effect at once (see below).
	const draft = new Draft<Answers>(untrack(() => answers));
	function save() {
		answers = copyValue(draft.value);
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

	const kind = $derived(draft.value.kind as ConnectionKind);
	const allGroups = $derived(FLOW_GROUPS[kind]);
	const groups = $derived(visibleGroups(draft.value));
	const incoming = $derived(KINDS_OF.in.includes(kind));
	const name = $derived(nameOf(draft.value));

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

	function statusOf(id: string): { text: string; state: PartState } {
		const state = partState(id, draft.value);
		if (id === 'activate')
			return { text: t(state === 'done' ? 'sf.status.active' : 'sf.status.notActive'), state };
		return { text: t(STATUS[state]), state };
	}

	const BLURB: Record<ConnectionKind, MessageKey> = {
		rp: 'sf.blurb.rp',
		sp: 'sf.blurb.sp',
		op: 'sf.blurb.op',
		idp: 'sf.blurb.idp'
	};
	// Words are looked up when shown, so a change of language reaches every one of them.
	const blurb = $derived(t(BLURB[kind]));
	const role = $derived(kindRole(kind));
	const overview = $derived(t('sf.detail.overview'));

	const missing = $derived(missingParts(draft.value));

	// Undoing something required (a mapping set put back to none), or a passed test no longer
	// holding (another provider, other credentials), takes the connection out of service until it
	// is activated again, instead of leaving it marked Active.
	$effect(() => {
		if (draft.value.active && !canActivate(draft.value)) draft.value.active = false;
	});
	const todo = $derived(stillToDo(draft.value));

	/** The connection's own settings (what the other side is), at the top of its settings. */
	let general = $state<HTMLElement | null>(null);

	/** A general setting is on the overview; any other setting opens on the right. */
	function open(id: string) {
		if (!GENERAL_PARTS[kind].includes(id)) {
			void select(id);
			return;
		}
		current = '';
		// Once the overview is back, move to the first field of that setting.
		queueMicrotask(() =>
			general
				?.querySelector<HTMLElement>(`[data-part="${id}"]`)
				?.querySelector<HTMLElement>('input, select, button')
				?.focus()
		);
	}

	/** Putting the connection into service is an action, not an edit: it needs no Save. */
	function activate() {
		// Only what is saved is put into service: with changes still unsaved, Save comes first.
		if (draft.dirty) return;
		draft.value.active = true;
		draft.saved.active = true;
		answers.active = true;
	}

	/** A step added with the "+" opens on its first setting. */
	function add(id: string) {
		draft.value.added = [...draft.value.added, id];
		void select(allGroups.find((group) => group.id === id)?.parts[0] ?? '');
	}

	function remove(id: string) {
		const group = allGroups.find((candidate) => candidate.id === id);
		draft.value.added = draft.value.added.filter((other) => other !== id);
		if (group?.parts.includes(current)) current = '';
	}
</script>

{#snippet backToList()}
	<BackLink onclick={goBack}>{t('sf.detail.back')}</BackLink>
{/snippet}

<SaveScope {draft} onsave={save}>
	<PageHeader
		title={name}
		description={blurb}
		back={onback ? backToList : undefined}
		bind:titleElement
	>
		{#snippet badges()}
			<Badge>{KIND_MARK[kind]}</Badge>
			<Badge tone="info">{role.badge}</Badge>
			<Badge tone={draft.value.active ? 'success' : 'warning'} dot
				>{t(draft.value.active ? 'sf.status.active' : 'sf.status.draft')}</Badge
			>
		{/snippet}
	</PageHeader>

	<div class="detail">
		<div class="detail__flow">
			<FlowCanvas label={name} heading={t('sf.detail.signIn')} detail={role.line}>
				{#if incoming}
					<FlowEndpoint
						kind="authrim"
						title={t('sf.detail.signInPage')}
						detail={t('sf.detail.peopleChoose', { name })}
					/>
				{:else}
					<FlowEndpoint
						title={name}
						detail={blurb}
						actionLabel={overview}
						onselect={() => (current = '')}
					/>
				{/if}
				<FlowEdge length={24} tip={false} />
				<FlowScope label={t('sf.detail.authrimDoes')}>
					<FlowSequence
						order={allGroups.map((group) => group.id)}
						visible={groups.map((group) => group.id)}
						lead={36}
						trail={6}
						menuTitle={name}
						option={(id) => {
							const group = allGroups.find((candidate) => candidate.id === id);
							return { id, label: group ? groupLabel(group) : id };
						}}
						onadd={add}
					>
						{#snippet step(id, { exiting })}
							{@const group = allGroups.find((candidate) => candidate.id === id)!}
							{@const state = groupState(group, draft.value)}
							<FlowStepGroup
								name={groupLabel(group)}
								{state}
								items={group.parts.map((part) => ({
									id: part,
									label: labelOf(part),
									status: statusOf(part).text,
									required: statusOf(part).state === 'required',
									state: statusOf(part).state
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
				{#if incoming}
					<FlowEndpoint
						title={name}
						detail={blurb}
						actionLabel={overview}
						onselect={() => (current = '')}
					/>
				{:else}
					<FlowEndpoint
						kind="authrim"
						title={t('sf.detail.yourUsers')}
						detail={t('sf.detail.whoSignsIn')}
					/>
				{/if}
			</FlowCanvas>
		</div>

		<div class="detail__side">
			{#if current === ''}
				<!-- What the other side is does not belong to the flow: a frame of its own above. -->
				<div bind:this={general}>
					<Card title={t('af.general')}>
						<div class="detail__general">
							{#key draft.value}
								{#each GENERAL_PARTS[kind] as part (part)}
									<section
										class="detail__section"
										data-part={part}
										aria-labelledby="general-{part}"
									>
										<h3 class="detail__sub" id="general-{part}">{labelOf(part)}</h3>
										{#if part.startsWith('rp-')}
											<RpSteps step={part} bind:form={draft.value.rp} />
										{:else if part.startsWith('sp-')}
											<SpSteps step={part} bind:form={draft.value.sp} />
										{:else}
											<InSteps step={part} bind:op={draft.value.op} bind:idp={draft.value.idp} />
										{/if}
									</section>
								{/each}
							{/key}
						</div>
					</Card>
				</div>
			{/if}
			<section
				class="detail__panel"
				bind:this={panel}
				aria-label={current ? labelOf(current) : overview}
			>
				<PanelHeader title={current ? labelOf(current) : overview}>
					{#snippet back()}
						{#if current}<BackLink onclick={() => (current = '')}>{overview}</BackLink>{/if}
					{/snippet}
				</PanelHeader>
				<div class="detail__body">
					{#key draft.value}
						{#if current === ''}
							{#if draft.value.active}
								<Callout tone="info">{t('sf.detail.active')}</Callout>
							{/if}
							<section class="detail__section" aria-labelledby="entered">
								<h3 class="detail__sub" id="entered">{t('sf.detail.entered')}</h3>
								<DetailList columns={1} ruled>
									{#each reviewRows(draft.value) as row (row.label)}
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
									<Callout tone="info"
										>{t('sf.detail.allSet', { step: labelOf('activate') })}</Callout
									>
								{/if}
							</section>
						{:else if current === 'activate'}
							{#if missing.length > 0}
								<Callout tone="warning"
									>{t('sf.detail.stillRequired', { list: missing.join(', ') })}</Callout
								>
							{:else if !canActivate(draft.value)}
								<Callout tone="info">{t('sf.detail.testFirst')}</Callout>
							{:else if draft.dirty}
								<Callout tone="info">{t('sf.detail.saveFirst')}</Callout>
							{/if}
							<p class="detail__lead">{t('sf.detail.enteredOnOverview')}</p>
							{#if draft.value.active}
								<Callout tone="info">{t('sf.detail.active')}</Callout>
							{:else}
								<div>
									<Button disabled={!canActivate(draft.value) || draft.dirty} onclick={activate}
										>{t('sf.detail.activate')}</Button
									>
								</div>
							{/if}
						{:else if EXTRA_PARTS.includes(current)}
							<ExtraSteps step={current} bind:form={draft.value.extras} outbound={!incoming} />
						{:else if current.startsWith('rp-')}
							<RpSteps step={current} bind:form={draft.value.rp} />
						{:else if current.startsWith('sp-')}
							<SpSteps step={current} bind:form={draft.value.sp} />
						{:else}
							<InSteps step={current} bind:op={draft.value.op} bind:idp={draft.value.idp} />
						{/if}
					{/key}
				</div>
			</section>
			{#if current === ''}
				<!-- What Authrim gives the other side is not a step of the flow: a frame of its own below. -->
				<Card title={labelOf(SHARE_PART[kind])}>
					<div class="detail__share">
						{#key draft.value}
							{#if kind === 'rp'}
								<RpSteps step={SHARE_PART.rp} bind:form={draft.value.rp} />
							{:else if kind === 'sp'}
								<SpSteps step={SHARE_PART.sp} bind:form={draft.value.sp} />
							{:else}
								<InSteps
									step={SHARE_PART[kind]}
									bind:op={draft.value.op}
									bind:idp={draft.value.idp}
								/>
							{/if}
						{/key}
					</div>
				</Card>
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
		gap: var(--space-columns);
	}

	/* The rows of a form are a field-gap apart, as in the wizard and in a panel. */
	.detail__general .detail__section {
		gap: var(--space-field);
	}

	.detail__share {
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
