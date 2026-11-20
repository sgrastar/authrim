<script lang="ts">
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { StepUpCancelledError } from '#lib/api/admin-step-up.js';
	import { ApiError } from '#lib/api/api-error.js';
	import type {
		FederationEntity,
		FederationRefreshHistoryItem,
		FederationSource,
		FederationSourcesClient
	} from '#lib/api/federation-sources.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import Button from '#lib/ui/primitives/Button.svelte';
	import BackLink from '#lib/ui/primitives/BackLink.svelte';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import LoadingState from '#lib/ui/patterns/LoadingState.svelte';
	import PageHeader from '#lib/ui/patterns/PageHeader.svelte';
	import SaveBar from '#lib/ui/patterns/SaveBar.svelte';
	import {
		federationFormOf,
		federationProblems,
		federationUpdateInput,
		type FederationForm,
		type FederationMappingOption
	} from '../federation-model';
	import FederationStatusBadge from '../FederationStatusBadge.svelte';
	import { federationStatus } from '../federation-model';
	import LeaveGuard from '../LeaveGuard.svelte';
	import FederationDangerZone from './FederationDangerZone.svelte';
	import FederationEntitiesCard from './FederationEntitiesCard.svelte';
	import FederationExceptionsCard from './FederationExceptionsCard.svelte';
	import FederationMaterializeDialog from './FederationMaterializeDialog.svelte';
	import FederationParticipationCard from './FederationParticipationCard.svelte';
	import FederationStatusCard from './FederationStatusCard.svelte';
	import FederationTrustCard from './FederationTrustCard.svelte';
	import { formChanged, snapshotForm } from './federation-page-model';

	/**
	 * A SAML federation's own page: whether it is keeping up, who takes part, who is set aside,
	 * the entities it holds, what it is trusted on, and deleting it. What is edited (the roles,
	 * the exceptions, the address and certificates) is saved together from the bar at the bottom;
	 * a change made by someone else in the meantime is refused and offered as a reload.
	 */
	interface Props {
		id: string;
		client: FederationSourcesClient;
		/** The roles, exceptions and trust may be edited (and the federation deleted). */
		canEdit: boolean;
		/** "Update now" is offered. */
		canRefresh: boolean;
		/** "Make an individual connection" is offered. */
		canMaterialize: boolean;
		loadMappingSets: () => Promise<FederationMappingOption[]>;
		onback: () => void;
		onnavigate?: (path: string) => void | Promise<void>;
	}
	let {
		id,
		client,
		canEdit,
		canRefresh,
		canMaterialize,
		loadMappingSets,
		onback,
		onnavigate = goto
	}: Props = $props();

	let source = $state<FederationSource | null>(null);
	let history = $state<FederationRefreshHistoryItem[]>([]);
	let form = $state<FederationForm | null>(null);
	let original = $state('');
	let phase = $state<'loading' | 'ready' | 'failed'>('loading');
	let saving = $state(false);
	let refreshing = $state(false);
	let failure = $state('');
	let conflict = $state(false);
	let refreshFailure = $state('');
	let revision = $state(0);
	let materializing = $state<FederationEntity | null>(null);
	let mappingSets = $state<FederationMappingOption[]>([]);
	let mappingLoading = $state(false);
	let mappingFailed = $state(false);

	const dirty = $derived(form !== null && formChanged(form, original));
	const invalid = $derived(form !== null && federationProblems(form).length > 0);

	/** Reads the federation again; what was typed is replaced by what the server holds. */
	async function load() {
		failure = '';
		conflict = false;
		try {
			const read = await client.get(id);
			source = read;
			form = federationFormOf(read);
			original = snapshotForm(form);
			phase = 'ready';
			history = await client.refreshHistory(id, 10).catch(() => []);
		} catch {
			if (phase !== 'ready') phase = 'failed';
		}
	}
	async function loadSets() {
		mappingLoading = true;
		mappingFailed = false;
		try {
			mappingSets = await loadMappingSets();
		} catch {
			mappingFailed = true;
		} finally {
			mappingLoading = false;
		}
	}
	onMount(() => {
		void load();
		void loadSets();
	});

	function describe(error: unknown, fallback: string): string {
		if (error instanceof StepUpCancelledError) return t('settings.stepUpCancelled');
		return error instanceof Error && error.message ? error.message : fallback;
	}

	async function save() {
		if (!source || !form || saving || invalid) return;
		saving = true;
		failure = '';
		conflict = false;
		try {
			await client.update(id, federationUpdateInput(form, source));
			await load();
			revision++;
		} catch (error) {
			conflict = error instanceof ApiError && error.status === 409;
			failure = conflict ? t('sf.live.conflict') : describe(error, t('sf.fed.saveFailed'));
		} finally {
			saving = false;
		}
	}

	function discard() {
		if (source) form = federationFormOf(source);
		failure = '';
		conflict = false;
	}

	async function refresh() {
		if (refreshing) return;
		refreshing = true;
		refreshFailure = '';
		try {
			await client.refresh(id);
			// Typed-over fields stay: only what the server holds about the fetch is read again.
			// The fetch moves the version too: take it, or the next save would be refused. With
			// unsaved edits the new version is adopted only if what is editable is as it was read;
			// otherwise someone else changed it, and the save must be refused, not silently win.
			const read = await client.get(id);
			const fresh = snapshotForm(federationFormOf(read));
			if (!dirty) {
				source = read;
				form = federationFormOf(read);
				original = snapshotForm(form);
			} else if (fresh === original) {
				source = read;
			} else {
				// The configuration is kept as read, so the save is refused; the fetch's own
				// standing is still the news it should show.
				if (source) source = { ...source, status: read.status };
				conflict = true;
				failure = t('sf.live.conflict');
			}
			history = await client.refreshHistory(id, 10).catch(() => history);
			revision++;
		} catch (error) {
			refreshFailure = describe(error, t('sf.fed.created.failed'));
		} finally {
			refreshing = false;
		}
	}
