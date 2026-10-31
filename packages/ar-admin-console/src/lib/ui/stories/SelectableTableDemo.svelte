<script lang="ts">
	import { untrack } from 'svelte';
	import Badge from '../primitives/Badge.svelte';
	import Button from '../primitives/Button.svelte';
	import Card from '../patterns/Card.svelte';
	import DataTable from '../patterns/DataTable.svelte';
	import { USERS, type DemoUser } from './demo-users';
	import { sample } from './sample';

	/** Storybook demo: multi-select with select all / clear and a bulk action. */
	interface Props {
		initial?: string[];
	}

	let { initial = [] }: Props = $props();
	// The initial selection only seeds the demo; later clicks own the state.
	let selected = $state<string[]>(untrack(() => [...initial]));

	const columns = $derived([
		{ key: 'name', label: sample('colName'), width: '30%' },
		{ key: 'email', label: sample('colEmail'), width: '40%' },
		{ key: 'role', label: sample('colRole'), width: '30%' }
	]);
</script>

<Card flush>
	<DataTable
		caption={sample('usersTitle')}
		{columns}
		rows={USERS}
		rowKey={(row) => row.id}
		rowLabel={(row) => row.name}
		selectable
		bind:selected
	>
		{#snippet cell(row, column)}
			{#if column.key === 'name'}<strong>{row.name}</strong>
			{:else if column.key === 'role'}<Badge>{row.role}</Badge>
			{:else}{row[column.key as keyof DemoUser]}{/if}
		{/snippet}
		{#snippet bulkActions()}
			<Button size="sm" variant="danger">{sample('suspend')}</Button>
		{/snippet}
	</DataTable>
</Card>
