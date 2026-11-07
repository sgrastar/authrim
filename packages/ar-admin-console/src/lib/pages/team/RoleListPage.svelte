<script lang="ts">
	import { untrack } from 'svelte';
	import type { TeamAccess } from '#lib/access/access.js';
	import type { AdminRoleDefinition, AdminRolesClient } from '#lib/api/admin-roles.js';
	import { ApiError } from '#lib/api/api-error.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import Card from '#lib/ui/patterns/Card.svelte';
	import CellText from '#lib/ui/patterns/CellText.svelte';
	import DataTable from '#lib/ui/patterns/DataTable.svelte';
	import EmptyState from '#lib/ui/patterns/EmptyState.svelte';
	import LoadingState from '#lib/ui/patterns/LoadingState.svelte';
	import PageHeader from '#lib/ui/patterns/PageHeader.svelte';
	import Badge from '#lib/ui/primitives/Badge.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import Page from '#lib/ui/templates/Page.svelte';
	import { roleLabel } from './team-model';

	/**
	 * Settings → Administrator roles: the built-in roles and this tenant's own, highest rank
	 * first. A row opens its role; "Create role" makes a new one.
	 */
	interface Props {
		client: AdminRolesClient;
		access: TeamAccess;
		/** Where "Create role" goes. */
		newHref: string;
		onopen: (roleId: string) => void;
	}

	let { client, access, newHref, onopen }: Props = $props();

	let roles = $state<AdminRoleDefinition[]>([]);
	let phase = $state<'loading' | 'ready' | 'forbidden' | 'failed'>('loading');

	async function load() {
		phase = 'loading';
		try {
			roles = (await client.list()).sort(
				(a, b) => b.hierarchy_level - a.hierarchy_level || a.name.localeCompare(b.name)
			);
			phase = 'ready';
		} catch (failure) {
			phase = failure instanceof ApiError && failure.status === 403 ? 'forbidden' : 'failed';
		}
	}

	$effect(() => {
		untrack(() => void load());
	});

	const columns = $derived([
		{ key: 'role', label: t('tr.list.col.role') },
		{ key: 'kind', label: t('tr.list.col.kind'), width: '18%' },
		{ key: 'rank', label: t('tr.list.col.rank'), width: '12%' },
		{ key: 'permissions', label: t('tr.list.col.permissions'), width: '16%' }
	]);
</script>

<Page>
	<PageHeader title={t('nav.set.teamRoles')} description={t('tr.page.desc')}>
		{#snippet actions()}
			{#if access.rolesEdit}
				<Button variant="primary" icon="plus" href={newHref}>{t('tr.create')}</Button>
			{/if}
		{/snippet}
	</PageHeader>

	{#if phase === 'forbidden'}
		<EmptyState icon="lock" title={t('tr.list.noAccess')} />
	{:else}
		<Card title={t('tr.list.title')} flush>
			{#if phase === 'loading'}
				<LoadingState label={t('common.loading')} />
			{:else if phase === 'failed'}
				<EmptyState icon="warningCircle" title={t('tr.list.loadFailed')}>
					{#snippet action()}
						<Button size="sm" onclick={load}>{t('common.retry')}</Button>
					{/snippet}
				</EmptyState>
			{:else}
				<DataTable
					caption={t('tr.list.title')}
					{columns}
					rows={roles}
					rowKey={(row) => row.id}
					onrowopen={(row) => onopen(row.id)}
					rowOpenLabel={(row) => t('tr.list.open', { name: roleLabel(row) })}
				>
					{#snippet cell(row, column)}
						{#if column.key === 'role'}
							<CellText title={roleLabel(row)} description={row.description ?? row.name} />
						{:else if column.key === 'kind'}
							{#if row.is_system}
								<Badge>{t('tr.kind.system')}</Badge>
							{:else}
								<Badge tone="info">{t('tr.kind.custom')}</Badge>
							{/if}
						{:else if column.key === 'rank'}
							{row.hierarchy_level}
						{:else if row.permissions.includes('*')}
							{t('tr.permissions.all')}
						{:else}
							{t('tr.permissions.count', { count: row.permissions.length })}
						{/if}
					{/snippet}
					{#snippet empty()}
						<EmptyState icon="shield" title={t('tr.list.empty')} />
					{/snippet}
				</DataTable>
			{/if}
		</Card>
	{/if}
</Page>
