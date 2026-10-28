<script lang="ts">
	import { t } from '$lib/i18n/i18n.svelte';
	import {
		ACCOUNT_FLOW_IDS,
		aboutState,
		flowName,
		FLOWS,
		isReady,
		type AccountFlowId,
		type AccountFlowState
	} from '$lib/pages/service-flows/account-flow-model';
	import AccountFlowDetail from '$lib/pages/service-flows/AccountFlowDetail.svelte';
	import AccountFlowStatus from '$lib/pages/service-flows/AccountFlowStatus.svelte';
	import AddConnection from '$lib/pages/service-flows/AddConnection.svelte';
	import {
		KIND_MARK,
		nameOf,
		sampleAnswers,
		type Answers,
		type ConnectionKind
	} from '$lib/pages/service-flows/connection-model';
	import LeaveGuard from '$lib/pages/service-flows/LeaveGuard.svelte';
	import ServiceFlowDetail from '$lib/pages/service-flows/ServiceFlowDetail.svelte';
	import Badge from '$lib/ui/primitives/Badge.svelte';
	import Button from '$lib/ui/primitives/Button.svelte';
	import Card from '$lib/ui/patterns/Card.svelte';
	import DataTable from '$lib/ui/patterns/DataTable.svelte';
	import PageHeader from '$lib/ui/patterns/PageHeader.svelte';
	import Page from '$lib/ui/templates/Page.svelte';
	import DateTime from '$lib/ui/time/DateTime.svelte';

	/**
	 * Service flows → all service flows, with "Add service flow" opening the wizard in place and a
	 * row opening that flow's detail. The list mixes the connections and the sign-up and sign-in
	 * flows: the protocol says which (a sign-up or sign-in flow has none of its own), the kind who
	 * is on the other side. Sample data written here; nothing is fetched or saved (a finished
	 * wizard adds no row).
	 */
	const columns = $derived([
		{ key: 'protocol', label: t('sf.mock.col.protocol'), width: '140px' },
		{ key: 'kind', label: t('sf.mock.col.kind'), width: '64px' },
		{ key: 'name', label: t('sf.mock.col.name') },
		{ key: 'status', label: t('sf.mock.col.status'), width: '216px' },
		{ key: 'created', label: t('sf.mock.col.created'), width: '208px' },
		{ key: 'modified', label: t('sf.mock.col.modified'), width: '208px' }
	]);
	const STATUS = { active: 'sf.mock.status.active', paused: 'sf.mock.status.paused' } as const;

	interface Connection {
		id: string;
		name: string;
		kind: ConnectionKind;
		status: keyof typeof STATUS;
		created: string;
		modified: string;
	}
	const connections: readonly Connection[] = [
		{
			id: 'c1',
			name: 'Employee portal',
			kind: 'rp',
			status: 'active',
			created: '2026-08-04T09:12:00Z',
			modified: '2026-10-21T02:40:00Z'
		},
		{
			id: 'c2',
			name: 'Admin tool',
			kind: 'rp',
			status: 'active',
			created: '2026-08-19T05:30:00Z',
			modified: '2026-09-30T11:05:00Z'
		},
		{
			id: 'c3',
			name: 'crm.example',
			kind: 'sp',
			status: 'active',
			created: '2026-09-02T00:20:00Z',
			modified: '2026-10-12T07:55:00Z'
		},
		{
			id: 'c4',
			name: 'payroll.example',
			kind: 'sp',
			status: 'paused',
			created: '2026-09-15T08:00:00Z',
			modified: '2026-10-25T13:10:00Z'
		}
	];
	const PROTOCOL: Record<ConnectionKind, string> = {
		rp: 'OpenID Connect',
		op: 'OpenID Connect',
		sp: 'SAML',
		idp: 'SAML'
	};
	const FLOW_DATES: Record<AccountFlowId, { created: string; modified: string }> = {
		registration: { created: '2026-07-01T00:00:00Z', modified: '2026-10-18T06:25:00Z' },
		login: { created: '2026-07-01T00:00:00Z', modified: '2026-10-18T06:25:00Z' }
	};

	/** What has been set in each sign-up and sign-in flow, kept while this page is open. */
	const flowStates = $state<Record<AccountFlowId, AccountFlowState>>({
		registration: aboutState('registration', 'Standard sign-up', 'default-ui'),
		login: aboutState('login', 'Standard sign-in', 'default-ui')
	});
	/** The same for each connection, as if it had been set up in full. */
	const connectionStates = $state<Record<string, Answers>>(
		Object.fromEntries(
			connections.map((connection) => {
				const answers = sampleAnswers(connection.kind);
				if (connection.kind === 'rp') answers.rp.name = connection.name;
				if (connection.kind === 'sp')
					answers.sp.metadataUrl = `https://${connection.name}/saml/metadata`;
				answers.active = connection.status === 'active';
				return [connection.id, answers];
			})
		)
	);

	/** Active while the connection is active; otherwise as it started (paused) or a draft. */
	function connectionStatus(connection: Connection): keyof typeof STATUS | 'draft' {
		if (connectionStates[connection.id].active) return 'active';
		return connection.status === 'paused' ? 'paused' : 'draft';
	}

	interface FlowRow {
		id: string;
		protocol: string;
		kind: string;
		name: string;
		status: 'ready' | 'setup' | 'draft' | keyof typeof STATUS;
		created: string;
		modified: string;
		/** What opening the row shows. */
		open: { flow: AccountFlowId } | { connection: string };
	}
	const rows = $derived<FlowRow[]>([
		...ACCOUNT_FLOW_IDS.map((id) => ({
			id,
			protocol: t(FLOWS[id].title),
			kind: '—',
			name: flowName(id, flowStates[id]),
			status: isReady(id, flowStates[id]) ? ('ready' as const) : ('setup' as const),
			...FLOW_DATES[id],
			open: { flow: id }
		})),
		...connections.map((connection) => ({
			id: connection.id,
			protocol: PROTOCOL[connection.kind],
			kind: KIND_MARK[connection.kind],
			name: nameOf(connectionStates[connection.id]),
			status: connectionStatus(connection),
			created: connection.created,
			modified: connection.modified,
			open: { connection: connection.id }
		}))
	]);

	/** The row being looked at, if one is open. */
	let opened = $state<FlowRow['open'] | null>(null);

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
	{#if opened && 'flow' in opened}
		<AccountFlowDetail
			flow={opened.flow}
			bind:form={flowStates[opened.flow]}
			onback={() => (opened = null)}
			focusTitle
		/>
	{:else if opened}
		<ServiceFlowDetail
			bind:answers={connectionStates[opened.connection]}
			onback={() => (opened = null)}
			focusTitle
		/>
	{:else if adding}
		<AddConnection bind:dirty oncancel={leave} ondone={leave} />
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
				onrowopen={(row) => (opened = row.open)}
				rowOpenLabel={(row) => t('sf.mock.open', { name: row.name })}
			>
				{#snippet cell(row, column)}
					{#if column.key === 'status'}
						{#if row.status === 'ready' || row.status === 'setup'}
							<AccountFlowStatus ready={row.status === 'ready'} />
						{:else if row.status === 'draft'}
							<Badge tone="warning" dot>{t('sf.status.draft')}</Badge>
						{:else}
							<Badge tone={row.status === 'active' ? 'success' : 'neutral'} dot
								>{t(STATUS[row.status])}</Badge
							>
						{/if}
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
