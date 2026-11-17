<script lang="ts">
	import { untrack } from 'svelte';
	import type { TenantsAccess } from '#lib/access/access.js';
	import { ApiError } from '#lib/api/api-error.js';
	import type { Tenant, TenantIsolationPolicy, TenantsClient } from '#lib/api/tenants.js';
	import { i18n, t } from '#lib/i18n/i18n.svelte.js';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import Card from '#lib/ui/patterns/Card.svelte';
	import CellText from '#lib/ui/patterns/CellText.svelte';
	import DataTable, { type Column, type SortState } from '#lib/ui/patterns/DataTable.svelte';
	import EmptyState from '#lib/ui/patterns/EmptyState.svelte';
	import FilterBar from '#lib/ui/patterns/FilterBar.svelte';
	import FormDialog from '#lib/ui/patterns/FormDialog.svelte';
	import LoadingState from '#lib/ui/patterns/LoadingState.svelte';
	import PageHeader from '#lib/ui/patterns/PageHeader.svelte';
	import { sortRows } from '#lib/ui/patterns/table-sort.js';
	import Badge from '#lib/ui/primitives/Badge.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import SearchField from '#lib/ui/primitives/SearchField.svelte';
	import Page from '#lib/ui/templates/Page.svelte';
	import DateTime from '#lib/ui/time/DateTime.svelte';
	import { toast } from '#lib/ui/toast/toast.svelte.js';
	import TenantFields from './TenantFields.svelte';
	import { tenantErrorDetail, tenantErrorKey } from './tenant-errors';
	import { lifecycleTone, newTenantProblems, takenIdentifiers } from './tenant-model';

	/**
	 * Platform → Tenants → All tenants: every tenant of the installation, with its id, state and
	 * dates. A row opens the tenant's page (copy and delete live there); "Create tenant" asks for
	 * a name and an id, and keeps the code, description and storage under "Advanced settings".
	 */
	interface Props {
		client: TenantsClient;
		access: TenantsAccess;
		onopen: (tenantId: string) => void;
		/** After a tenant was created (the console's tenant switcher reloads its list). */
		onchanged?: () => void;
	}

	let { client, access, onopen, onchanged }: Props = $props();

	let tenants = $state<Tenant[]>([]);
	let singleTenantMode = $state(false);
	let phase = $state<'loading' | 'ready' | 'forbidden' | 'failed'>('loading');
	let query = $state('');
	let sort = $state<SortState | null>({ key: 'name', direction: 'asc' });

	async function load() {
		phase = 'loading';
		try {
			const list = await client.list();
			tenants = list.tenants;
			singleTenantMode = list.singleTenantMode;
			phase = 'ready';
		} catch (failure) {
			phase = failure instanceof ApiError && failure.status === 403 ? 'forbidden' : 'failed';
		}
	}

	$effect(() => {
		untrack(() => void load());
	});

	const stateLabel = (tenant: Tenant) => t(`tn.state.${tenant.lifecycleState}`);

	function sortValue(tenant: Tenant, key: string): string | number | null {
		switch (key) {
			case 'name':
				return tenant.name;
			case 'id':
				return tenant.id;
			case 'state':
				return stateLabel(tenant);
			case 'created':
				return tenant.createdAt;
			default:
				return tenant.updatedAt;
		}
	}

	const shown = $derived.by(() => {
		const needle = query.trim().toLowerCase();
		return tenants.filter(
			(tenant) =>
				!needle ||
				tenant.name.toLowerCase().includes(needle) ||
				tenant.id.includes(needle) ||
				tenant.code.includes(needle)
		);
	});
	const rows = $derived(sortRows(shown, sort, sortValue, i18n.locale));
	const columns = $derived<Column[]>([
		{ key: 'name', label: t('tn.list.col.name'), sortable: true },
		{ key: 'id', label: t('tn.list.col.id'), width: '22%', sortable: true },
		{ key: 'state', label: t('tn.list.col.state'), width: '14%', sortable: true },
		{ key: 'created', label: t('tn.list.col.created'), width: '15%', sortable: true },
		{ key: 'updated', label: t('tn.list.col.updated'), width: '15%', sortable: true }
	]);

	// ---- create
	let creating = $state(false);
	let busy = $state(false);
	let name = $state('');
	let id = $state('');
	let code = $state('');
	let description = $state('');
	let isolationPolicy = $state<TenantIsolationPolicy>('tenant_exclusive');
	let advancedOpen = $state(false);
	let error = $state('');
	let nameError = $state('');
	let idError = $state('');
	let codeError = $state('');
	let formKey = $state(0);

	function openCreate() {
		name = id = code = description = '';
		isolationPolicy = 'tenant_exclusive';
		advancedOpen = false;
		error = nameError = idError = codeError = '';
		formKey += 1;
		creating = true;
	}

	async function create() {
		error = nameError = idError = codeError = '';
		if (!name.trim()) nameError = t('tn.f.nameRequired');
		const problems = newTenantProblems({ id, code }, takenIdentifiers(tenants));
		if (problems.id) idError = t(`tn.f.id.${problems.id}`);
		if (problems.code) {
			codeError = t(problems.code === 'taken' ? 'tn.f.code.taken' : `tn.f.id.${problems.code}`);
			advancedOpen = true;
		}
		if (nameError || idError || codeError) return;
		busy = true;
		try {
			const tenant = await client.create({ id, name, code, description, isolationPolicy });
			creating = false;
			toast.success(t('tn.toast.created', { name: tenant.name }));
			onchanged?.();
			onopen(tenant.id);
		} catch (failure) {
			error = [t(tenantErrorKey(failure)), tenantErrorDetail(failure)].filter(Boolean).join(' ');
		} finally {
			busy = false;
		}
	}
