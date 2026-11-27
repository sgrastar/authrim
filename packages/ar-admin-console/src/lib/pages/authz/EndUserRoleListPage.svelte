<script lang="ts">
	import { untrack } from 'svelte';
	import type { AuthzAccess } from '#lib/access/access.js';
	import { ApiError } from '#lib/api/api-error.js';
	import type { EndUserRole, EndUserRolesClient } from '#lib/api/end-user-roles.js';
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
	import { roleLabel } from './role-model';

	/**
	 * Access → Roles: the roles the tenant's users can be given (directly or through a group),
	 * each a set of `resource:action` permissions with a grant tier. A row opens its role;
	 * "Create role" makes one at a tier up to the admin's own ceiling.
	 */
	interface Props {
		client: EndUserRolesClient;
		access: AuthzAccess;
		newHref: string;
		onopen: (roleId: string) => void;
	}

	let { client, access, newHref, onopen }: Props = $props();

	let roles = $state<EndUserRole[]>([]);
	let phase = $state<'loading' | 'ready' | 'forbidden' | 'failed'>('loading');

	async function load() {
		phase = 'loading';
		try {
			roles = (await client.list()).sort(
				(a, b) => Number(b.is_system) - Number(a.is_system) || a.name.localeCompare(b.name)
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
		{ key: 'role', label: t('eur.list.col.role') },
		{ key: 'tier', label: t('eur.list.col.tier'), width: '14%' },
		{ key: 'permissions', label: t('eur.list.col.permissions'), width: '18%' },
		{ key: 'users', label: t('eur.list.col.users'), width: '14%', align: 'end' as const }
	]);
</script>

<Page>
	<PageHeader title={t('nav.access.roles')} description={t('eur.page.desc')}>
		{#snippet actions()}
			{#if access.rolesWrite && access.grantCeiling > 0}
				<Button variant="primary" icon="plus" href={newHref}>{t('eur.create')}</Button>
			{/if}
		{/snippet}
	</PageHeader>

	{#if phase === 'forbidden'}
		<EmptyState icon="lock" title={t('eur.list.noAccess')} />
	{:else}
		<Card
			title={t('eur.list.title')}
			description={t('eur.ceiling', { ceiling: access.grantCeiling })}
			flush
		>
			{#if phase === 'loading'}
				<LoadingState label={t('common.loading')} />
			{:else if phase === 'failed'}
				<EmptyState icon="warningCircle" title={t('eur.list.loadFailed')}>
					{#snippet action()}
						<Button size="sm" onclick={load}>{t('common.retry')}</Button>
					{/snippet}
				</EmptyState>
			{:else}
				<DataTable
					caption={t('eur.list.title')}
					{columns}
					rows={roles}
					rowKey={(row) => row.id}
					onrowopen={(row) => onopen(row.id)}
					rowOpenLabel={(row) => t('eur.list.open', { name: roleLabel(row) })}
				>
					{#snippet cell(row, column)}
						{#if column.key === 'role'}
							<CellText title={roleLabel(row)} description={row.description ?? row.name}>
								{#if row.is_system}<Badge>{t('eur.kind.system')}</Badge>{/if}
							</CellText>
						{:else if column.key === 'tier'}
							<Badge tone={row.grant_tier > access.grantCeiling ? 'warning' : 'neutral'}>
								{t('eur.tier.short', { tier: row.grant_tier })}
							</Badge>
						{:else if column.key === 'permissions'}
							{t('eur.permissions.count', { count: row.permissions.length })}
						{:else}
							{row.assignment_count}
						{/if}
					{/snippet}
					{#snippet empty()}
						<EmptyState
							icon="shield"
							title={t('eur.list.empty')}
							description={access.rolesWrite ? t('eur.list.emptyBody') : undefined}
						/>
					{/snippet}
				</DataTable>
			{/if}
		</Card>
	{/if}
</Page>
