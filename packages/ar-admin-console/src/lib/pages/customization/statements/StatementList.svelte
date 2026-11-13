<script lang="ts">
	import { untrack } from 'svelte';
	import { ApiError } from '#lib/api/api-error.js';
	import type {
		ConsentStatementListItem,
		ConsentStatementsClient,
		ConsentUsages
	} from '#lib/api/consent-statements.js';
	import { i18n, t, type MessageKey } from '#lib/i18n/i18n.svelte.js';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import Card from '#lib/ui/patterns/Card.svelte';
	import CellText from '#lib/ui/patterns/CellText.svelte';
	import DataTable, { type Column, type SortState } from '#lib/ui/patterns/DataTable.svelte';
	import EmptyState from '#lib/ui/patterns/EmptyState.svelte';
	import FilterBar from '#lib/ui/patterns/FilterBar.svelte';
	import LoadingState from '#lib/ui/patterns/LoadingState.svelte';
	import PageHeader from '#lib/ui/patterns/PageHeader.svelte';
	import { sortRows } from '#lib/ui/patterns/table-sort.js';
	import Badge from '#lib/ui/primitives/Badge.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import SearchField from '#lib/ui/primitives/SearchField.svelte';
	import Page from '#lib/ui/templates/Page.svelte';
	import DateTime from '#lib/ui/time/DateTime.svelte';
	import {
		categoryKind,
		listItemStatus,
		statementName,
		versionLabel,
		type StatementStatus
	} from './statement-model';

	/**
	 * Customization → Consent statements: the documents people agree to, with the name (the
	 * title of the current version), the kind, the current version and its date, whether it is on,
	 * and where it is used. A row opens the statement's page, which lists the places.
	 */
	interface Props {
		client: ConsentStatementsClient;
		canWrite: boolean;
		/** Where a statement's page is (`new` for a new one). */
		hrefOf: (id: string) => string;
		onopen: (id: string) => void;
	}

	let { client, canWrite, hrefOf, onopen }: Props = $props();

	let items = $state<ConsentStatementListItem[]>([]);
	/** Null when the API could not say where statements are used. */
	let usages = $state<ConsentUsages | null>(null);
	let phase = $state<'loading' | 'ready' | 'forbidden' | 'failed'>('loading');
	let query = $state('');
	let sort = $state<SortState | null>(null);

	async function load() {
		phase = 'loading';
		try {
			const [list, used] = await Promise.all([client.list(), client.usages().catch(() => null)]);
			items = list;
			usages = used;
			phase = 'ready';
		} catch (error) {
			phase = error instanceof ApiError && error.status === 403 ? 'forbidden' : 'failed';
		}
	}

	$effect(() => {
		untrack(() => void load());
	});

	const nameOf = (item: ConsentStatementListItem) =>
		statementName(item.titles, i18n.locale, item.statement.slug);
	const kindLabel = (item: ConsentStatementListItem) =>
		t(`cs.kind.${categoryKind(item.statement.category)}` as MessageKey);
	const usageCount = (item: ConsentStatementListItem) => {
		const used = usages?.byStatement[item.statement.id];
		return used ? used.flows.length + used.services.length : 0;
	};
	const usageText = (item: ConsentStatementListItem) => {
		if (!usages) return '—';
		const count = usageCount(item);
		if (count === 0) return usages.complete ? t('cs.usage.none') : t('cs.usage.noneKnown');
		const text = t('cs.usage.count', { n: count });
		return usages.complete ? text : t('cs.usage.atLeast', { count: text });
	};
	const TONE: Record<StatementStatus, 'success' | 'neutral' | 'warning'> = {
		active: 'success',
		inactive: 'neutral',
		draftOnly: 'warning'
	};

	function sortValue(item: ConsentStatementListItem, key: string): string | number {
		switch (key) {
			case 'name':
				return nameOf(item);
			case 'kind':
				return kindLabel(item);
			case 'current':
				return item.current?.version ?? '';
			case 'status':
				return listItemStatus(item);
			default:
				return usageCount(item);
		}
	}

	const shown = $derived.by(() => {
		const needle = query.trim().toLowerCase();
		return items.filter(
			(item) =>
				!needle ||
				nameOf(item).toLowerCase().includes(needle) ||
				item.statement.slug.toLowerCase().includes(needle)
		);
	});
	const rows = $derived(sortRows(shown, sort, sortValue, i18n.locale));
	const columns = $derived([
		{ key: 'name', label: t('cs.list.col.name'), sortable: true },
		{ key: 'kind', label: t('cs.list.col.kind'), width: '160px', sortable: true },
		{ key: 'current', label: t('cs.list.col.current'), width: '220px', sortable: true },
		{ key: 'status', label: t('cs.list.col.status'), width: '140px', sortable: true },
		{ key: 'usage', label: t('cs.list.col.usage'), width: '160px', sortable: true }
	]);
