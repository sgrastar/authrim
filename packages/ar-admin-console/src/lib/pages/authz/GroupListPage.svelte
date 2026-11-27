<script lang="ts">
	import { untrack } from 'svelte';
	import type { AuthzAccess } from '#lib/access/access.js';
	import { ApiError } from '#lib/api/api-error.js';
	import {
		GROUP_KINDS,
		type EndUserGroup,
		type EndUserGroupsClient,
		type GroupKind,
		type GroupLifecycle
	} from '#lib/api/end-user-groups.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import Card from '#lib/ui/patterns/Card.svelte';
	import CellText from '#lib/ui/patterns/CellText.svelte';
	import DataTable from '#lib/ui/patterns/DataTable.svelte';
	import EmptyState from '#lib/ui/patterns/EmptyState.svelte';
	import FilterBar from '#lib/ui/patterns/FilterBar.svelte';
	import LoadingState from '#lib/ui/patterns/LoadingState.svelte';
	import PageHeader from '#lib/ui/patterns/PageHeader.svelte';
	import Pagination from '#lib/ui/patterns/Pagination.svelte';
	import Badge from '#lib/ui/primitives/Badge.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import SearchField from '#lib/ui/primitives/SearchField.svelte';
	import Select from '#lib/ui/primitives/Select.svelte';
	import Page from '#lib/ui/templates/Page.svelte';
	import GroupCreateDialog from './GroupCreateDialog.svelte';
	import { KIND_LABEL, creatableKinds } from './group-model';

	/**
	 * Users → Groups: the tenant's groups of users (static, dynamic, from SCIM or provisioning
	 * rules), found by key or name and narrowed by kind and state. A row opens its group; "Create
	 * group" makes a static group, or a dynamic one whose members a rule decides.
	 */
	interface Props {
		client: EndUserGroupsClient;
		access: AuthzAccess;
		onopen: (groupId: string) => void;
		pageSize?: number;
	}

	let { client, access, onopen, pageSize = 20 }: Props = $props();

	let groups = $state<EndUserGroup[]>([]);
	let total = $state(0);
	let page = $state(1);
	let phase = $state<'loading' | 'ready' | 'forbidden' | 'failed'>('loading');
	let query = $state('');
	let kind = $state<'' | GroupKind>('');
	let lifecycle = $state<'' | GroupLifecycle>('');
	let creating = $state(false);

	let generation = 0;
	async function load() {
		const mine = ++generation;
		phase = 'loading';
		try {
			const result = await client.list({
				q: query || undefined,
				kind: kind || undefined,
				lifecycle_state: lifecycle || undefined,
				page,
				limit: pageSize
			});
			if (mine !== generation) return;
			groups = result.items;
			total = result.total;
			phase = 'ready';
		} catch (failure) {
			if (mine !== generation) return;
			phase = failure instanceof ApiError && failure.status === 403 ? 'forbidden' : 'failed';
		}
	}

	$effect(() => {
		void [query, kind, lifecycle, page];
		untrack(() => void load());
	});

	function clear() {
		query = '';
		kind = '';
		lifecycle = '';
		page = 1;
	}

	const columns = $derived([
		{ key: 'group', label: t('grp.list.col.group') },
		{ key: 'kind', label: t('grp.list.col.kind'), width: '18%' },
		{ key: 'members', label: t('grp.list.col.members'), width: '12%', align: 'end' as const },
		{ key: 'state', label: t('grp.list.col.state'), width: '14%' }
	]);
	const kindOptions = $derived([
		{ value: '', label: t('grp.filter.allKinds') },
		...GROUP_KINDS.map((value) => ({ value, label: t(KIND_LABEL[value]) }))
	]);
	const stateOptions = $derived([
		{ value: '', label: t('grp.filter.allStates') },
		{ value: 'active', label: t('grp.state.active') },
		{ value: 'inactive', label: t('grp.state.inactive') }
	]);
</script>

<Page>
	<PageHeader title={t('nav.users.groups')} description={t('grp.page.desc')}>
		{#snippet actions()}
			{#if creatableKinds(access).length > 0}
				<Button variant="primary" icon="plus" onclick={() => (creating = true)}>
					{t('grp.create')}
				</Button>
			{/if}
		{/snippet}
	</PageHeader>

	{#if phase === 'forbidden'}
		<EmptyState icon="lock" title={t('grp.list.noAccess')} />
	{:else}
		<FilterBar
			results={phase === 'ready' ? total : undefined}
			active={Boolean(query || kind || lifecycle)}
			onclear={clear}
		>
			{#snippet search()}
				<SearchField
					size="sm"
					label={t('grp.filter.search')}
					placeholder={t('grp.filter.search')}
					value={query}
					onsearch={(value) => {
						query = value.trim();
						page = 1;
					}}
				/>
			{/snippet}
			<Select
				size="sm"
				label={t('grp.list.col.kind')}
				options={kindOptions}
				bind:value={() => kind, (value) => ((kind = value as '' | GroupKind), (page = 1))}
			/>
			<Select
				size="sm"
				label={t('grp.list.col.state')}
				options={stateOptions}
				bind:value={
					() => lifecycle, (value) => ((lifecycle = value as '' | GroupLifecycle), (page = 1))
				}
			/>
		</FilterBar>

		<Card title={t('grp.list.title')} flush>
			{#if phase === 'loading'}
				<LoadingState label={t('common.loading')} />
			{:else if phase === 'failed'}
				<EmptyState icon="warningCircle" title={t('grp.list.loadFailed')}>
					{#snippet action()}
						<Button size="sm" onclick={load}>{t('common.retry')}</Button>
					{/snippet}
				</EmptyState>
			{:else}
				<DataTable
					caption={t('grp.list.title')}
					{columns}
					rows={groups}
					rowKey={(row) => row.id}
					onrowopen={(row) => onopen(row.id)}
					rowOpenLabel={(row) => t('grp.list.open', { name: row.display_name })}
				>
					{#snippet cell(row, column)}
						{#if column.key === 'group'}
							<CellText title={row.display_name} description={row.description ?? row.group_key} />
						{:else if column.key === 'kind'}
							<Badge tone={row.kind === 'dynamic' ? 'info' : 'neutral'}>
								{t(KIND_LABEL[row.kind])}
							</Badge>
						{:else if column.key === 'members'}
							{row.member_count}
						{:else if row.lifecycle_state === 'active'}
							<Badge tone="success" dot>{t('grp.state.active')}</Badge>
						{:else}
							<Badge dot>{t('grp.state.inactive')}</Badge>
						{/if}
					{/snippet}
					{#snippet empty()}
						<EmptyState
							icon="users"
							title={query || kind || lifecycle ? t('grp.list.noMatch') : t('grp.list.empty')}
							description={creatableKinds(access).length > 0 && !(query || kind || lifecycle)
								? t('grp.list.emptyBody')
								: undefined}
						/>
					{/snippet}
				</DataTable>
				{#if total > pageSize}
					<Pagination {total} {pageSize} {page} onchange={(next) => (page = next)} />
				{/if}
			{/if}
		</Card>
	{/if}
</Page>

<GroupCreateDialog
	{client}
	{access}
	open={creating}
	oncancel={() => (creating = false)}
	oncreated={(groupId) => {
		creating = false;
		onopen(groupId);
	}}
/>
