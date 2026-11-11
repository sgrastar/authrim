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
	import { onMount } from 'svelte';
	import {
		buildRegistrationFlowEditor,
		readRegistrationFlowEditor
	} from '@authrim/ar-lib-core/types/registration-flow-graph';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import LoadingState from '#lib/ui/patterns/LoadingState.svelte';
	import { useFlowResources } from './flow-resources-context';
	import {
		isConsoleShaped,
		registrationSpecOf,
		registrationStateOf
	} from './registration-flow-mapping';

	/** The first live service-flow page: the two account flows from the Storybook mock. */
	const columns = $derived([
		{ key: 'protocol', label: t('sf.mock.col.protocol'), width: '140px' },
		{ key: 'kind', label: t('sf.mock.col.kind'), width: '100px' },
		{ key: 'name', label: t('sf.mock.col.name') },
		{ key: 'status', label: t('sf.mock.col.status'), width: '216px' },
		{ key: 'created', label: t('sf.mock.col.created'), width: '208px' },
		{ key: 'modified', label: t('sf.mock.col.modified'), width: '208px' }
	]);
	const dates = $state<Record<AccountFlowId, { created: string; modified: string }>>({
		registration: { created: '2026-07-01T00:00:00Z', modified: '2026-10-18T06:25:00Z' },
		login: { created: '2026-07-01T00:00:00Z', modified: '2026-10-18T06:25:00Z' }
	});

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
	// The sign-up flow lives in the tenant's Flows where the page has them (the live console):
	// read from the one the tenant runs, saved back to it and published. Elsewhere (the mock
	// pages, Storybook) both flows are kept in the page only.
	const { flows } = useFlowResources();
	let signUp = $state<{ id: string | null; editable: boolean }>({ id: null, editable: true });
	let phase = $state<'loading' | 'ready' | 'failed'>(flows ? 'loading' : 'ready');
	const toIso = (seconds: number | null) =>
		seconds === null ? dates.registration.created : new Date(seconds * 1000).toISOString();

	async function loadSignUp() {
		if (!flows) return;
		phase = 'loading';
		try {
			const record = await flows.tenantFlow('registration');
			if (record) {
				const spec = isConsoleShaped(record.editor)
					? readRegistrationFlowEditor(record.editor)
					: null;
				const about = { name: record.displayName, scope: 'default-ui' };
				flowStates.registration = spec
					? registrationStateOf(spec, about)
					: aboutState('registration', about.name, about.scope);
				signUp = { id: record.id, editable: spec !== null };
				dates.registration = {
					created: toIso(record.createdAt),
					modified: toIso(record.updatedAt)
				};
			}
			phase = 'ready';
		} catch {
			phase = 'failed';
		}
	}
	onMount(() => void loadSignUp());

	/** Saves the sign-up flow as its Flow, publishes it, and makes it the tenant's. */
	async function saveSignUp(state: AccountFlowState) {
		if (!flows) return;
		if (!signUp.editable) throw new Error(t('af.live.notConsole'));
		// Consent at sign-up is not saved with the Flow yet: saving without it would publish a
		// sign-up that asks for none.
		if (state.added.includes('consent')) throw new Error(t('af.live.consentNotWired'));
		const editor = buildRegistrationFlowEditor(registrationSpecOf(state));
		const displayName =
			typeof state.values['reg.name'] === 'string' && state.values['reg.name'].trim()
				? state.values['reg.name'].trim()
				: t(FLOWS.registration.title);
		const record = signUp.id
			? await flows.update(signUp.id, { displayName, editor })
			: await flows.create({ kind: 'registration', displayName, editor });
		signUp = { id: record.id, editable: true };
		await flows.publish(record.id);
		if (state.values['reg.scope'] !== 'other-ui') {
			await flows.assignToTenant(record.id, 'registration');
		}
		dates.registration = { ...dates.registration, modified: new Date().toISOString() };
	}

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
		{#if opened === 'registration' && !signUp.editable}
			<Callout tone="warning">{t('af.live.notConsole')}</Callout>
		{/if}
		<AccountFlowDetail
			flow={opened}
			bind:form={flowStates[opened]}
			onback={() => (opened = null)}
			focusTitle
			onsave={opened === 'registration' && flows ? saveSignUp : undefined}
		/>
	{:else if adding}
		<AddConnection accountOnly bind:dirty oncancel={leaveWizard} ondone={leaveWizard} />
	{:else}
		<PageHeader title={t('sf.mock.title')} description={t('sf.mock.description')}>
			{#snippet actions()}
				<Button icon="plus" onclick={() => (adding = true)}>{t('sf.wizard.title')}</Button>
			{/snippet}
		</PageHeader>
		{#if phase === 'loading'}
			<LoadingState label={t('common.loading')} />
		{:else if phase === 'failed'}
			<Callout tone="warning">
				{t('af.live.loadFailed')}
				<Button size="sm" onclick={loadSignUp}>{t('common.retry')}</Button>
			</Callout>
		{/if}
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
