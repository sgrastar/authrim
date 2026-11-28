<script lang="ts">
	import { untrack } from 'svelte';
	import type { AuthzAccess } from '#lib/access/access.js';
	import { ApiError } from '#lib/api/api-error.js';
	import type { EndUserRebacClient, RelationDefinition } from '#lib/api/end-user-rebac.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import Card from '#lib/ui/patterns/Card.svelte';
	import CellText from '#lib/ui/patterns/CellText.svelte';
	import DataTable from '#lib/ui/patterns/DataTable.svelte';
	import EmptyState from '#lib/ui/patterns/EmptyState.svelte';
	import FilterBar from '#lib/ui/patterns/FilterBar.svelte';
	import LoadingState from '#lib/ui/patterns/LoadingState.svelte';
	import Pagination from '#lib/ui/patterns/Pagination.svelte';
	import Badge from '#lib/ui/primitives/Badge.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import SearchField from '#lib/ui/primitives/SearchField.svelte';
	import Select from '#lib/ui/primitives/Select.svelte';
	import { describeExpression } from './rebac-model';

	/**
	 * Relation definitions: how a relation on an object type is computed (“a document's viewers
	 * are its viewers, its editors, and the viewers of its parent folder”). One row per relation,
	 * by object type; a row opens its page. A definition the API could not read is marked: its
	 * relation is not evaluated until it is fixed or deleted.
	 */
	interface Props {
		client: EndUserRebacClient;
		access: AuthzAccess;
		objectTypes: readonly string[];
		newHref: string;
		onopen: (definitionId: string) => void;
		pageSize?: number;
	}

	let { client, access, objectTypes, newHref, onopen, pageSize = 20 }: Props = $props();

	let definitions = $state<RelationDefinition[]>([]);
	let total = $state(0);
	let page = $state(1);
	let phase = $state<'loading' | 'ready' | 'forbidden' | 'failed'>('loading');
	let type = $state('');
	let query = $state('');

	let generation = 0;
	async function load() {
		const mine = ++generation;
		phase = 'loading';
		try {
			const result = await client.listDefinitions({
				object_type: type || undefined,
				search: query || undefined,
				page,
				limit: pageSize
			});
			if (mine !== generation) return;
			definitions = result.items;
			total = result.total;
			phase = 'ready';
		} catch (failure) {
			if (mine !== generation) return;
			phase = failure instanceof ApiError && failure.status === 403 ? 'forbidden' : 'failed';
		}
	}

	$effect(() => {
		void [type, query, page];
		untrack(() => void load());
	});

	function clear() {
		type = '';
		query = '';
		page = 1;
	}

	const words = $derived({
		or: t('rb.expr.or'),
		and: t('rb.expr.and'),
		butNot: t('rb.expr.butNot')
	});
	const columns = $derived([
		{ key: 'relation', label: t('rb.def.col.relation'), width: '28%' },
		{ key: 'expression', label: t('rb.def.col.expression') },
		{ key: 'priority', label: t('rb.def.col.priority'), width: '9%', align: 'end' as const },
		{ key: 'state', label: t('rb.def.col.state'), width: '14%' }
	]);
	const typeOptions = $derived([
		{ value: '', label: t('rb.filter.allTypes') },
		...objectTypes.map((name) => ({ value: name, label: name }))
	]);
</script>

<FilterBar
	results={phase === 'ready' ? total : undefined}
	active={Boolean(type || query)}
	onclear={clear}
>
	{#snippet search()}
		<SearchField
			size="sm"
			label={t('rb.filter.search')}
			placeholder={t('rb.filter.search')}
			value={query}
			onsearch={(value) => {
				query = value.trim();
				page = 1;
			}}
		/>
	{/snippet}
	<Select
		size="sm"
		label={t('rb.filter.objectType')}
		options={typeOptions}
		bind:value={() => type, (value) => ((type = value), (page = 1))}
	/>
</FilterBar>

<Card title={t('rb.def.title')} flush>
	{#snippet actions()}
		{#if access.rebacWrite}
			<Button size="sm" variant="primary" icon="plus" href={newHref}>{t('rb.def.create')}</Button>
		{/if}
	{/snippet}
	{#if phase === 'loading'}
		<LoadingState label={t('common.loading')} />
	{:else if phase === 'forbidden'}
		<EmptyState icon="lock" title={t('rb.noAccess')} />
	{:else if phase === 'failed'}
		<EmptyState icon="warningCircle" title={t('rb.def.loadFailed')}>
			{#snippet action()}
				<Button size="sm" onclick={load}>{t('common.retry')}</Button>
			{/snippet}
		</EmptyState>
	{:else}
		<DataTable
			caption={t('rb.def.title')}
			{columns}
			rows={definitions}
			rowKey={(row) => row.id}
			onrowopen={(row) => onopen(row.id)}
			rowOpenLabel={(row) => t('rb.def.open', { name: `${row.object_type}#${row.relation_name}` })}
		>
			{#snippet cell(row, column)}
				{#if column.key === 'relation'}
					<CellText
						title={`${row.object_type}#${row.relation_name}`}
						description={row.description ?? undefined}
					/>
				{:else if column.key === 'expression'}
					{#if row.unusable}
						<span class="muted">{t('rb.def.unusableCell')}</span>
					{:else}
						<code>{describeExpression(row.expression, words)}</code>
					{/if}
				{:else if column.key === 'priority'}
					{row.priority}
				{:else if row.unusable}
					<Badge tone="danger" dot>{t('rb.def.unusable')}</Badge>
				{:else if row.active}
					<Badge tone="success" dot>{t('rb.def.state.on')}</Badge>
				{:else}
					<Badge dot>{t('rb.def.state.off')}</Badge>
				{/if}
			{/snippet}
			{#snippet empty()}
				<EmptyState
					icon="shield"
					title={type || query ? t('rb.def.noMatch') : t('rb.def.empty')}
					description={access.rebacWrite && !(type || query) ? t('rb.def.emptyBody') : undefined}
				/>
			{/snippet}
		</DataTable>
		{#if total > pageSize}
			<Pagination {total} {pageSize} {page} onchange={(next) => (page = next)} />
		{/if}
	{/if}
</Card>

<style>
	.muted {
		color: var(--text-muted);
	}
</style>
