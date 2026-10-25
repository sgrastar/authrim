<script module lang="ts">
	export type MappingPage = 'tenants' | 'tenant' | 'apps' | 'app' | 'sets' | 'set';
</script>

<script lang="ts">
	import { untrack } from 'svelte';
	import type {
		AppSummary,
		ExplainConsent,
		ExplainSurface,
		IdentityMappingClient,
		MappingSetSummary,
		SetContentDraft
	} from '$lib/api/identity-mapping';
	import { t } from '$lib/i18n/i18n.svelte';
	import Callout from '$lib/ui/patterns/Callout.svelte';
	import Card from '$lib/ui/patterns/Card.svelte';
	import DataTable from '$lib/ui/patterns/DataTable.svelte';
	import LoadingState from '$lib/ui/patterns/LoadingState.svelte';
	import PageHeader from '$lib/ui/patterns/PageHeader.svelte';
	import Tabs from '$lib/ui/patterns/Tabs.svelte';
	import Button from '$lib/ui/primitives/Button.svelte';
	import TextField from '$lib/ui/primitives/TextField.svelte';
	import LeaveConfirm from '$lib/ui/save/LeaveConfirm.svelte';
	import Page from '$lib/ui/templates/Page.svelte';
	import AppMappingChoice from './AppMappingChoice.svelte';
	import ClaimInvestigation from './ClaimInvestigation.svelte';
	import MappingHistory from './MappingHistory.svelte';
	import MappingRollout from './MappingRollout.svelte';
	import SetChangePreview from './SetChangePreview.svelte';

	/** Shared record pages. Stories choose starting state, never a scenario-specific workflow. */
	interface Props {
		client: IdentityMappingClient;
		tenantId?: string;
		tenantName?: string;
		page?: MappingPage;
		tab?: 'mapping' | 'test' | 'history';
		clientId?: string;
		setId?: string;
		userId?: string;
		surface?: ExplainSurface;
		consent?: ExplainConsent;
		autorun?: boolean;
		edits?: SetContentDraft;
		sampleUserId?: string;
	}
	let {
		client,
		tenantId = 'aster',
		tenantName,
		page = 'apps',
		tab = 'mapping',
		clientId = '',
		setId = '',
		userId = '',
		surface,
		consent,
		autorun = false,
		edits,
		sampleUserId
	}: Props = $props();
	let location = $state(
		untrack(() => ({
			page,
			tenantId,
			tenantName: tenantName ?? tenantId,
			clientId,
			setId,
			tab: String(tab)
		}))
	);
	let sample = $state(untrack(() => userId));
	let testSurface = $state<ExplainSurface>(untrack(() => surface ?? 'id_token'));
	let testConsent = $state<ExplainConsent>(untrack(() => consent ?? 'all'));
	let visitedTenants = $state(untrack(() => page === 'tenants'));
	let trail = $state<Array<typeof location>>([]);
	let apps = $state<AppSummary[]>([]);
	let sets = $state<MappingSetSummary[]>([]);
	let loading = $state(false);
	let failed = $state(false);
	let appSearch = $state('');
	let setSearch = $state('');
	let dirty = $state(false);
	let busy = $state(false);
	let pending = $state<{ target: typeof location; back: boolean } | null>(null);
	let seededEdits = $state(untrack(() => edits));
	let generation = 0;
	let rolloutRevision = $state(0);

	async function load() {
		const mine = ++generation;
		const owner = location.tenantId;
		loading = true;
		failed = false;
		try {
			const [nextApps, nextSets] = await Promise.all([client.apps(owner), client.sets(owner)]);
			if (mine !== generation) return;
			apps = nextApps;
			sets = nextSets.sets;
		} catch {
			if (mine === generation) failed = true;
		} finally {
			if (mine === generation) loading = false;
		}
	}
	const loadKey = $derived(`${location.tenantId}|${location.page}`);
	$effect(() => {
		void loadKey;
		void client;
		untrack(() => {
			if (location.page !== 'tenants' && location.page !== 'tenant') void load();
		});
		return () => {
			++generation;
		};
	});

	function move(next: typeof location, back = false) {
		if (busy) return;
		if (dirty) {
			pending = { target: next, back };
			return;
		}
		if (back) trail = trail.slice(0, -1);
		else trail = [...trail, { ...location }];
		if (location.page === 'set') seededEdits = undefined;
		if (next.tenantId !== location.tenantId) sample = '';
		if (next.page === 'tenants') visitedTenants = true;
		location = next;
	}
	function navigate(changes: Partial<typeof location>) {
		move({ ...location, ...changes });
	}
	function leave() {
		if (!pending || busy) return;
		dirty = false;
		move(pending.target, pending.back);
		pending = null;
	}
	function receiveFormState(next: { dirty: boolean; saving: boolean }) {
		dirty = next.dirty;
		busy = next.saving;
	}
	const app = $derived(apps.find((row) => row.client_id === location.clientId));
	const set = $derived(sets.find((row) => row.id === location.setId));
	const heading = $derived(
		location.page === 'app'
			? (app?.name ?? location.clientId)
			: location.page === 'set'
				? (set?.display_name ?? location.setId)
				: location.page === 'tenant'
					? location.tenantName
					: t(
							location.page === 'tenants'
								? 'mc.nav.tenants'
								: location.page === 'sets'
									? 'mc.nav.sets'
									: 'mc.nav.apps'
						)
	);
	function goBack() {
		const previous = trail.at(-1);
		if (previous) move(previous, true);
	}

	const owner = $derived(
		location.tenantId === 'platform' ? t('mc.nav.platform') : location.tenantName
	);
