<script lang="ts">
	import type { Snippet } from 'svelte';
	import { i18n, t } from '$lib/i18n/i18n.svelte';
	import {
		failureOf,
		FIELD_TYPES,
		listWindow,
		type FieldType,
		type OperationStatus,
		type Schema,
		type SchemaPage,
		type SchemaSettingClient,
		type SchemaStats
	} from '$lib/api/schema-setting';
	import Callout from '$lib/ui/patterns/Callout.svelte';
	import Card from '$lib/ui/patterns/Card.svelte';
	import DataTable, { type SortState } from '$lib/ui/patterns/DataTable.svelte';
	import EmptyState from '$lib/ui/patterns/EmptyState.svelte';
	import FilterBar from '$lib/ui/patterns/FilterBar.svelte';
	import LoadingState from '$lib/ui/patterns/LoadingState.svelte';
	import PageHeader from '$lib/ui/patterns/PageHeader.svelte';
	import Pagination from '$lib/ui/patterns/Pagination.svelte';
	import { sortRows } from '$lib/ui/patterns/table-sort';
	import Badge from '$lib/ui/primitives/Badge.svelte';
	import Button from '$lib/ui/primitives/Button.svelte';
	import RequiredBadge from '$lib/ui/primitives/RequiredBadge.svelte';
	import TypeBadge from '$lib/ui/primitives/TypeBadge.svelte';
	import SearchField from '$lib/ui/primitives/SearchField.svelte';
	import Select from '$lib/ui/primitives/Select.svelte';
	import { toast } from '$lib/ui/toast/toast.svelte';
	import Page from '$lib/ui/templates/Page.svelte';
	import CreateSchemaDialog from './CreateSchemaDialog.svelte';
	import { statusBadge, TYPE_KEY } from './labels';
	import PresetDialog from './PresetDialog.svelte';

	/**
	 * The attribute schema: every attribute a person can have, the base ones (the OIDC standard,
	 * added from a preset) and the tenant's own, in one table, by key to begin with (sortable by the
	 * other columns). A row opens the attribute.
	 * Adding is a dialog; the attribute then opens to be set up in full.
	 */
	interface Props {
		client: SchemaSettingClient;
		tenantId: string;
		/** May add and change attributes (the settings write permission). */
		canWrite?: boolean;
		onopen: (id: string) => void;
		/** Shown above the list (the feature is off, so values are stored but not released). */
		notice?: Snippet;
	}

	let { client, tenantId, canWrite = false, onopen, notice }: Props = $props();

	/** Rows on a page. The API gives 100 at most at once, so a page is put together from several. */
	const PAGE_SIZE = 250;

	let page = $state(1);
	let text = $state('');
	let type = $state('all');
	let pii = $state('all');
	let status = $state('all');
	let origin = $state('all');

	let result = $state<SchemaPage | null>(null);
	let stats = $state<SchemaStats | null>(null);
	let loadError = $state(false);
	let forbidden = $state(false);
	let loading = $state(true);

	let adding = $state(false);
	let applying = $state(false);

	/** How the table is sorted: by key to begin with. */
	let sort = $state<SortState | null>({ key: 'key', direction: 'asc' });

	const filtered = $derived(
		text.trim() !== '' || type !== 'all' || pii !== 'all' || status !== 'all' || origin !== 'all'
	);

	/** Each load counts up; an answer for an older page or condition is dropped. */
	let generation = 0;

	async function load() {
		const mine = ++generation;
		loading = true;
		loadError = false;
		forbidden = false;
		try {
			const [list, counts] = await Promise.all([
				listWindow(
					client,
					tenantId,
					{
						search: text.trim() || undefined,
						type: type === 'all' ? undefined : (type as FieldType),
						isPii: pii === 'all' ? undefined : pii === 'yes',
						isActive: status === 'active' ? true : status === 'inactive' ? false : undefined,
						status:
							// "On" and "off" are what the status badge says of an attribute at rest: one
							// being worked on or failed shows that instead, so it is not in them.
							status === 'active' || status === 'inactive'
								? 'active'
								: status !== 'all'
									? (status as OperationStatus)
									: undefined,
						isSystem: origin === 'all' ? undefined : origin === 'system'
					},
					{ page, size: PAGE_SIZE }
				),
				// The counts are a nicety: without them the list still shows.
				client.stats(tenantId).catch(() => null)
			]);
			if (mine !== generation) return;
			result = list;
			stats = counts;
		} catch (failure) {
			if (mine !== generation) return;
			if (failureOf(failure).kind === 'forbidden') forbidden = true;
			else loadError = true;
		} finally {
			if (mine === generation) loading = false;
		}
	}

	// A change of page or of a filter reads the list again.
	$effect(() => {
		void [page, text, type, pii, status, origin, tenantId];
		void load();
	});

	function reset() {
		page = 1;
	}

	function clear() {
		text = '';
		type = pii = status = origin = 'all';
		page = 1;
	}

	/** Every attribute is on this page: only then is a sort of the rows the sort of the list. */
	const allLoaded = $derived((result?.total ?? 0) <= PAGE_SIZE);

	const columns = $derived([
		{ key: 'key', label: t('ss.col.key'), width: '17%', sortable: allLoaded },
		{ key: 'label', label: t('ss.col.label'), sortable: allLoaded },
		{ key: 'origin', label: t('ss.col.origin'), width: '90px', sortable: allLoaded },
		{ key: 'type', label: t('ss.col.type'), width: '100px', sortable: allLoaded },
		{ key: 'pii', label: t('ss.col.pii'), width: '70px', sortable: allLoaded },
		{ key: 'cardinality', label: t('ss.col.cardinality'), width: '112px', sortable: allLoaded },
		{ key: 'required', label: t('ss.col.required'), width: '100px', sortable: allLoaded },
		{ key: 'status', label: t('ss.col.status'), width: '160px', sortable: allLoaded }
	]);

	/** What a column sorts by: words as the admin reads them, flags as 0 / 1. */
	function sortValue(row: Schema, key: string): string | number {
		switch (key) {
			case 'key':
				return row.fieldKey;
			case 'origin':
				return t(row.isSystem ? 'ss.origin.system' : 'ss.origin.custom');
			case 'label':
				return row.label;
			case 'type':
				return t(TYPE_KEY[row.type]);
			case 'pii':
				return row.isPii ? 1 : 0;
			case 'cardinality':
				return row.cardinality === 'multi' ? 1 : 0;
			case 'required':
				return row.isRequired ? 1 : 0;
			default:
				return t(statusBadge(row).key);
		}
	}

	/** The rows, sorted here (the API has no sort), when all of them are on this page. */
	const rows = $derived(
		allLoaded
			? sortRows(result?.schemas ?? [], sort, sortValue, i18n.locale)
			: (result?.schemas ?? [])
	);

	function created(schema: Schema) {
		adding = false;
		toast.success(t('ss.saved'));
		onopen(schema.id);
	}

	function applied(done: { createdKeys: string[]; skippedKeys: string[] }) {
		applying = false;
		toast.success(
			t('ss.preset.done', { created: done.createdKeys.length, skipped: done.skippedKeys.length })
		);
		void load();
	}
