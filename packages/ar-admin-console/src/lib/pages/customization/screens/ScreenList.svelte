<script lang="ts">
	import { untrack } from 'svelte';
	import { ApiError } from '#lib/api/api-error.js';
	import {
		SCREEN_KINDS,
		type ScreenKind,
		type ScreenListItem,
		type ScreensClient
	} from '#lib/api/screens.js';
	import { i18n, t, type MessageKey } from '#lib/i18n/i18n.svelte.js';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import Card from '#lib/ui/patterns/Card.svelte';
	import CellText from '#lib/ui/patterns/CellText.svelte';
	import DataTable, { type Column, type SortState } from '#lib/ui/patterns/DataTable.svelte';
	import EmptyState from '#lib/ui/patterns/EmptyState.svelte';
	import FilterBar from '#lib/ui/patterns/FilterBar.svelte';
	import LoadingState from '#lib/ui/patterns/LoadingState.svelte';
	import PageHeader from '#lib/ui/patterns/PageHeader.svelte';
	import Badge from '#lib/ui/primitives/Badge.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import SearchField from '#lib/ui/primitives/SearchField.svelte';
	import Select from '#lib/ui/primitives/Select.svelte';
	import { sortRows } from '#lib/ui/patterns/table-sort.js';
	import Page from '#lib/ui/templates/Page.svelte';
	import DateTime from '#lib/ui/time/DateTime.svelte';

	/**
	 * Customization → Screens: tenant screens, with account screens in their own table. Built-in
	 * system screens remain available as templates in the creation wizard.
	 */
	interface Props {
		client: ScreensClient;
		canWrite: boolean;
		/** Where a screen's page is (`new` for a new one). */
		hrefOf: (id: string) => string;
		onopen: (id: string) => void;
	}

	let { client, canWrite, hrefOf, onopen }: Props = $props();

	let screens = $state<ScreenListItem[]>([]);
	let usagesComplete = $state(true);
	let phase = $state<'loading' | 'ready' | 'forbidden' | 'failed'>('loading');
	let query = $state('');
	let kind = $state<ScreenKind | ''>('');
	let screenSort = $state<SortState | null>(null);
	let accountSort = $state<SortState | null>(null);

	async function load() {
		phase = 'loading';
		try {
			({ screens, usagesComplete } = await client.list());
			phase = 'ready';
		} catch (error) {
			phase = error instanceof ApiError && error.status === 403 ? 'forbidden' : 'failed';
		}
	}

	$effect(() => {
		untrack(() => void load());
	});

	const shown = $derived.by(() => {
		const needle = query.trim().toLowerCase();
		return screens.filter(
			(screen) =>
				!screen.is_system &&
				(!kind || screen.screen_kind === kind) &&
				(!needle ||
					screen.display_name.toLowerCase().includes(needle) ||
					screen.screen_key.toLowerCase().includes(needle))
		);
	});
	const kindLabel = (value: ScreenKind) => t(`sc.kind.${value}` as MessageKey);
	function sortValue(screen: ScreenListItem, key: string): string | number {
		switch (key) {
			case 'name':
				return screen.display_name;
			case 'kind':
				return kindLabel(screen.screen_kind);
			case 'usage':
				return screen.usage.flows + screen.usage.account_pages;
			case 'created':
				return screen.created_at;
			default:
				return screen.updated_at;
		}
	}
	const screenRows = $derived(
		sortRows(
			shown.filter((screen) => screen.screen_kind !== 'account'),
			screenSort,
			sortValue,
			i18n.locale
		)
	);
	const accountRows = $derived(
		sortRows(
			shown.filter((screen) => screen.screen_kind === 'account'),
			accountSort,
			sortValue,
			i18n.locale
		)
	);
	const usageText = (screen: ScreenListItem) => {
		const parts = [
			screen.usage.flows > 0 ? t('sc.usage.flows', { n: screen.usage.flows }) : null,
			screen.usage.account_pages > 0 ? t('sc.usage.pages', { n: screen.usage.account_pages }) : null
		].filter(Boolean);
		return parts.length > 0 ? parts.join(' · ') : t('sc.usage.none');
	};

	const filtered = $derived(query.trim() !== '' || kind !== '');
	const clear = () => {
		query = '';
		kind = '';
	};

	const columns = $derived([
		// Dates include a time and zone, and may show a second zone underneath.
		{ key: 'name', label: t('sc.list.col.name'), sortable: true },
		{ key: 'kind', label: t('sc.list.col.kind'), width: '120px', sortable: true },
		{ key: 'usage', label: t('sc.list.col.usage'), width: '120px', sortable: true },
		{ key: 'created', label: t('sc.list.col.created'), width: '225px', sortable: true },
		{ key: 'updated', label: t('sc.list.col.updated'), width: '225px', sortable: true }
	]);
