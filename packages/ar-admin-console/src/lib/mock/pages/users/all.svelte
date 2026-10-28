<script lang="ts">
	import { t } from '$lib/i18n/i18n.svelte';
	import Badge from '$lib/ui/primitives/Badge.svelte';
	import Card from '$lib/ui/patterns/Card.svelte';
	import DataTable from '$lib/ui/patterns/DataTable.svelte';
	import PageHeader from '$lib/ui/patterns/PageHeader.svelte';
	import Page from '$lib/ui/templates/Page.svelte';

	/**
	 * A sample mock page: parts from the design system and sample data written here, nothing
	 * fetched. The file's place is its URL (`pages/users/all.svelte` is `/mock/users/all`).
	 * Delete it or copy it as the start of the next page.
	 */
	const columns = $derived([
		{ key: 'name', label: t('sf.row.name') },
		{ key: 'email', label: t('sf.mock.users.email') },
		{ key: 'status', label: t('sf.mock.col.status'), width: '140px' }
	]);
	const STATUS = {
		active: 'sf.mock.status.active',
		suspended: 'sf.mock.status.suspended'
	} as const;
	const rows = [
		{ id: 'u1', name: 'Alex Morgan', email: 'alex@example.com', status: 'active' },
		{ id: 'u2', name: 'Sam Rivera', email: 'sam@example.com', status: 'active' },
		{ id: 'u3', name: 'Jo Kim', email: 'jo@example.com', status: 'suspended' }
	];
</script>

<Page>
	<PageHeader title={t('sf.mock.users.title')} description={t('sf.mock.users.description')} />
	<Card title={t('sf.mock.users.card')} flush>
		<DataTable {columns} {rows} rowKey={(row) => row.id} caption={t('sf.mock.users.card')}>
			{#snippet cell(row, column)}
				{#if column.key === 'status'}
					<Badge tone={row.status === 'active' ? 'success' : 'warning'} dot
						>{t(STATUS[row.status as keyof typeof STATUS])}</Badge
					>
				{:else if column.key === 'email'}
					{row.email}
				{:else}
					<strong>{row.name}</strong>
				{/if}
			{/snippet}
		</DataTable>
	</Card>
</Page>