</script>

<Page>
	<PageHeader title={t('ss.title')} description={t('ss.description')}>
		{#snippet actions()}
			{#if canWrite && !forbidden}
				<Button variant="secondary" onclick={() => (applying = true)}>{t('ss.presetOpen')}</Button>
				<Button variant="primary" icon="plus" onclick={() => (adding = true)}>{t('ss.add')}</Button>
			{/if}
		{/snippet}
	</PageHeader>

	{@render notice?.()}

	{#if stats && stats.errorCount > 0}
		<Callout tone="warning">{t('ss.errorBanner', { count: stats.errorCount })}</Callout>
	{/if}

	{#if forbidden}
		<Callout tone="warning" live>{t('ss.noAccess')}</Callout>
	{:else if loading && !result}
		<LoadingState label={t('ss.title')} />
	{:else if loadError && !result}
		<Callout tone="danger">
			{t('ss.loadFailed')}
			<Button size="sm" variant="secondary" onclick={load}>{t('common.retry')}</Button>
		</Callout>
	{:else if result}
		{#if stats}
			<dl class="stats">
				<div>
					<dt>{t('ss.stats.total')}</dt>
					<dd>{stats.total}</dd>
				</div>
				<div>
					<dt>{t('ss.stats.pii')}</dt>
					<dd>{stats.activePii}</dd>
				</div>
				<div>
					<dt>{t('ss.stats.failed')}</dt>
					<dd>{stats.errorCount}</dd>
				</div>
			</dl>
		{/if}

		<FilterBar label={t('ss.title')} results={result.total} active={filtered} onclear={clear}>
			{#snippet search()}
				<SearchField
					label={t('ss.filter.search')}
					placeholder={t('ss.filter.searchPlaceholder')}
					size="sm"
					value={text}
					onsearch={(query) => {
						text = query;
						reset();
					}}
				/>
			{/snippet}
			<Select
				label={t('ss.filter.type')}
				hideLabel
				size="sm"
				bind:value={type}
				onchange={reset}
				options={[
					{ value: 'all', label: `${t('ss.filter.type')}: ${t('ss.filter.all')}` },
					...FIELD_TYPES.map((value) => ({ value, label: t(TYPE_KEY[value]) }))
				]}
			/>
			<Select
				label={t('ss.filter.pii')}
				hideLabel
				size="sm"
				bind:value={pii}
				onchange={reset}
				options={[
					{ value: 'all', label: `${t('ss.filter.pii')}: ${t('ss.filter.all')}` },
					{ value: 'yes', label: t('ss.pii.yes') },
					{ value: 'no', label: t('ss.pii.no') }
				]}
			/>
			<Select
				label={t('ss.filter.status')}
				hideLabel
				size="sm"
				bind:value={status}
				onchange={reset}
				options={[
					{ value: 'all', label: `${t('ss.filter.status')}: ${t('ss.filter.all')}` },
					{ value: 'active', label: t('ss.status.active') },
					{ value: 'inactive', label: t('ss.status.inactive') },
					{ value: 'error', label: t('ss.status.error') }
				]}
			/>
			<Select
				label={t('ss.filter.origin')}
				hideLabel
				size="sm"
				bind:value={origin}
				onchange={reset}
				options={[
					{ value: 'all', label: `${t('ss.filter.origin')}: ${t('ss.filter.all')}` },
					{ value: 'system', label: t('ss.origin.system') },
					{ value: 'custom', label: t('ss.origin.custom') }
				]}
			/>
		</FilterBar>

		{#if loadError}
			<Callout tone="danger">{t('ss.loadFailed')}</Callout>
		{/if}

		{#if result.total === 0}
			<Card flush>
				<EmptyState
					icon="list"
					title={filtered ? t('ss.empty.filtered') : t('ss.empty.title')}
					description={filtered ? undefined : t('ss.empty.description')}
				>
					{#snippet action()}
						{#if canWrite && !filtered}
							<Button variant="secondary" onclick={() => (applying = true)}
								>{t('ss.presetOpen')}</Button
							>
							<Button variant="primary" icon="plus" onclick={() => (adding = true)}
								>{t('ss.add')}</Button
							>
						{:else if filtered}
							<Button variant="secondary" onclick={clear}>{t('ss.filter.clear')}</Button>
						{/if}
					{/snippet}
				</EmptyState>
			</Card>
		{:else}
			<Card flush>
				<DataTable
					{columns}
					{rows}
					bind:sort
					rowKey={(row) => row.id}
					caption={t('ss.title')}
					onrowopen={(row) => onopen(row.id)}
					rowOpenLabel={(row) => row.fieldKey}
				>
					{#snippet cell(row, column)}
						{#if column.key === 'key'}
							<code class:is-off={!row.isActive}>{row.fieldKey}</code>
						{:else if column.key === 'label'}
							<span class:is-off={!row.isActive}>{row.label}</span>
						{:else if column.key === 'origin'}
							<Badge tone={row.isSystem ? 'info' : 'neutral'}
								>{t(row.isSystem ? 'ss.origin.system' : 'ss.origin.custom')}</Badge
							>
						{:else if column.key === 'type'}
							<TypeBadge>{t(TYPE_KEY[row.type])}</TypeBadge>
						{:else if column.key === 'pii'}
							{#if row.isPii}<Badge tone="warning">{t('ss.pii.yes')}</Badge>{:else}—{/if}
						{:else if column.key === 'cardinality'}
							{t(row.cardinality === 'multi' ? 'ss.card.multi' : 'ss.card.single')}
						{:else if column.key === 'required'}
							{#if row.isRequired}<RequiredBadge />{:else}<Badge>{t('ss.required.no')}</Badge>{/if}
						{:else}
							{@const badge = statusBadge(row)}
							<Badge tone={badge.tone} dot>{t(badge.key)}</Badge>
						{/if}
					{/snippet}
				</DataTable>
			</Card>
			<Pagination
				{page}
				pageSize={result.limit}
				total={result.total}
				onchange={(next) => (page = next)}
			/>
		{/if}
	{/if}
</Page>

<CreateSchemaDialog
	{client}
	{tenantId}
	open={adding}
	oncancel={() => (adding = false)}
	oncreated={created}
/>
<PresetDialog
	{client}
	{tenantId}
	open={applying}
	oncancel={() => (applying = false)}
	onapplied={applied}
/>

<style>
	.stats {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
		gap: var(--space-section);
		margin: 0;
	}

	.stats div {
		padding: 12px 16px;
		border: 1px solid var(--border);
		border-radius: var(--radius-panel);
		background: var(--bg-card);
	}

	.stats dt {
		color: var(--text-muted);
		font-size: var(--fs-small);
	}

	.stats dd {
		margin: 2px 0 0;
		font-size: var(--fs-title);
		font-weight: var(--fw-semibold);
	}

	/* A key is an identifier: monospace, at the size of the name beside it. */
	code {
		font-family: var(--font-mono);
		font-size: var(--fs-body);
	}

	.is-off {
		color: var(--text-muted);
	}
</style>