</script>

{#snippet cell(row: ConsentStatementListItem, column: Column)}
	{#if column.key === 'name'}
		<CellText title={nameOf(row)} description={row.statement.slug}>
			{#if row.hasDraft && row.current}<Badge tone="info">{t('cs.status.hasDraft')}</Badge>{/if}
		</CellText>
	{:else if column.key === 'kind'}
		{kindLabel(row)}
	{:else if column.key === 'current'}
		{#if row.current}
			<CellText title={versionLabel(row.current.version)}>
				<DateTime value={row.current.effective_at} style="date" />
			</CellText>
		{:else}
			—
		{/if}
	{:else if column.key === 'status'}
		<Badge tone={TONE[listItemStatus(row)]} dot>
			{t(`cs.status.${listItemStatus(row)}` as MessageKey)}
		</Badge>
	{:else if column.key === 'usage'}
		{usageText(row)}
	{/if}
{/snippet}

<Page>
	<PageHeader title={t('nav.custom.statements')} description={t('cs.list.intro')}>
		{#snippet actions()}
			{#if canWrite}
				<Button variant="primary" icon="plus" href={hrefOf('new')}>{t('cs.list.create')}</Button>
			{/if}
		{/snippet}
	</PageHeader>

	{#if phase === 'loading'}
		<LoadingState label={t('common.loading')} />
	{:else if phase === 'forbidden'}
		<EmptyState icon="lock" title={t('cs.list.noAccess')} />
	{:else if phase === 'failed'}
		<EmptyState icon="warningCircle" title={t('cs.list.loadFailed')}>
			{#snippet action()}
				<Button size="sm" onclick={load}>{t('common.retry')}</Button>
			{/snippet}
		</EmptyState>
	{:else}
		{#if usages === null}
			<Callout tone="warning">{t('cs.usage.unknown')}</Callout>
		{:else if !usages.complete}
			<Callout tone="warning">{t('cs.usage.incomplete')}</Callout>
		{/if}
		<FilterBar
			label={t('cs.list.title')}
			results={shown.length}
			active={query.trim() !== ''}
			onclear={() => (query = '')}
		>
			{#snippet search()}
				<SearchField
					label={t('cs.list.search')}
					placeholder={t('cs.list.search')}
					bind:value={query}
				/>
			{/snippet}
		</FilterBar>
		<Card title={t('cs.list.title')} flush>
			<DataTable
				caption={t('cs.list.title')}
				{columns}
				minWidth="900px"
				{rows}
				bind:sort
				rowKey={(row) => row.statement.id}
				onrowopen={(row) => onopen(row.statement.id)}
				rowOpenLabel={(row) => t('cs.list.open', { name: nameOf(row) })}
				dense
				{cell}
			>
				{#snippet empty()}
					<EmptyState
						icon="list"
						title={query.trim() ? t('cs.list.emptyFiltered') : t('cs.list.empty')}
					/>
				{/snippet}
			</DataTable>
		</Card>
	{/if}
</Page>
