<script lang="ts">
	import { i18n } from '$lib/i18n/i18n.svelte';
	import Badge from '../primitives/Badge.svelte';
	import Card from '../patterns/Card.svelte';
	import DataTable, { type SortState } from '../patterns/DataTable.svelte';
	import { sortRows } from '../patterns/table-sort';
	import { USERS, type DemoUser } from './demo-users';
	import { sample } from './sample';

	/** Storybook demo: client-side sorting with `sortRows`. */
	let sort = $state<SortState | null>({ key: 'name', direction: 'asc' });

	const columns = $derived([
		{ key: 'name', label: sample('colName'), width: '28%', sortable: true },
		{ key: 'email', label: sample('colEmail'), width: '34%', sortable: true },
		{ key: 'role', label: sample('colRole'), width: '16%' },
		{ key: 'lastLogin', label: sample('colLastLogin'), width: '22%', sortable: true }
	]);

	const rows = $derived(
		sortRows(USERS, sort, (row, key) => row[key as keyof DemoUser] as string, i18n.locale)
	);
</script>

<Card flush>
	<DataTable caption={sample('usersTitle')} {columns} {rows} rowKey={(row) => row.id} bind:sort>
		{#snippet cell(row, column)}
			{#if column.key === 'name'}<strong>{row.name}</strong>
			{:else if column.key === 'role'}<Badge>{row.role}</Badge>
			{:else}{row[column.key as keyof DemoUser]}{/if}
		{/snippet}
	</DataTable>
</Card>