</script>

<Page width="wide">
	<nav class="navigation" aria-label={t('mc.nav.navigation')}>
		<Button
			variant="ghost"
			disabled={busy}
			aria-current={location.page === 'tenants' || location.page === 'tenant' ? 'page' : undefined}
			onclick={() => navigate({ page: 'tenants' })}>{t('mc.nav.tenants')}</Button
		>
		<Button
			variant="ghost"
			disabled={busy}
			aria-current={location.page === 'apps' || location.page === 'app' ? 'page' : undefined}
			onclick={() => navigate({ page: 'apps' })}>{t('mc.nav.apps')}</Button
		>
		<Button
			variant="ghost"
			disabled={busy}
			aria-current={location.page === 'sets' || location.page === 'set' ? 'page' : undefined}
			onclick={() => navigate({ page: 'sets' })}>{t('mc.nav.sets')}</Button
		>
	</nav>
	{#if trail.length > 0}<div>
			<Button variant="ghost" disabled={busy} onclick={goBack}>{t('mc.nav.back')}</Button>
		</div>{/if}
	<PageHeader
		title={heading}
		description={location.page === 'tenants' ? t('mc.nav.tenantsDescription') : undefined}
	>
		{#snippet eyebrow()}{location.page === 'tenants' ? t('mc.nav.platform') : owner}{/snippet}
		{#snippet actions()}
			{#if location.page === 'tenant'}
				<Button disabled={busy} onclick={() => navigate({ page: 'apps' })}
					>{t('mc.nav.apps')}</Button
				>
			{/if}
		{/snippet}
	</PageHeader>
	{#if visitedTenants}
		<div hidden={location.page !== 'tenants'}>
			<MappingRollout
				{client}
				active={location.page === 'tenants'}
				refresh={rolloutRevision}
				onbusy={(value) => (busy = value)}
				ontenant={(id, name) =>
					navigate({ page: 'tenant', tenantId: id, tenantName: name, tab: 'history' })}
				onpreview={(id) =>
					navigate({ page: 'set', tenantId: 'platform', tenantName: '', setId: id })}
			/>
		</div>
	{/if}
	{#if location.page === 'tenants'}{:else if failed && location.page !== 'tenant'}
		<Callout tone="warning"
			>{t('mc.loadFailed')}<Button onclick={load}>{t('mc.retry')}</Button></Callout
		>
	{:else if loading && location.page !== 'tenant'}
		<LoadingState label={t('mc.loading')} />
	{:else if location.page === 'apps'}
		<TextField label={t('mc.nav.searchApps')} bind:value={appSearch} />
		<Card title={t('mc.nav.apps')} flush>
			<DataTable
				caption={t('mc.nav.apps')}
				columns={[
					{ key: 'name', label: t('mc.ex.app') },
					{ key: 'choice', label: t('mc.app.choice') }
				]}
				rows={apps.filter((row) => row.name.toLowerCase().includes(appSearch.toLowerCase()))}
				rowKey={(row) => row.client_id}
			>
				{#snippet cell(row, column)}
					{#if column.key === 'name'}<Button
							variant="ghost"
							onclick={() => navigate({ page: 'app', clientId: row.client_id, tab: 'mapping' })}
							>{row.name}</Button
						>
					{:else if row.identity_mapping === null}{t('mc.app.follow')}
					{:else if 'mode' in row.identity_mapping}{t('mc.app.none')}
					{:else}{sets.find(
							(item) =>
								item.id ===
								('fieldMappingSetId' in (row.identity_mapping ?? {})
									? (row.identity_mapping as { fieldMappingSetId: string }).fieldMappingSetId
									: '')
						)?.display_name ?? t('mc.app.own')}{/if}
				{/snippet}
			</DataTable>
		</Card>
	{:else if location.page === 'sets'}
		<TextField label={t('mc.nav.searchSets')} bind:value={setSearch} />
		<Card title={t('mc.nav.sets')} flush>
			<DataTable
				caption={t('mc.nav.sets')}
				columns={[
					{ key: 'name', label: t('mc.app.set') },
					{ key: 'owner', label: t('mc.source') }
				]}
				rows={sets.filter((row) =>
					(row.display_name ?? row.id).toLowerCase().includes(setSearch.toLowerCase())
				)}
				rowKey={(row) => row.id}
			>
				{#snippet cell(row, column)}
					{#if column.key === 'name'}<Button
							variant="ghost"
							onclick={() => navigate({ page: 'set', setId: row.id })}
							>{row.display_name ?? row.id}</Button
						>
					{:else}{row.owner === 'platform' ? t('mc.nav.platform') : owner}{/if}
				{/snippet}
			</DataTable>
		</Card>
	{:else if location.page === 'set'}
		<SetChangePreview
			{client}
			onchanged={() => ++rolloutRevision}
			tenantId={location.tenantId}
			setId={location.setId}
			edits={location.setId === setId && location.tenantId === tenantId ? seededEdits : undefined}
			{sampleUserId}
			onstate={receiveFormState}
		/>
	{:else}
		<Tabs
			label={heading}
			value={location.tab}
			disabled={busy}
			onbeforechange={(value) => {
				const allowed = !dirty && !busy;
				navigate({ tab: value });
				return allowed;
			}}
			items={location.page === 'app'
				? [
						{ id: 'mapping', label: t('mc.nav.mapping') },
						{ id: 'test', label: t('mc.nav.test') },
						{ id: 'history', label: t('mc.nav.history') }
					]
				: [{ id: 'history', label: t('mc.nav.history') }]}
		>
			{#snippet panel()}
				<div
					class="content"
					role="region"
					aria-label={t(
						location.tab === 'mapping'
							? 'mc.nav.mapping'
							: location.tab === 'test'
								? 'mc.nav.test'
								: 'mc.nav.history'
					)}
				>
					{#if location.page === 'app' && location.tab === 'mapping'}
						<AppMappingChoice
							{client}
							tenantId={location.tenantId}
							clientId={location.clientId}
							onstate={receiveFormState}
							onset={(id) => navigate({ page: 'set', setId: id })}
						/>
					{:else if location.page === 'app' && location.tab === 'test'}
						<ClaimInvestigation
							{client}
							tenantId={location.tenantId}
							clientId={location.clientId}
							bind:userId={sample}
							bind:surface={testSurface}
							bind:consent={testConsent}
							{autorun}
							onmapping={() => navigate({ tab: 'mapping' })}
						/>
					{:else}
						<MappingHistory
							{client}
							onchanged={() => ++rolloutRevision}
							tenantId={location.tenantId}
							clientId={location.page === 'app' ? location.clientId : undefined}
							onbusy={(value) => (busy = value)}
						/>
					{/if}
				</div>
			{/snippet}
		</Tabs>
	{/if}
</Page>
<LeaveConfirm open={pending !== null} onleave={leave} onstay={() => (pending = null)} />

<style>
	.navigation {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-related);
		border-bottom: 1px solid var(--border);
		padding-bottom: var(--space-related);
	}
	.navigation :global([aria-current='page']) {
		background: var(--bg-hover);
		color: var(--text-primary);
	}
	.content {
		min-width: 0;
	}
</style>
