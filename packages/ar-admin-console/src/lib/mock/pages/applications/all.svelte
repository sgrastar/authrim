<script lang="ts">
	import { t } from '$lib/i18n/i18n.svelte';
	import AddConnection from '$lib/pages/service-flows/AddConnection.svelte';
	import LeaveGuard from '$lib/pages/service-flows/LeaveGuard.svelte';
	import Badge from '$lib/ui/primitives/Badge.svelte';
	import Button from '$lib/ui/primitives/Button.svelte';
	import Card from '$lib/ui/patterns/Card.svelte';
	import DataTable from '$lib/ui/patterns/DataTable.svelte';
	import PageHeader from '$lib/ui/patterns/PageHeader.svelte';
	import Page from '$lib/ui/templates/Page.svelte';

	/**
	 * Service flows → all connections, with "Add connection" opening the wizard in place.
	 * Sample data written here; nothing is fetched or saved (a finished wizard adds no row).
	 */
	const columns = $derived([
		{ key: 'name', label: t('sf.row.name') },
		{ key: 'kind', label: t('sf.mock.col.kind'), width: '220px' },
		{ key: 'status', label: t('sf.mock.col.status'), width: '140px' }
	]);
	const STATUS = { active: 'sf.mock.status.active', paused: 'sf.mock.status.paused' } as const;
	const rows = [
		{ id: 'c1', name: 'Reading room', kind: 'rp', status: 'active' },
		{ id: 'c2', name: 'Admin tool', kind: 'rp', status: 'active' },
		{ id: 'c3', name: 'Publisher A', kind: 'sp', status: 'active' },
		{ id: 'c4', name: 'Publisher B', kind: 'sp', status: 'paused' }
	];

	let adding = $state(false);
	/** The wizard holds answers that leaving would lose. */
	let dirty = $state(false);

	/** The wizard is gone, and so is what it held: nothing is left to ask about. */
	function leave() {
		adding = false;
		dirty = false;
	}
</script>

<LeaveGuard {dirty} />

<Page>
	{#if adding}
		<AddConnection bind:dirty oncancel={leave} ondone={leave} />
	{:else}
		<PageHeader title={t('sf.mock.title')} description={t('sf.mock.description')}>
			{#snippet actions()}
				<Button icon="plus" onclick={() => (adding = true)}>{t('sf.wizard.title')}</Button>
			{/snippet}
		</PageHeader>
		<Card title={t('sf.mock.connections')} flush>
			<DataTable {columns} {rows} rowKey={(row) => row.id} caption={t('sf.mock.connections')}>
				{#snippet cell(row, column)}
					{#if column.key === 'status'}
						<Badge tone={row.status === 'active' ? 'success' : 'neutral'} dot
							>{t(STATUS[row.status as keyof typeof STATUS])}</Badge
						>
					{:else if column.key === 'kind'}
						{t(row.kind === 'rp' ? 'sf.row.kind.rp' : 'sf.row.kind.sp')}
					{:else}
						<strong>{row.name}</strong>
					{/if}
				{/snippet}
			</DataTable>
		</Card>
	{/if}
</Page>
