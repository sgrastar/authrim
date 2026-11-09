<script lang="ts">
	import { t } from '#lib/i18n/i18n.svelte.js';
	import Button from '#lib/ui/primitives/Button.svelte';
	import Card from '#lib/ui/patterns/Card.svelte';
	import DataTable from '#lib/ui/patterns/DataTable.svelte';
	import PageHeader from '#lib/ui/patterns/PageHeader.svelte';
	import Page from '#lib/ui/templates/Page.svelte';
	import DateTime from '#lib/ui/time/DateTime.svelte';
	import AccountFlowDetail from './AccountFlowDetail.svelte';
	import AccountFlowStatus from './AccountFlowStatus.svelte';
	import AddConnection from './AddConnection.svelte';
	import {
		ACCOUNT_FLOW_IDS,
		aboutState,
		FLOWS,
		flowName,
		isReady,
		type AccountFlowId,
		type AccountFlowState
	} from './account-flow-model';
	import LeaveGuard from './LeaveGuard.svelte';

	/** The first live service-flow page: the two account flows from the Storybook mock. */
	const columns = $derived([
		{ key: 'protocol', label: t('sf.mock.col.protocol'), width: '140px' },
		{ key: 'kind', label: t('sf.mock.col.kind'), width: '100px' },
		{ key: 'name', label: t('sf.mock.col.name') },
		{ key: 'status', label: t('sf.mock.col.status'), width: '216px' },
		{ key: 'created', label: t('sf.mock.col.created'), width: '208px' },
		{ key: 'modified', label: t('sf.mock.col.modified'), width: '208px' }
	]);
	const dates: Record<AccountFlowId, { created: string; modified: string }> = {
		registration: { created: '2026-07-01T00:00:00Z', modified: '2026-10-18T06:25:00Z' },
		login: { created: '2026-07-01T00:00:00Z', modified: '2026-10-18T06:25:00Z' }
	};

	const flowStates = $state<Record<AccountFlowId, AccountFlowState>>({
		registration: aboutState('registration', 'Standard sign-up', 'default-ui'),
		login: aboutState('login', 'Standard sign-in', 'default-ui')
	});
	const rows = $derived(
		ACCOUNT_FLOW_IDS.map((id) => ({
			id,
			protocol: t(FLOWS[id].title),
			kind: '—',
			name: flowName(id, flowStates[id]),
			ready: isReady(id, flowStates[id]),
			...dates[id]
		}))
	);
	let opened = $state<AccountFlowId | null>(null);
	let adding = $state(false);
	let dirty = $state(false);
	function leaveWizard() {
		adding = false;
		dirty = false;
	}
</script>

<LeaveGuard {dirty} />

<Page withFlow={opened !== null}>
	{#if opened}
		<AccountFlowDetail
			flow={opened}
			bind:form={flowStates[opened]}
			onback={() => (opened = null)}
			focusTitle
		/>
	{:else if adding}
		<AddConnection accountOnly bind:dirty oncancel={leaveWizard} ondone={leaveWizard} />
	{:else}
		<PageHeader title={t('sf.mock.title')} description={t('sf.mock.description')}>
			{#snippet actions()}
				<Button icon="plus" onclick={() => (adding = true)}>{t('sf.wizard.title')}</Button>
			{/snippet}
		</PageHeader>
		<Card title={t('sf.mock.connections')} flush>
			<DataTable
				{columns}
				{rows}
				rowKey={(row) => row.id}
				caption={t('sf.mock.connections')}
				onrowopen={(row) => (opened = row.id)}
				rowOpenLabel={(row) => t('sf.mock.open', { name: row.name })}
			>
				{#snippet cell(row, column)}
					{#if column.key === 'status'}
						<AccountFlowStatus ready={row.ready} />
					{:else if column.key === 'created' || column.key === 'modified'}
						<DateTime value={row[column.key]} stacked />
					{:else if column.key === 'name'}
						<strong>{row.name}</strong>
					{:else}
						{row[column.key as 'protocol' | 'kind']}
					{/if}
				{/snippet}
			</DataTable>
		</Card>
	{/if}
</Page>
