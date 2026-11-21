<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import type {
		FederationEntity,
		FederationEntityRole,
		FederationEntityState,
		FederationKeywordCategory,
		FederationSourcesClient
	} from '#lib/api/federation-sources.js';
	import { formatNumber } from '#lib/ui/format.js';
	import { i18n, t } from '#lib/i18n/i18n.svelte.js';
	import ActionMenu, { type MenuAction } from '#lib/ui/primitives/ActionMenu.svelte';
	import Badge from '#lib/ui/primitives/Badge.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import Checkbox from '#lib/ui/primitives/Checkbox.svelte';
	import SearchField from '#lib/ui/primitives/SearchField.svelte';
	import Select from '#lib/ui/primitives/Select.svelte';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import Card from '#lib/ui/patterns/Card.svelte';
	import DataTable from '#lib/ui/patterns/DataTable.svelte';
	import FilterBar from '#lib/ui/patterns/FilterBar.svelte';
	import LoadingState from '#lib/ui/patterns/LoadingState.svelte';
	import { entityStateIn, setExcludedMany, toggleExcluded } from './federation-page-model';

	/**
	 * The federation's entities, searched, narrowed and paged on the server (a federation holds
	 * hundreds, so nothing is ever fetched whole). A row has the name over the entity ID, whether
	 * the entity takes part, is set aside (counting what is not saved yet) or has a connection of
	 * its own, and an actions menu to set it aside or take it back, or to give it a connection of
	 * its own. Rows can be selected to set several aside at once, and ordered by name. The
	 * keywords the entities carry (a location, an organization type) narrow the list: pick a kind,
	 * tick the values.
	 */
	interface Props {
		sourceId: string;
		client: FederationSourcesClient;
		/** The exception list being edited: toggling an entity changes it, saving is the page's. */
		excluded: string[];
		canEdit: boolean;
		/** Offer "make an individual connection"; absent: not offered. */
		onmaterialize?: (entity: FederationEntity) => void;
		/** Bump to read the page again (an entity was just given a connection of its own). */
		revision?: number;
		/** Only entities of this role are listed (the other side of the service flow's role). */
		onlyRole?: FederationEntityRole;
	}
	let {
		sourceId,
		client,
		excluded = $bindable(),
		canEdit,
		onmaterialize,
		revision = 0,
		onlyRole
	}: Props = $props();

	const PAGE_SIZES = [25, 50, 100];
	let query = $state('');
	let chosenRole = $state('');
	/** The role the service flow fixes, or the one picked in the filter. */
	const role = $derived(onlyRole ?? chosenRole);
	let stateFilter = $state('');
	let pageSize = $state(25);
	let sort = $state<{ key: string; direction: 'asc' | 'desc' } | null>(null);
	let selected = $state<string[]>([]);
	/** The keyword kind being narrowed by, and the values ticked in it. */
	let categories = $state<FederationKeywordCategory[]>([]);
	let kind = $state('');
	let keywords = $state<string[]>([]);
	/** The cursor each visited page was read with, so "previous" goes back without a page number. */
	let cursors = $state<(string | undefined)[]>([undefined]);
	let index = $state(0);
	let items = $state<FederationEntity[]>([]);
	let nextCursor = $state<string | null>(null);
	let total = $state(0);
	let lookup = $state(true);
	let phase = $state<'loading' | 'ready' | 'failed'>('loading');
	let full = $state(false);
	let generation = 0;
	let controller: AbortController | undefined;

	async function load() {
		const turn = ++generation;
		controller?.abort();
		controller = new AbortController();
		phase = 'loading';
		try {
			const page = await client.entities(
				sourceId,
				{
					q: query.trim() || undefined,
					role: (role || undefined) as FederationEntityRole | undefined,
					state: (stateFilter || undefined) as FederationEntityState | undefined,
					keywords: keywords.length > 0 ? keywords : undefined,
					sort: 'name',
					direction: sort?.direction ?? 'asc',
					limit: pageSize,
					cursor: cursors[index]
				},
				controller.signal
			);
			if (turn !== generation) return;
			items = page.items;
			nextCursor = page.nextCursor;
			total = page.total;
			lookup = page.explicitLookupAvailable;
			phase = 'ready';
		} catch (error) {
			if (turn !== generation || (error as Error)?.name === 'AbortError') return;
			phase = 'failed';
		}
	}
	/** How many keywords the server takes at once, and the longest one. */
	const MAX_KEYWORDS = 20;
	const MAX_KEYWORD_LENGTH = 256;
	let keywordTurn = 0;
	/**
	 * The keywords the entities of this role carry; a federation without any shows no filter.
	 * Only the latest read counts, and what was ticked that is no longer offered is dropped (the
	 * list is then read again without it).
	 */
	async function loadKeywords() {
		const turn = ++keywordTurn;
		let read: FederationKeywordCategory[];
		try {
			read = await client.entityKeywords(
				sourceId,
				{ role: (role || undefined) as FederationEntityRole | undefined },
				undefined
			);
		} catch {
			if (turn === keywordTurn) categories = [];
			return;
		}
		if (turn !== keywordTurn) return;
		categories = read;
		const offered = new Set(
			read.find((category) => category.type === kind)?.values.map((value) => value.value) ?? []
		);
		const kept = keywords.filter((keyword) => offered.has(keyword));
		if (!read.some((category) => category.type === kind)) kind = '';
		if (kept.length !== keywords.length) {
			keywords = kept;
			restart();
		}
	}
	/** A new search, filter, order or page size starts from the first page again. */
	function restart() {
		cursors = [undefined];
		index = 0;
		selected = [];
		void load();
	}
	function go(step: 1 | -1) {
		if (phase === 'loading') return;
		if (step === 1) {
			if (!nextCursor) return;
			cursors = [...cursors.slice(0, index + 1), nextCursor];
			index += 1;
		} else if (index > 0) index -= 1;
		// A selection is of the page in view: it is not carried to another.
		selected = [];
		void load();
	}
	onMount(() => {
		void load();
		void loadKeywords();
	});
	// The role of the federation can change under an open page (another administrator saved it):
	// the list and its keywords are read again for the new one, from the first page.
	let seenRole = untrack(() => onlyRole);
	$effect(() => {
		if (onlyRole === seenRole) return;
		seenRole = onlyRole;
		untrack(() => {
			keywords = [];
			kind = '';
			restart();
			void loadKeywords();
		});
	});
	let seenRevision = untrack(() => revision);
	$effect(() => {
		if (revision === seenRevision) return;
		seenRevision = revision;
		// A fetch or a new connection changed what is there: the list and its keywords again.
		untrack(() => {
			void load();
			void loadKeywords();
		});
	});
	$effect(() => () => controller?.abort());

	function toggle(entity: FederationEntity) {
		const result = toggleExcluded(excluded, entity.entityId);
		full = result.full;
		excluded = result.list;
	}
	/** Sets the selected entities aside or takes them back; one with a connection of its own is left. */
	function setSelected(on: boolean) {
		const ids = items
			.filter((entity) => selected.includes(entity.entityId) && !entity.explicitProviderId)
			.map((entity) => entity.entityId);
		const result = setExcludedMany(excluded, ids, on);
		full = result.left > 0;
		excluded = result.list;
		selected = [];
	}
	function pickKind(value: string) {
		kind = value;
		keywords = [];
		restart();
	}
	function tick(value: string, on: boolean) {
		keywords = on ? [...keywords, value] : keywords.filter((keyword) => keyword !== value);
		restart();
	}

	const number = (n: number) => formatNumber(n, i18n.locale);
	const from = $derived(total === 0 ? 0 : index * pageSize + 1);
	const to = $derived(Math.min(total, index * pageSize + items.length));
	const columns = $derived([
		{ key: 'name', label: t('sf.fed.entities.col.nameAndId'), sortable: true },
		...(onlyRole ? [] : [{ key: 'role', label: t('sf.fed.entities.col.role'), width: '120px' }]),
		{ key: 'state', label: t('sf.fed.entities.col.state'), width: '150px' },
		{ key: 'actions', label: t('sf.fed.entities.col.actions'), width: '72px', hideLabel: true }
	]);
	const roleOptions = $derived([
		{ value: '', label: t('sf.fed.entities.role.all') },
		{ value: 'saml_idp', label: t('sf.fed.entities.role.saml_idp') },
		{ value: 'saml_sp', label: t('sf.fed.entities.role.saml_sp') },
		{ value: 'ambiguous', label: t('sf.fed.entities.role.ambiguous') }
	]);
	const stateOptions = $derived([
		{ value: '', label: t('sf.fed.entities.state.all') },
		{ value: 'participating', label: t('sf.fed.entities.state.participating') },
		{ value: 'excluded', label: t('sf.fed.entities.state.excluded') },
		{ value: 'explicit', label: t('sf.fed.entities.state.explicit') }
	]);
	const kindOptions = $derived([
		{ value: '', label: t('sf.fed.entities.kw.none') },
		...categories.map((category) => ({ value: category.type, label: category.type }))
	]);
	/** What can be ticked: not a value the server would refuse for its length. */
	const kindValues = $derived(
		(categories.find((category) => category.type === kind)?.values ?? []).filter(
			(value) => value.value.length <= MAX_KEYWORD_LENGTH
		)
	);
	const keywordsFull = $derived(keywords.length >= MAX_KEYWORDS);
	const pageSizeOptions = PAGE_SIZES.map((size) => ({ value: String(size), label: String(size) }));
	const active = $derived(
		query.trim() !== '' || (!onlyRole && role !== '') || stateFilter !== '' || keywords.length > 0
	);

	function actionsOf(entity: FederationEntity, state: string): MenuAction[] {
		if (state === 'explicit') return [];
		return [
			...(canEdit
				? [
						{
							label: t(
								state === 'excluded' ? 'sf.fed.entities.include' : 'sf.fed.entities.exclude'
							),
							onselect: () => toggle(entity)
						}
					]
				: []),
			...(onmaterialize
				? [{ label: t('sf.fed.entities.materialize'), onselect: () => onmaterialize(entity) }]
				: [])
		];
	}