</script>

<LeaveGuard {dirty} />

{#snippet back()}<BackLink onclick={onback}>{t('sf.detail.back')}</BackLink>{/snippet}

{#if phase === 'loading'}
	<LoadingState label={t('common.loading')} />
{:else if phase === 'failed' || !source || !form}
	<Callout tone="warning" live>
		{t('mc.loadFailed')}
		<Button size="sm" onclick={load}>{t('common.retry')}</Button>
	</Callout>
{:else}
	<PageHeader title={source.name} description={t('sf.protocol.federation')} {back}>
		{#snippet badges()}<FederationStatusBadge status={federationStatus(source!)} />{/snippet}
	</PageHeader>
	{#if failure}
		<Callout tone="danger" live>
			{failure}
			{#if conflict}<Button size="sm" onclick={load}>{t('sf.live.reload')}</Button>{/if}
		</Callout>
	{/if}
	{#if !canEdit}<Callout tone="info">{t('sf.fed.readonly')}</Callout>{/if}
	<div class="federation">
		<FederationStatusCard
			{source}
			{history}
			{canRefresh}
			{refreshing}
			failure={refreshFailure}
			onrefresh={refresh}
		/>
		<FederationParticipationCard
			bind:form
			{mappingSets}
			{mappingFailed}
			{mappingLoading}
			onreloadmappings={loadSets}
			disabled={!canEdit}
		/>
		<FederationExceptionsCard
			sourceId={id}
			{client}
			bind:excluded={form.excludedEntityIds}
			disabled={!canEdit}
		/>
		<FederationEntitiesCard
			sourceId={id}
			{client}
			bind:excluded={form.excludedEntityIds}
			{canEdit}
			{revision}
			onmaterialize={canMaterialize ? (entity) => (materializing = entity) : undefined}
		/>
		<FederationTrustCard bind:form disabled={!canEdit} />
		{#if canEdit}
			<FederationDangerZone sourceId={id} name={source.name} {client} ondeleted={onback} />
		{/if}
	</div>
	<FederationMaterializeDialog
		entity={materializing}
		{source}
		{client}
		{mappingSets}
		oncancel={() => (materializing = null)}
		oncreated={(made) => {
			materializing = null;
			// The entity now has a connection of its own: its row says so, and its page opens.
			revision++;
			void onnavigate(
				`/admin/applications/all/${made.providerType}/${encodeURIComponent(made.providerId)}`
			);
		}}
	/>
	{#if canEdit}
		<SaveBar {dirty} {saving} {invalid} onsave={save} ondiscard={discard} />
	{/if}
{/if}

<style>
	.federation {
		display: grid;
		gap: var(--space-section, 24px);
	}
</style>
