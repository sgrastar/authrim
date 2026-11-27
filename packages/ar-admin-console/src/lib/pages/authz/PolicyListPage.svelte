<script lang="ts">
	import { untrack } from 'svelte';
	import type { AuthzAccess } from '#lib/access/access.js';
	import type { AdminUsersClient } from '#lib/api/admin-users.js';
	import { ApiError } from '#lib/api/api-error.js';
	import type { EndUserGroupsClient } from '#lib/api/end-user-groups.js';
	import type { EndUserPoliciesClient, PolicyRule } from '#lib/api/end-user-policies.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import Callout from '#lib/ui/patterns/Callout.svelte';
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
	import PolicySimulatePanel from './PolicySimulatePanel.svelte';

	/**
	 * Access → Policies: the tenant's attribute-based rules the Check API evaluates after roles,
	 * per-resource permissions and relationships (while "Attribute rules" is on in Settings →
	 * Authorization). Each rule allows or denies one or more resource types and actions when its
	 * conditions hold. A row opens its rule; "Create policy" makes one. Below the list, the rules
	 * can be tried on one question.
	 */
	interface Props {
		client: EndUserPoliciesClient;
		users: Pick<AdminUsersClient, 'list'>;
		groups: Pick<EndUserGroupsClient, 'list'>;
		access: AuthzAccess;
		newHref: string;
		onopen: (ruleId: string) => void;
		pageSize?: number;
	}

	let { client, users, groups, access, newHref, onopen, pageSize = 20 }: Props = $props();

	let rules = $state<PolicyRule[]>([]);
	let total = $state(0);
	let page = $state(1);
	let phase = $state<'loading' | 'ready' | 'forbidden' | 'failed'>('loading');
	let query = $state('');
	let status = $state<'' | 'enabled' | 'disabled'>('');

	let generation = 0;
	async function load() {
		const mine = ++generation;
		phase = 'loading';
		try {
			const result = await client.list({
				search: query || undefined,
				enabled: status === '' ? undefined : status === 'enabled',
				page,
				limit: pageSize
			});
			if (mine !== generation) return;
			rules = result.items;
			total = result.total;
			phase = 'ready';
		} catch (failure) {
			if (mine !== generation) return;
			phase = failure instanceof ApiError && failure.status === 403 ? 'forbidden' : 'failed';
		}
	}

	$effect(() => {
		void [query, status, page];
		untrack(() => void load());
	});

	function clear() {
		query = '';
		status = '';
		page = 1;
	}

	const columns = $derived([
		{ key: 'rule', label: t('pol.list.col.rule') },
		{ key: 'effect', label: t('pol.list.col.effect'), width: '10%' },
		{ key: 'priority', label: t('pol.list.col.priority'), width: '9%', align: 'end' as const },
		{ key: 'resources', label: t('pol.list.col.resources'), width: '16%' },
		{ key: 'actions', label: t('pol.list.col.actions'), width: '14%' },
		{ key: 'conditions', label: t('pol.list.col.conditions'), width: '11%', align: 'end' as const },
		{ key: 'state', label: t('pol.list.col.state'), width: '10%' }
	]);
	const statusOptions = $derived([
		{ value: '', label: t('pol.filter.allStates') },
		{ value: 'enabled', label: t('pol.state.on') },
		{ value: 'disabled', label: t('pol.state.off') }
	]);
	/** A list as one line; none: the rule covers everything of that kind. */
	const covered = (values: readonly string[]) =>
		values.length > 0 ? values.join(', ') : t('pol.all');
</script>

<Page>
	<PageHeader title={t('nav.access.policies')} description={t('pol.page.desc')}>
		{#snippet actions()}
			{#if access.rolesWrite}
				<Button variant="primary" icon="plus" href={newHref}>{t('pol.create')}</Button>
			{/if}
		{/snippet}
	</PageHeader>

	{#if phase === 'forbidden'}
		<EmptyState icon="lock" title={t('pol.list.noAccess')} />
	{:else}
		<Callout icon="info">{t('pol.additive')}</Callout>

		<FilterBar
			results={phase === 'ready' ? total : undefined}
			active={Boolean(query || status)}
			onclear={clear}
		>
			{#snippet search()}
				<SearchField
					size="sm"
					label={t('pol.filter.search')}
					placeholder={t('pol.filter.search')}
					value={query}
					onsearch={(value) => {
						query = value.trim();
						page = 1;
					}}
				/>
			{/snippet}
			<Select
				size="sm"
				label={t('pol.list.col.state')}
				options={statusOptions}
				bind:value={() => status, (value) => ((status = value as typeof status), (page = 1))}
			/>
		</FilterBar>

		<Card title={t('pol.list.title')} flush>
			{#if phase === 'loading'}
				<LoadingState label={t('common.loading')} />
			{:else if phase === 'failed'}
				<EmptyState icon="warningCircle" title={t('pol.list.loadFailed')}>
					{#snippet action()}
						<Button size="sm" onclick={load}>{t('common.retry')}</Button>
					{/snippet}
				</EmptyState>
			{:else}
				<DataTable
					caption={t('pol.list.title')}
					{columns}
					rows={rules}
					rowKey={(row) => row.id}
					onrowopen={(row) => onopen(row.id)}
					rowOpenLabel={(row) => t('pol.list.open', { name: row.name })}
				>
					{#snippet cell(row, column)}
						{#if column.key === 'rule'}
							<CellText title={row.name} description={row.description ?? undefined} />
						{:else if column.key === 'effect'}
							<Badge tone={row.effect === 'deny' ? 'danger' : 'success'}>
								{t(row.effect === 'deny' ? 'pol.effect.deny' : 'pol.effect.allow')}
							</Badge>
						{:else if column.key === 'priority'}
							{row.priority}
						{:else if column.key === 'resources'}
							{covered(row.resource_types)}
						{:else if column.key === 'actions'}
							{covered(row.actions)}
						{:else if column.key === 'conditions'}
							{row.conditions.length}
						{:else if row.enabled}
							<Badge tone="success" dot>{t('pol.state.on')}</Badge>
						{:else}
							<Badge dot>{t('pol.state.off')}</Badge>
						{/if}
					{/snippet}
					{#snippet empty()}
						<EmptyState
							icon="shield"
							title={query || status ? t('pol.list.noMatch') : t('pol.list.empty')}
							description={access.rolesWrite && !(query || status)
								? t('pol.list.emptyBody')
								: undefined}
						/>
					{/snippet}
				</DataTable>
				{#if total > pageSize}
					<Pagination {total} {pageSize} {page} onchange={(next) => (page = next)} />
				{/if}
			{/if}
		</Card>

		{#if access.policiesSimulate}
			<PolicySimulatePanel {client} {users} {groups} {access} />
		{/if}
	{/if}
</Page>
