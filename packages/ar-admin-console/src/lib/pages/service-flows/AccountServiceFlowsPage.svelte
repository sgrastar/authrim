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
	import {
		applyLoginFlowSpec,
		canSetSignInConsent,
		buildLoginFlowEditor,
		loginSpecOf,
		loginStateOf,
		readLoginFlowEditor
	} from './login-flow-mapping';

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
	// The account flows live in the tenant's Flows where the page has them (the live console):
	// each read from the one the tenant runs, saved back to it and published. Elsewhere (the mock
	// pages, Storybook) both flows are kept in the page only.
	const { flows } = useFlowResources();
	interface SavedFlow {
		/** Read from the tenant's Flows (or there are none to read: the mock pages). Until then
		 * the flow is neither opened nor saved, so a failed read never makes a new Flow over the
		 * tenant's. */
		loaded: boolean;
		/** The tenant's Flow; null when it has none yet (saving makes one). */
		id: string | null;
		editable: boolean;
		/** The graph as read: a sign-in is saved back into it, keeping what the console does not set. */
		editor: unknown;
	}
	const saved = $state<Record<AccountFlowId, SavedFlow>>({
		registration: { loaded: !flows, id: null, editable: true, editor: null },
		login: { loaded: !flows, id: null, editable: true, editor: null }
	});
	let phase = $state<'loading' | 'ready' | 'failed'>(flows ? 'loading' : 'ready');
	const toIso = (flow: AccountFlowId, seconds: number | null) =>
		seconds === null ? dates[flow].created : new Date(seconds * 1000).toISOString();

	/**
	 * Which read is the current one: a read started before a retry (still pending when the retry
	 * came back) is dropped when it answers, so an older Flow never replaces a newer one.
	 */
	let generation = 0;

	async function loadFlow(flow: AccountFlowId, turn: number) {
		if (!flows) return;
		const record = await flows.tenantFlow(flow);
		if (turn !== generation) return;
		if (!record) {
			// None assigned: saving makes the tenant's first.
			saved[flow] = { loaded: true, id: null, editable: true, editor: null };
			return;
		}
		const about = { name: record.displayName, scope: 'default-ui' };
		let state: AccountFlowState | null = null;
		if (flow === 'registration') {
			const spec = isConsoleShaped(record.editor)
				? readRegistrationFlowEditor(record.editor)
				: null;
			state = spec ? registrationStateOf(spec, about) : null;
		} else {
			const spec = readLoginFlowEditor(record.editor);
			state = spec ? loginStateOf(spec, about) : null;
		}
		flowStates[flow] = state ?? aboutState(flow, about.name, about.scope);
		saved[flow] = {
			loaded: true,
			id: record.id,
			editable: state !== null,
			editor: record.editor
		};
		dates[flow] = {
			created: toIso(flow, record.createdAt),
			modified: toIso(flow, record.updatedAt)
		};
	}

	async function loadFlows() {
		if (!flows) return;
		const turn = ++generation;
		phase = 'loading';
		for (const flow of ACCOUNT_FLOW_IDS) saved[flow] = { ...saved[flow], loaded: false };
		try {
			await Promise.all(ACCOUNT_FLOW_IDS.map((flow) => loadFlow(flow, turn)));
			if (turn === generation) phase = 'ready';
		} catch {
			if (turn === generation) phase = 'failed';
		}
	}
	onMount(() => void loadFlows());

	/** Saves an account flow as its Flow, publishes it, and makes it the tenant's. */
	async function saveFlow(flow: AccountFlowId, state: AccountFlowState) {
		if (!flows) return;
		if (!saved[flow].loaded) throw new Error(t('af.live.loadFailed'));
		if (!saved[flow].editable) throw new Error(t('af.live.notConsole'));
		const spec = flow === 'login' ? loginSpecOf(state) : null;
		// Consent needs a completion to sit before; a Flow without one keeps its other settings
		// but cannot take consent (the apply below would give nothing back).
		if (
			spec &&
			spec.consent.length > 0 &&
			saved[flow].id &&
			!canSetSignInConsent(saved[flow].editor)
		) {
			throw new Error(t('af.live.consentNoPlace'));
		}
		const editor =
			flow === 'registration'
				? buildRegistrationFlowEditor(registrationSpecOf(state))
				: saved[flow].id
					? applyLoginFlowSpec(saved[flow].editor, spec ?? loginSpecOf(state))
					: buildLoginFlowEditor(spec ?? loginSpecOf(state));
		if (!editor) throw new Error(t('af.live.notConsole'));
		const prefix = flow === 'registration' ? 'reg' : 'login';
		const name = state.values[`${prefix}.name`];
		const displayName =
			typeof name === 'string' && name.trim() ? name.trim() : t(FLOWS[flow].title);
		const current = saved[flow].id;
		const record = current
			? await flows.update(current, { displayName, editor })
			: await flows.create({ kind: flow, displayName, editor });
		saved[flow] = { loaded: true, id: record.id, editable: true, editor };
		await flows.publish(record.id);
		if (state.values[`${prefix}.scope`] !== 'other-ui') {
			await flows.assignToTenant(record.id, flow);
		}
		dates[flow] = { ...dates[flow], modified: new Date().toISOString() };
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
		{@const current = opened}
		{#if !saved[current].editable}
			<Callout tone="warning">{t('af.live.notConsole')}</Callout>
		{/if}
		<AccountFlowDetail
			flow={opened}
			bind:form={flowStates[opened]}
			onback={() => (opened = null)}
			focusTitle
			onsave={flows ? (state) => saveFlow(current, state) : undefined}
			consentUnavailable={current === 'login' &&
				flows !== undefined &&
				saved.login.id !== null &&
				!canSetSignInConsent(saved.login.editor)}
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
				<Button size="sm" onclick={loadFlows}>{t('common.retry')}</Button>
			</Callout>
		{:else}
			<Card title={t('sf.mock.connections')} flush>
				<DataTable
					{columns}
					{rows}
					rowKey={(row) => row.id}
					caption={t('sf.mock.connections')}
					onrowopen={(row) => {
						// A flow is opened only once it was read: a failed read is not a flow to replace.
						if (saved[row.id].loaded) opened = row.id;
					}}
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
	{/if}
</Page>
