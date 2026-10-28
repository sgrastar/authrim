<script lang="ts">
	import { sample } from './sample';
	import Button from '../primitives/Button.svelte';
	import Card from '../patterns/Card.svelte';
	import DataTable from '../patterns/DataTable.svelte';

	/** A table whose rows open a detail, with a button in one cell of its own. */
	const rows = [
		{ id: 'login', name: 'flowLogin', protocol: 'OIDC' },
		{ id: 'scim-out', name: 'flowSlack', protocol: 'SCIM' },
		{ id: 'vc', name: 'flowVc', protocol: 'VC' }
	];
	let message = $state('');
</script>

<Card flush>
	<DataTable
		caption={sample('flowsTitle')}
		columns={[
			{ key: 'name', label: sample('colFlow'), width: '50%' },
			{ key: 'protocol', label: sample('colProtocol'), width: '25%' },
			{ key: 'check', label: sample('colSetup'), width: '25%' }
		]}
		{rows}
		rowKey={(row) => row.id}
		onrowopen={(row) => (message = `Opened ${row.name}`)}
		rowOpenLabel={(row) => `Open ${row.name}`}
	>
		{#snippet cell(row, column)}
			{#if column.key === 'check'}
				<label class="demo-flag"><input type="checkbox" /> Flag {row.name}</label>
				<Button
					size="sm"
					variant="ghost"
					aria-label={`Check ${row.name}`}
					onclick={() => (message = `Checked ${row.name}`)}>Check</Button
				>
			{:else}
				{row[column.key as 'name' | 'protocol']}
			{/if}
		{/snippet}
	</DataTable>
</Card>
<p role="status">{message}</p>

<style>
	.demo-flag {
		margin-inline-end: 8px;
	}
</style>