</script>

{#snippet cell(row: Tenant, column: Column)}
	{#if column.key === 'name'}
		<CellText title={row.name} description={row.description ?? undefined}>
			{#if row.isDefault}<Badge tone="info">{t('tn.default')}</Badge>{/if}
		</CellText>
	{:else if column.key === 'id'}
		<code>{row.id}</code>
	{:else if column.key === 'state'}
		<Badge tone={lifecycleTone(row.lifecycleState)} dot>{stateLabel(row)}</Badge>
	{:else if column.key === 'created'}
		{#if row.createdAt}<DateTime value={row.createdAt} stacked />{:else}—{/if}
	{:else if row.updatedAt}
		<DateTime value={row.updatedAt} stacked />
	{:else}
		—
	{/if}
{/snippet}

<Page>
	<PageHeader title={t('nav.pt.list')} description={t('tn.list.intro')}>
		{#snippet actions()}
			{#if access.manage && !singleTenantMode && phase === 'ready'}
				<Button variant="primary" icon="plus" onclick={openCreate}>{t('tn.create')}</Button>
			{/if}
		{/snippet}
	</PageHeader>

	{#if phase === 'loading'}
		<LoadingState label={t('common.loading')} />
	{:else if phase === 'forbidden'}
		<EmptyState icon="lock" title={t('tn.list.noAccess')} />
	{:else if phase === 'failed'}
		<EmptyState icon="warningCircle" title={t('tn.list.loadFailed')}>
			{#snippet action()}
				<Button size="sm" onclick={load}>{t('common.retry')}</Button>
			{/snippet}
		</EmptyState>
	{:else}
		{#if singleTenantMode}
			<Callout tone="info">{t('tn.list.singleTenant')}</Callout>
		{/if}
		<FilterBar
			label={t('tn.list.title')}
			results={shown.length}
			active={query.trim() !== ''}
			onclear={() => (query = '')}
		>
			{#snippet search()}
				<SearchField
					label={t('tn.list.search')}
					placeholder={t('tn.list.search')}
					bind:value={query}
				/>
			{/snippet}
		</FilterBar>
		<Card title={t('tn.list.title')} flush>
			<DataTable
				caption={t('tn.list.title')}
				{columns}
				minWidth="760px"
				{rows}
				bind:sort
				rowKey={(row) => row.id}
				onrowopen={(row) => onopen(row.id)}
				rowOpenLabel={(row) => t('tn.list.open', { name: row.name })}
				{cell}
			>
				{#snippet empty()}
					<EmptyState
						icon="building"
						title={query.trim() ? t('tn.list.noMatch') : t('tn.list.empty')}
					/>
				{/snippet}
			</DataTable>
		</Card>
	{/if}
</Page>

<FormDialog
	open={creating}
	title={t('tn.new.title')}
	description={t('tn.new.desc')}
	submitLabel={t('tn.new.submit')}
	{busy}
	{error}
	onsubmit={create}
	oncancel={() => (creating = false)}
>
	{#key formKey}
		<TenantFields
			bind:name
			bind:id
			bind:code
			bind:description
			bind:isolationPolicy
			bind:advancedOpen
			{nameError}
			{idError}
			{codeError}
		/>
	{/key}
</FormDialog>

<style>
	code {
		font-family: var(--font-mono);
		font-size: var(--fs-small);
	}
</style>