</script>

<Card title={t('sf.fed.entities.title')} description={t('sf.fed.entities.description')} flush>
	<div class="entities__filters">
		<FilterBar
			label={t('sf.fed.entities.title')}
			results={phase === 'ready' ? total : undefined}
			{active}
			onclear={() => {
				query = '';
				chosenRole = '';
				stateFilter = '';
				keywords = [];
				restart();
			}}
		>
			{#snippet search()}
				<SearchField
					size="sm"
					label={t('sf.fed.entities.search')}
					placeholder={t('sf.fed.entities.search')}
					bind:value={query}
					onsearch={restart}
				/>
			{/snippet}
			{#if !onlyRole}
				<Select
					size="sm"
					hideLabel
					label={t('sf.fed.entities.col.role')}
					options={roleOptions}
					bind:value={chosenRole}
					onchange={() => {
						keywords = [];
						kind = '';
						restart();
						void loadKeywords();
					}}
				/>
			{/if}
			<Select
				size="sm"
				hideLabel
				label={t('sf.fed.entities.col.state')}
				options={stateOptions}
				bind:value={stateFilter}
				onchange={restart}
			/>
		</FilterBar>
		{#if categories.length > 0}
			<div class="kw">
				<div class="kw__kind">
					<Select
						size="sm"
						label={t('sf.fed.entities.kw.category')}
						options={kindOptions}
						value={kind}
						onchange={pickKind}
					/>
				</div>
				{#if kind}
					<div
						class="kw__values"
						role="group"
						aria-label={t('sf.fed.entities.kw.values', { kind })}
					>
						{#each kindValues as value (value.value)}
							<Checkbox
								checked={keywords.includes(value.value)}
								disabled={keywordsFull && !keywords.includes(value.value)}
								onchange={(event) => tick(value.value, event.currentTarget.checked)}
							>
								{value.label}
								<span class="kw__count">{number(value.count)}</span>
							</Checkbox>
						{/each}
					</div>
					{#if keywordsFull}<p class="kw__limit">
							{t('sf.fed.entities.kw.limit', { max: MAX_KEYWORDS })}
						</p>{/if}
				{/if}
			</div>
		{/if}
	</div>
	{#if !lookup}<Callout tone="info">{t('sf.fed.entities.noLookup')}</Callout>{/if}
	{#if full}<Callout tone="warning" live>{t('sf.fed.entities.full')}</Callout>{/if}
	{#if phase === 'failed'}
		<Callout tone="warning" live>
			{t('sf.fed.entities.failed')}
			<Button size="sm" onclick={load}>{t('common.retry')}</Button>
		</Callout>
	{:else if phase === 'loading' && items.length === 0}
		<LoadingState label={t('common.loading')} />
	{:else}
		<!-- The rows scroll in their own frame, so the filters above and the pager below stay in reach. -->
		<!-- A scrolling frame takes the keyboard (arrow keys) even when no row has a control. -->
		<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
		<div
			class="entities__scroll"
			role="region"
			tabindex="0"
			aria-label={t('sf.fed.entities.title')}
		>
			<DataTable
				{columns}
				rows={items}
				rowKey={(entity) => entity.entityId}
				caption={t('sf.fed.entities.title')}
				selectable={canEdit}
				bind:selected
				rowLabel={(entity) => entity.displayName ?? entity.entityId}
				bind:sort
				onsort={restart}
				minWidth="0"
			>
				{#snippet bulkActions()}
					<Button size="sm" variant="secondary" onclick={() => setSelected(true)}
						>{t('sf.fed.entities.bulk.exclude')}</Button
					>
					<Button size="sm" variant="secondary" onclick={() => setSelected(false)}
						>{t('sf.fed.entities.bulk.include')}</Button
					>
				{/snippet}
				{#snippet cell(entity, column)}
					{@const state = entityStateIn(entity, excluded)}
					{#if column.key === 'name'}
						<span class="entities__name" title={entity.displayName ?? entity.entityId}
							>{entity.displayName ?? '—'}</span
						>
						<code dir="ltr" class="entities__id" title={entity.entityId}>{entity.entityId}</code>
						{#if entity.registrationAuthority || entity.validUntil}
							<span class="entities__meta">
								{#if entity.registrationAuthority}<span
										dir="ltr"
										title={t('sf.fed.entities.col.authority')}>{entity.registrationAuthority}</span
									>{/if}
								{#if entity.validUntil}<span title={t('sf.fed.entities.col.validUntil')}
										>{entity.validUntil.slice(0, 10)}</span
									>{/if}
							</span>
						{/if}
					{:else if column.key === 'role'}
						<Badge tone="neutral">{t(`sf.fed.entities.role.${entity.role}`)}</Badge>
					{:else if column.key === 'state'}
						{#if state === 'explicit' && entity.explicitProviderId}
							<a
								class="entities__link"
								href="/admin/applications/all/{entity.explicitProviderType ??
									(entity.role === 'saml_sp' ? 'sp' : 'idp')}/{encodeURIComponent(
									entity.explicitProviderId
								)}">{t('sf.fed.entities.state.explicitLink')}</a
							>
						{:else if state === 'participating' && !entity.policyAllowed}
							<Badge tone="neutral" dot>{t('sf.fed.entities.state.policy')}</Badge>
						{:else}
							<Badge tone={state === 'excluded' ? 'warning' : 'success'} dot
								>{t(`sf.fed.entities.state.${state}`)}</Badge
							>
						{/if}
					{:else if column.key === 'actions'}
						{@const actions = actionsOf(entity, state)}
						{#if actions.length > 0}
							<ActionMenu
								size="sm"
								label={t('sf.fed.entities.actionsFor', {
									name: entity.displayName ?? entity.entityId
								})}
								{actions}
							/>
						{/if}
					{/if}
				{/snippet}
				{#snippet empty()}{t('sf.fed.entities.empty')}{/snippet}
			</DataTable>
		</div>
		<nav class="entities__pager" aria-label={t('sf.fed.entities.pager')}>
			<span aria-live="polite"
				>{t('sf.fed.entities.range', {
					from: number(from),
					to: number(to),
					total: number(total)
				})}</span
			>
			<Select
				size="sm"
				inline
				label={t('sf.fed.entities.perPage')}
				options={pageSizeOptions}
				value={String(pageSize)}
				onchange={(value) => {
					pageSize = Number(value);
					restart();
				}}
			/>
			<Button
				size="sm"
				variant="secondary"
				disabled={index === 0 || phase === 'loading'}
				onclick={() => go(-1)}>{t('sf.fed.entities.previous')}</Button
			>
			<Button
				size="sm"
				variant="secondary"
				disabled={!nextCursor || phase === 'loading'}
				onclick={() => go(1)}>{t('sf.fed.entities.next')}</Button
			>
		</nav>
	{/if}
</Card>

<style>
	.entities__filters {
		display: grid;
		gap: var(--space-grid);
		padding: var(--space-grid);
	}

	.kw {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-grid);
		align-items: flex-start;
	}

	.kw__kind {
		min-width: 200px;
	}

	.kw__values {
		display: flex;
		flex: 1;
		flex-wrap: wrap;
		gap: 6px 10px;
		min-width: 0;
	}

	.kw__limit {
		flex-basis: 100%;
		margin: 0;
		color: var(--text-secondary);
		font-size: var(--fs-small);
	}

	.kw__count {
		margin-inline-start: 4px;
		color: var(--text-secondary);
		font-size: var(--fs-small);
	}

	/* Two lines a row, the name over the address; what does not fit is cut with an ellipsis (the
	   whole of it is the tooltip) rather than wrapped, and never makes the table scroll. */
	.entities__scroll {
		max-height: min(60vh, 640px);
		overflow: auto;
	}

	/* The frame is the scroll container (the table's own wrapper must not become one), and the
	   header stays put while the rows move. */
	.entities__scroll :global(.table-wrap) {
		overflow: visible;
	}

	.entities__scroll :global(thead th) {
		position: sticky;
		inset-block-start: 0;
		z-index: 1;
	}

	.entities__name,
	.entities__id,
	.entities__meta {
		display: block;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.entities__name {
		font-weight: var(--fw-strong, 600);
	}

	.entities__id {
		color: var(--text-secondary);
		font-size: var(--fs-small);
	}

	.entities__meta {
		display: flex;
		gap: 12px;
		color: var(--text-secondary);
		font-size: var(--fs-small);
	}

	.entities__link {
		color: var(--primary);
	}

	.entities__pager {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-grid);
		align-items: center;
		justify-content: flex-end;
		padding: var(--space-grid);
		color: var(--text-secondary);
		font-size: var(--fs-small);
	}
</style>
