<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import type {
		FederationEntity,
		FederationEntityRole,
		FederationEntityState,
		FederationSourcesClient
	} from '#lib/api/federation-sources.js';
	import { formatNumber } from '#lib/ui/format.js';
	import { i18n, t } from '#lib/i18n/i18n.svelte.js';
	import Badge from '#lib/ui/primitives/Badge.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import SearchField from '#lib/ui/primitives/SearchField.svelte';
	import Select from '#lib/ui/primitives/Select.svelte';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import Card from '#lib/ui/patterns/Card.svelte';
	import DataTable from '#lib/ui/patterns/DataTable.svelte';
	import FilterBar from '#lib/ui/patterns/FilterBar.svelte';
	import LoadingState from '#lib/ui/patterns/LoadingState.svelte';
	import { entityStateIn, toggleExcluded } from './federation-page-model';

	/**
	 * The federation's entities, searched and paged on the server (a federation holds hundreds,
	 * so nothing is ever fetched whole). Each row says whether the entity takes part, is set aside
	 * (counting what is not saved yet) or has a connection of its own, and offers to set it aside
	 * or take it back, or to give it a connection of its own.
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
	}
	let {
		sourceId,
		client,
		excluded = $bindable(),
		canEdit,
		onmaterialize,
		revision = 0
	}: Props = $props();

	const PAGE_SIZES = [25, 50, 100];
	let query = $state('');
	let role = $state('');
	let stateFilter = $state('');
	let pageSize = $state(25);
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
	/** A new search, filter or page size starts from the first page again. */
	function restart() {
		cursors = [undefined];
		index = 0;
		void load();
	}
	function go(step: 1 | -1) {
		if (phase === 'loading') return;
		if (step === 1) {
			if (!nextCursor) return;
			cursors = [...cursors.slice(0, index + 1), nextCursor];
			index += 1;
		} else if (index > 0) index -= 1;
		void load();
	}
	onMount(() => void load());
	let seenRevision = untrack(() => revision);
	$effect(() => {
		if (revision === seenRevision) return;
		seenRevision = revision;
		untrack(() => void load());
	});
	$effect(() => () => controller?.abort());

	function toggle(entity: FederationEntity) {
		const result = toggleExcluded(excluded, entity.entityId);
		full = result.full;
		excluded = result.list;
	}

	const number = (n: number) => formatNumber(n, i18n.locale);
	const from = $derived(total === 0 ? 0 : index * pageSize + 1);
	const to = $derived(Math.min(total, index * pageSize + items.length));
	const columns = $derived([
		{ key: 'name', label: t('sf.fed.entities.col.name') },
		{ key: 'entityId', label: t('sf.fed.entities.col.entityId') },
		{ key: 'role', label: t('sf.fed.entities.col.role'), width: '120px' },
		{ key: 'authority', label: t('sf.fed.entities.col.authority') },
		{ key: 'validUntil', label: t('sf.fed.entities.col.validUntil'), width: '150px' },
		{ key: 'state', label: t('sf.fed.entities.col.state'), width: '170px' },
		{ key: 'actions', label: t('sf.fed.entities.col.actions'), width: '240px', hideLabel: true }
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
	const pageSizeOptions = PAGE_SIZES.map((size) => ({ value: String(size), label: String(size) }));
	const active = $derived(query.trim() !== '' || role !== '' || stateFilter !== '');
</script>

<Card title={t('sf.fed.entities.title')} description={t('sf.fed.entities.description')} flush>
	<div class="entities__filters">
		<FilterBar
			label={t('sf.fed.entities.title')}
			results={phase === 'ready' ? total : undefined}
			{active}
			onclear={() => {
				query = '';
				role = '';
				stateFilter = '';
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
			<Select
				size="sm"
				hideLabel
				label={t('sf.fed.entities.col.role')}
				options={roleOptions}
				bind:value={role}
				onchange={restart}
			/>
			<Select
				size="sm"
				hideLabel
				label={t('sf.fed.entities.col.state')}
				options={stateOptions}
				bind:value={stateFilter}
				onchange={restart}
			/>
		</FilterBar>
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
		<DataTable
			{columns}
			rows={items}
			rowKey={(entity) => entity.entityId}
			caption={t('sf.fed.entities.title')}
			dense
		>
			{#snippet cell(entity, column)}
				{@const state = entityStateIn(entity, excluded)}
				{#if column.key === 'name'}
					<strong>{entity.displayName ?? '—'}</strong>
				{:else if column.key === 'entityId'}
					<code dir="ltr" class="entities__id">{entity.entityId}</code>
				{:else if column.key === 'role'}
					<Badge tone="neutral">{t(`sf.fed.entities.role.${entity.role}`)}</Badge>
				{:else if column.key === 'authority'}
					<span dir="ltr">{entity.registrationAuthority ?? '—'}</span>
				{:else if column.key === 'validUntil'}
					{entity.validUntil ? entity.validUntil.slice(0, 10) : '—'}
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
					<span class="entities__actions">
						{#if canEdit && state !== 'explicit'}
							<Button size="sm" variant="ghost" onclick={() => toggle(entity)}
								>{t(
									state === 'excluded' ? 'sf.fed.entities.include' : 'sf.fed.entities.exclude'
								)}</Button
							>
						{/if}
						{#if onmaterialize && state !== 'explicit'}
							<Button size="sm" variant="ghost" onclick={() => onmaterialize(entity)}
								>{t('sf.fed.entities.materialize')}</Button
							>
						{/if}
					</span>
				{/if}
			{/snippet}
			{#snippet empty()}{t('sf.fed.entities.empty')}{/snippet}
		</DataTable>
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
		padding: var(--space-grid);
	}

	.entities__id {
		overflow-wrap: anywhere;
		font-size: var(--fs-small);
	}

	.entities__actions {
		display: inline-flex;
		flex-wrap: wrap;
		gap: var(--space-related);
		justify-content: flex-end;
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
