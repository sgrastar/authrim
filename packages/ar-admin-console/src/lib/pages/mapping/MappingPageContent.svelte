<script module lang="ts">
	export type MappingPage = 'tenants' | 'tenant' | 'app' | 'sets' | 'set';
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

	/**
	 * Page contents for existing Shell destinations. The Shell owns category and scope navigation.
	 * Only list/detail transitions within a destination and tabs within one app are demonstrated here.
	 * Service-flow integration and links across Shell destinations are designed separately.
	 */
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
		page = 'app',
		tab = 'mapping',
		clientId = 'app_library',
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
			if (location.page === 'app') {
				const nextApps = await client.apps(owner);
				if (mine === generation) apps = nextApps;
			} else {
				const nextSets = await client.sets(owner);
				if (mine === generation) sets = nextSets.sets;
			}
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
		else if (next.page !== location.page) trail = [...trail, { ...location }];
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
		t(
			location.page === 'app'
				? 'mc.page.appTitle'
				: location.page === 'set'
					? 'mc.page.setTitle'
					: location.page === 'tenant'
						? 'mc.hist.title'
						: location.page === 'tenants'
							? 'nav.pt.list'
							: 'nav.data.mappingSets'
		)
	);
	const description = $derived(
		t(
			location.page === 'app'
				? location.tab === 'test'
					? 'mc.ex.desc'
					: location.tab === 'history'
						? 'mc.hist.appDesc'
						: 'mc.app.desc'
				: location.page === 'set'
					? 'mc.ch.desc'
					: location.page === 'tenant'
						? 'mc.hist.desc'
						: location.page === 'tenants'
							? 'mc.nav.tenantsDescription'
							: 'mc.page.setsDesc'
		)
	);
	function goBack() {
		const previous = trail.at(-1);
		if (previous) move(previous, true);
	}

	const owner = $derived(
		location.tenantId === 'platform' ? t('mc.nav.platform') : location.tenantName
	);
	const context = $derived(
		location.page === 'tenants'
			? t('mc.nav.platform')
			: location.page === 'tenant'
				? `${t('nav.platArea.tenants')} / ${owner}`
				: location.page === 'app'
					? `${t('nav.applications')} / ${owner} / ${app?.name ?? location.clientId}`
					: [
							t('nav.access'),
							t('nav.data.mappingSets'),
							owner,
							location.page === 'set' ? (set?.display_name ?? location.setId) : ''
						]
							.filter(Boolean)
							.join(' / ')
	);
</script>

<Page width="wide">
	{#if trail.length > 0}<div>
			<Button variant="ghost" disabled={busy} onclick={goBack}>{t('mc.nav.back')}</Button>
		</div>{/if}
	<PageHeader title={heading} {description}>
		{#snippet eyebrow()}{context}{/snippet}
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
			/>
		</div>
	{/if}
	{#if location.page === 'tenants'}{:else if failed && location.page !== 'tenant'}
		<Callout tone="warning"
			>{t('mc.loadFailed')}<Button onclick={load}>{t('mc.retry')}</Button></Callout
		>
	{:else if loading && location.page !== 'tenant'}
		<LoadingState label={t('mc.loading')} />
	{:else if location.page === 'sets'}
		<TextField label={t('mc.nav.searchSets')} bind:value={setSearch} />
		<Card title={t('mc.nav.sets')} flush>
			<DataTable
				caption={t('mc.nav.sets')}
				columns={[
					{ key: 'name', label: t('mc.ro.setLabel') },
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
	{:else if location.page === 'tenant'}
		<MappingHistory
			{client}
			onchanged={() => ++rolloutRevision}
			tenantId={location.tenantId}
			onbusy={(value) => (busy = value)}
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
			items={[
				{ id: 'mapping', label: t('mc.nav.mapping') },
				{ id: 'test', label: t('mc.nav.test') },
				{ id: 'history', label: t('mc.nav.history') }
			]}
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
							clientId={location.clientId}
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
	.content {
		min-width: 0;
	}
</style>
