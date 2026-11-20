<script lang="ts">
	import { ApiError } from '#lib/api/api-error.js';
	import type { Tenant } from '#lib/api/tenants.js';
	import { i18n, t } from '#lib/i18n/i18n.svelte.js';
	import CellText from '#lib/ui/patterns/CellText.svelte';
	import DataTable, { type Column, type SortState } from '#lib/ui/patterns/DataTable.svelte';
	import EmptyState from '#lib/ui/patterns/EmptyState.svelte';
	import FilterBar from '#lib/ui/patterns/FilterBar.svelte';
	import FormDialog from '#lib/ui/patterns/FormDialog.svelte';
	import LoadingState from '#lib/ui/patterns/LoadingState.svelte';
	import { sortRows } from '#lib/ui/patterns/table-sort.js';
	import Badge from '#lib/ui/primitives/Badge.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import SearchField from '#lib/ui/primitives/SearchField.svelte';
	import { lifecycleTone } from './tenant-model';

	/**
	 * Chooses tenants from the installation's: a table with a checkbox per row (its bar counts
	 * them, selects all or clears), a search over the name, id and code, and sorting by column. Deleted tenants (and ones being deleted) are
	 * not offered. A tenant chosen before that is no longer offered stays chosen, counted apart, so
	 * Apply does not drop it unseen. Opening the dialog reads the tenants again; Apply hands back
	 * the chosen IDs, Cancel changes nothing.
	 */
	interface Props {
		open: boolean;
		title: string;
		description?: string;
		/** The IDs chosen when the dialog opens. */
		selected: readonly string[];
		loadTenants: (signal?: AbortSignal) => Promise<Tenant[]>;
		/** The most tenants that may be chosen. */
		max?: number;
		onapply: (tenantIds: string[]) => void;
		oncancel: () => void;
	}

	let {
		open,
		title,
		description,
		selected,
		loadTenants,
		max = 1000,
		onapply,
		oncancel
	}: Props = $props();

	let tenants = $state<Tenant[]>([]);
	let phase = $state<'loading' | 'ready' | 'forbidden' | 'failed'>('loading');
	let chosen = $state<string[]>([]);
	let query = $state('');
	let sort = $state<SortState | null>({ key: 'name', direction: 'asc' });
	let controller: AbortController | null = null;

	const OFFERED_OUT = new Set(['deleting', 'deleted']);

	async function load() {
		controller?.abort();
		const current = new AbortController();
		controller = current;
		phase = 'loading';
		try {
			const list = await loadTenants(current.signal);
			if (current.signal.aborted) return;
			tenants = list.filter((tenant) => !OFFERED_OUT.has(tenant.lifecycleState));
			phase = 'ready';
		} catch (error) {
			if (current.signal.aborted) return;
			phase = error instanceof ApiError && error.forbidden ? 'forbidden' : 'failed';
		}
	}

	// Each opening starts from what was chosen and reads the tenants again.
	let wasOpen = false;
	$effect(() => {
		if (open && !wasOpen) {
			chosen = [...selected];
			query = '';
			void load();
		}
		if (!open) controller?.abort();
		wasOpen = open;
	});

	const stateLabel = (tenant: Tenant) => t(`tn.state.${tenant.lifecycleState}`);
	function sortValue(tenant: Tenant, key: string): string | number | null {
		if (key === 'id') return tenant.id;
		if (key === 'state') return stateLabel(tenant);
		return tenant.name;
	}

	const shown = $derived.by(() => {
		const needle = query.trim().toLowerCase();
		return tenants.filter(
			(tenant) =>
				!needle ||
				tenant.name.toLowerCase().includes(needle) ||
				tenant.id.includes(needle) ||
				tenant.code.toLowerCase().includes(needle)
		);
	});
	const rows = $derived(sortRows(shown, sort, sortValue, i18n.locale));
	const offeredIds = $derived(new Set(tenants.map((tenant) => tenant.id)));
	/** Chosen tenants the table does not offer (deleted since, or not readable). */
	const unlisted = $derived(chosen.filter((id) => !offeredIds.has(id)));
	const tooMany = $derived(chosen.length > max);

	const columns = $derived<Column[]>([
		{ key: 'name', label: t('tn.list.col.name'), sortable: true },
		{ key: 'id', label: t('tn.list.col.id'), width: '32%', sortable: true },
		{ key: 'state', label: t('tn.list.col.state'), width: '22%', sortable: true }
	]);
</script>

<FormDialog
	{open}
	{title}
	{description}
	size="wide"
	submitLabel={t('tn.picker.apply', { n: chosen.length })}
	error={tooMany ? t('tn.picker.tooMany', { n: max }) : undefined}
	onsubmit={() => {
		if (!tooMany && phase === 'ready') onapply([...chosen]);
	}}
	{oncancel}
>
	{#if phase === 'loading'}
		<LoadingState label={t('common.loading')} />
	{:else if phase === 'forbidden'}
		<EmptyState icon="lock" title={t('tn.picker.noAccess')} />
	{:else if phase === 'failed'}
		<EmptyState icon="warningCircle" title={t('tn.picker.loadFailed')}>
			{#snippet action()}<Button size="sm" onclick={load}>{t('common.retry')}</Button>{/snippet}
		</EmptyState>
	{:else}
		<div class="tenant-picker">
			<FilterBar
				label={t('tn.picker.filter')}
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
			{#if unlisted.length > 0}
				<p class="tenant-picker__unlisted">{t('tn.picker.unlisted', { n: unlisted.length })}</p>
			{/if}
			<div class="tenant-picker__table">
				<DataTable
					caption={title}
					{columns}
					{rows}
					dense
					bind:sort
					selectable
					bind:selected={chosen}
					rowKey={(tenant) => tenant.id}
					rowLabel={(tenant) => tenant.name}
				>
					{#snippet cell(tenant, column)}
						{#if column.key === 'name'}
							<CellText
								title={tenant.name}
								description={tenant.isDefault ? t('tn.picker.default') : undefined}
							/>
						{:else if column.key === 'id'}
							<code>{tenant.id}</code>
						{:else}
							<Badge tone={lifecycleTone(tenant.lifecycleState)} dot>{stateLabel(tenant)}</Badge>
						{/if}
					{/snippet}
					{#snippet empty()}
						<EmptyState
							icon="building"
							title={query.trim() ? t('tn.list.noMatch') : t('tn.list.empty')}
						/>
					{/snippet}
				</DataTable>
			</div>
		</div>
	{/if}
</FormDialog>

<style>
	.tenant-picker {
		display: grid;
		gap: var(--space-related);
		min-inline-size: 0;
	}

	.tenant-picker__unlisted {
		margin: 0;
		color: var(--warning-text);
		font-size: var(--fs-caption);
	}

	.tenant-picker__table {
		max-block-size: min(52vh, 480px);
		overflow: auto;
		border: 1px solid var(--border);
		border-radius: var(--radius-panel);
	}
</style>