</script>

{#snippet screenCell(row: ScreenListItem, column: Column)}
	{#if column.key === 'name'}
		<CellText title={row.display_name} description={row.screen_key}>
			{#if !row.is_active}<Badge tone="warning">{t('sc.status.inactive')}</Badge>{/if}
		</CellText>
	{:else if column.key === 'kind'}
		{kindLabel(row.screen_kind)}
	{:else if column.key === 'usage'}
		{usageText(row)}
	{:else if column.key === 'created'}
		<DateTime value={row.created_at} stacked />
	{:else if column.key === 'updated'}
		<DateTime value={row.updated_at} stacked />
	{/if}
{/snippet}

<Page>
	<PageHeader title={t('nav.custom.screens')}>
		{#snippet actions()}
			{#if canWrite}
				<Button variant="primary" icon="plus" href={hrefOf('new')}>{t('sc.list.create')}</Button>
			{/if}
		{/snippet}
	</PageHeader>

	{#if phase === 'loading'}
		<LoadingState label={t('common.loading')} />
	{:else if phase === 'forbidden'}
		<EmptyState icon="lock" title={t('sc.list.noAccess')} />
	{:else if phase === 'failed'}
		<EmptyState icon="warningCircle" title={t('sc.list.loadFailed')}>
			{#snippet action()}
				<Button size="sm" onclick={load}>{t('common.retry')}</Button>
			{/snippet}
		</EmptyState>
	{:else}
		{#if !usagesComplete}
			<Callout tone="warning">{t('sc.usage.incomplete')}</Callout>
		{/if}
		<FilterBar label={t('sc.list.title')} results={shown.length} active={filtered} onclear={clear}>
			{#snippet search()}
				<SearchField
					label={t('sc.list.search')}
					placeholder={t('sc.list.search')}
					bind:value={query}
				/>
			{/snippet}
			<Select
				label={t('sc.list.kindFilter')}
				size="sm"
				options={[
					{ value: '', label: t('sc.list.allKinds') },
					...SCREEN_KINDS.map((value) => ({ value, label: kindLabel(value) }))
				]}
				bind:value={kind}
			/>
		</FilterBar>

		{#if kind !== 'account'}
			<Card title={t('sc.list.title')} flush>
				<DataTable
					caption={t('sc.list.title')}
					{columns}
					minWidth="920px"
					rows={screenRows}
					bind:sort={screenSort}
					rowKey={(row) => row.id}
					onrowopen={(row) => onopen(row.id)}
					rowOpenLabel={(row) => t('sc.list.open', { name: row.display_name })}
					dense
				>
					{#snippet cell(row, column)}
						{@render screenCell(row, column)}
					{/snippet}
					{#snippet empty()}
						<EmptyState
							icon="list"
							title={filtered ? t('sc.list.emptyFiltered') : t('sc.list.empty')}
						/>
					{/snippet}
				</DataTable>
			</Card>
		{/if}

		{#if !kind || kind === 'account'}
			<Card title={t('sc.list.accountTable')} flush>
				<DataTable
					caption={t('sc.list.accountTable')}
					{columns}
					minWidth="920px"
					rows={accountRows}
					bind:sort={accountSort}
					rowKey={(row) => row.id}
					onrowopen={(row) => onopen(row.id)}
					rowOpenLabel={(row) => t('sc.list.open', { name: row.display_name })}
					dense
				>
					{#snippet cell(row, column)}
						{@render screenCell(row, column)}
					{/snippet}
					{#snippet empty()}
						<EmptyState
							icon="list"
							title={filtered ? t('sc.list.emptyFiltered') : t('sc.list.emptyAccount')}
						/>
					{/snippet}
				</DataTable>
			</Card>
		{/if}
	{/if}
</Page>
