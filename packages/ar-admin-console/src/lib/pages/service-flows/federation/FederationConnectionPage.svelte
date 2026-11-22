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
	import { tick, untrack } from 'svelte';
	import type { DestinationProfilesClient } from '#lib/api/destination-profiles.js';
	import type { IdentityMappingClient } from '#lib/api/identity-mapping.js';
	import ConnectionMapping from '../ConnectionMapping.svelte';
	import type { ConnectionMappingResources } from '../connection-mapping.svelte.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import FlowCanvas from '#lib/ui/flow/FlowCanvas.svelte';
	import FlowEdge from '#lib/ui/flow/FlowEdge.svelte';
	import FlowEndpoint from '#lib/ui/flow/FlowEndpoint.svelte';
	import FlowScope from '#lib/ui/flow/FlowScope.svelte';
	import FlowSequence from '#lib/ui/flow/FlowSequence.svelte';
	import FlowStepGroup from '#lib/ui/flow/FlowStepGroup.svelte';
	import { revealPanel } from '#lib/ui/flow/reveal-panel.js';
	import { labelOf } from '../connection-model';
	import Button from '#lib/ui/primitives/Button.svelte';
	import BackLink from '#lib/ui/primitives/BackLink.svelte';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import LoadingState from '#lib/ui/patterns/LoadingState.svelte';
	import PageHeader from '#lib/ui/patterns/PageHeader.svelte';
	import SaveBar from '#lib/ui/patterns/SaveBar.svelte';
	import {
		federationFormOf,
		federationInUse,
		federationProblems,
		federationSetupProblems,
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
	import FederationRequestedAttributes from './FederationRequestedAttributes.svelte';
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
		/**
		 * What the SP role's mapping is made with: the mapping set (and the output source it sends
		 * into) is made and chosen on this page, like a service's. Absent: only an existing set can be
		 * chosen.
		 */
		outboundMapping?: {
			client: IdentityMappingClient;
			profiles: DestinationProfilesClient;
			tenantId: string;
		};
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
		outboundMapping,
		onback,
		onnavigate = goto
	}: Props = $props();

	let source = $state<FederationSource | null>(null);
	let history = $state<FederationRefreshHistoryItem[]>([]);
	let form = $state<FederationForm | null>(null);
	let original = $state('');
	let phase = $state<'loading' | 'ready' | 'failed'>('loading');
	let saving = $state(false);
	// The SP role's mapping (a ConnectionMapping with its own save) beside this page's save: they do
	// not run together, and a discard or a reload starts the mapping again from what the form holds.
	let mappingEpoch = $state(0);
	let mappingPending = $state(false);
	let mappingDirty = $state(false);
	// The attribute names of the output source the SP role's mapping uses, from the open mapping.
	let sendableAttributes = $state<ReadonlySet<string> | null>(null);
	let outputChosen = $state(false);
	let refreshing = $state(false);
	let failure = $state('');
	let conflict = $state(false);
	let refreshFailure = $state('');
	let revision = $state(0);
	let materializing = $state<FederationEntity | null>(null);
	let mappingSets = $state<FederationMappingOption[]>([]);
	let mappingLoading = $state(false);
	let mappingFailed = $state(false);

	// The service flow the federation was made with: the roles on decide the flow and what is shown.
	const spRole = $derived(form?.spRole === true);
	const idpRole = $derived(form?.idpRole === true);
	/** The entities listed are the other side of the role: Authrim as IdP (SP role) lists SPs. */
	const entityRole = $derived(
		spRole && !idpRole
			? ('saml_sp' as const)
			: idpRole && !spRole
				? ('saml_idp' as const)
				: undefined
	);
	/** The node that is open: '' is the general settings, 'mapping-sets' the mapping node. */
	let current = $state('');
	let rightPanel = $state<HTMLElement | null>(null);
	const mappingSelected = $derived(current === 'mapping-sets');
	/** The output source of the SP role's mapping, in a node of its own before the mapping. */
	const outputSelected = $derived(current === 'mapping-schemas');
	/** The SP role sends Authrim's people to the federation's services: its mapping is made here. */
	const mappingResources = $derived<ConnectionMappingResources | null>(
		outboundMapping && spRole
			? {
					client: outboundMapping.client,
					profiles: outboundMapping.profiles,
					tenantId: outboundMapping.tenantId,
					protocol: 'saml',
					connectionId: id,
					connectionName: source?.name,
					// The federation's own form holds the choice, and is saved with the page.
					readBinding: async () => ({ setId: form?.spMappingSetId ?? '', pinned: false }),
					bind: async (set) => {
						if (form) form.spMappingSetId = set.id;
					}
				}
			: null
	);
	const exclusionSelected = $derived(current === 'exclusions');
	// The SP role was switched off while its output source was open: there is nothing to show.
	$effect(() => {
		if (current === 'mapping-schemas' && !mappingResources) current = '';
	});
	const excludedCount = $derived(form?.excludedEntityIds.length ?? 0);
	const mappingState = $derived(form && federationInUse(form) ? 'done' : 'todo');
	/** How many entities of the side the service flow works with, and how many of them are set aside. */
	let counts = $state<{ total: number; excluded: number } | null>(null);
	let countsTurn = 0;
	async function loadCounts() {
		const turn = ++countsTurn;
		if (!entityRole) {
			counts = null;
			return;
		}
		try {
			const [total, excluded] = await Promise.all([
				client.entities(id, { role: entityRole, limit: 1 }),
				client.entities(id, { role: entityRole, state: 'excluded', limit: 1 })
			]);
			// Only the latest read counts: an older one finishing last would show a stale number.
			if (turn === countsTurn) counts = { total: total.total, excluded: excluded.total };
		} catch {
			if (turn === countsTurn) counts = null;
		}
	}
	$effect(() => {
		// The role or a fresh read of the federation (a fetch, a save) changes what is counted.
		void entityRole;
		void revision;
		void source?.updatedAt;
		void (source?.status?.lastSuccessAt ?? null);
		untrack(() => void loadCounts());
	});
	async function selectNode(node: string) {
		current = node;
		await tick();
		revealPanel(rightPanel);
	}

	const dirty = $derived(form !== null && formChanged(form, original));
	// One in use cannot be saved half-set (a role added without its mapping set would switch the
	// whole federation off); one that is not yet in use can be saved as far as it is set.
	const invalid = $derived(
		form !== null &&
			(federationSetupProblems(form).length > 0 ||
				(source?.automatic === true && !federationInUse(form)))
	);

	/** Reads the federation again; what was typed is replaced by what the server holds. */
	async function load() {
		failure = '';
		conflict = false;
		try {
			const read = await client.get(id);
			source = read;
			form = federationFormOf(read);
			original = snapshotForm(form);
			mappingEpoch++;
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
		if (!source || !form || saving || mappingPending || invalid) return;
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
		mappingEpoch++;
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

<LeaveGuard dirty={dirty || mappingDirty} />

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
	{#if form && !federationInUse(form)}
		<Callout tone="info" title={t('sf.fed.notInUse.title')}>
			{t('sf.fed.notInUse.body')}
			<ul class="remaining">
				{#each federationProblems(form).filter( (p) => ['spMappingSet', 'idpMappingSet', 'discoveryServiceUrl'].includes(p.field) ) as problem (problem.field)}<li
					>
						{problem.message}
					</li>{/each}
			</ul>
		</Callout>
	{/if}
	<div class="detail">
		<div class="detail__flow">
			<FlowCanvas
				label={source.name}
				heading={t('sf.detail.signIn')}
				detail={idpRole ? t('sf.role.in.line') : undefined}
			>
				{#if idpRole || !spRole}
					<FlowEndpoint
						kind="authrim"
						title={t('sf.detail.signInPage')}
						detail={t('sf.detail.peopleChoose', { name: source.name })}
					/>
				{:else}
					<FlowEndpoint
						title={source.name}
						detail={t('sf.fed.flow.services')}
						actionLabel={t('af.general')}
						onselect={() => selectNode('')}
					/>
				{/if}
				<FlowEdge length={24} tip={false} />
				<FlowScope label={t('sf.detail.authrimDoes')}>
					<!-- The mapping is not optional: what comes through is the mapping's, so it is always there. -->
					<FlowSequence
						order={[...(mappingResources ? ['output'] : []), 'mapping', 'exclusions']}
						visible={[...(mappingResources ? ['output'] : []), 'mapping', 'exclusions']}
						lead={36}
						trail={6}
						menuTitle={source.name}
						option={(node) => ({
							id: node,
							label: t(
								node === 'output'
									? 'sf.group.schemas'
									: node === 'mapping'
										? 'sf.group.mapping'
										: 'sf.fed.flow.exclusions'
							)
						})}
						onadd={selectNode}
					>
						{#snippet step(node, { exiting })}
							{#if node === 'output'}
								<!-- The output source the SP role sends into: its own node, apart from the mapping. -->
								<FlowStepGroup
									name={t('sf.group.schemas')}
									state={outputChosen ? 'done' : 'todo'}
									{current}
									{exiting}
									onselect={selectNode}
									items={[
										{
											id: 'mapping-schemas',
											label: labelOf('mapping-schemas'),
											state: outputChosen ? 'done' : 'todo',
											status: t(outputChosen ? 'sf.status.done' : 'sf.status.todo')
										}
									]}
								/>
							{:else if node === 'mapping'}
								<FlowStepGroup
									name={t('sf.group.mapping')}
									state={mappingState}
									{current}
									{exiting}
									onselect={selectNode}
									items={[
										{
											id: 'mapping-sets',
											label: labelOf('mapping-sets'),
											required: true,
											state: mappingState,
											status: t(mappingState === 'done' ? 'sf.status.done' : 'sf.status.todo')
										}
									]}
								/>
							{:else}
								<!-- Who is set aside and the entities: always there, nothing in it is required. -->
								<FlowStepGroup
									name={t('sf.fed.flow.exclusions')}
									state="done"
									{current}
									{exiting}
									onselect={selectNode}
									items={[
										{
											id: 'exclusions',
											label: t('sf.fed.flow.exclusionsItem'),
											state: 'done',
											status:
												excludedCount > 0
													? t('sf.fed.flow.exclusionsCount', { count: excludedCount })
													: t('sf.fed.flow.exclusionsNone')
										}
									]}
								/>
							{/if}
						{/snippet}
					</FlowSequence>
				</FlowScope>
				<FlowEdge length={14} />
				{#if idpRole || !spRole}
					<FlowEndpoint
						title={source.name}
						detail={t('sf.blurb.federation')}
						actionLabel={t('af.general')}
						onselect={() => selectNode('')}
					/>
				{:else}
					<FlowEndpoint
						kind="authrim"
						title={t('sf.fed.flow.authrim')}
						detail={t('sf.fed.flow.authrimDetail')}
					/>
				{/if}
			</FlowCanvas>
		</div>
		<div class="detail__side" bind:this={rightPanel}>
			<div class="detail__general" hidden={mappingSelected || outputSelected || exclusionSelected}>
				<FederationStatusCard
					{source}
					{history}
					{canRefresh}
					{refreshing}
					failure={refreshFailure}
					onrefresh={refresh}
					entityCount={entityRole ? (counts?.total ?? null) : undefined}
					excludedCount={entityRole ? (counts?.excluded ?? null) : undefined}
				/>
				<FederationTrustCard
					bind:form
					disabled={!canEdit}
					readCertificateUrl={canMaterialize
						? async (url) => (await client.previewCertificateUrl(url)).certificate
						: undefined}
				/>
				{#if canEdit}
					<FederationDangerZone sourceId={id} name={source.name} {client} ondeleted={onback} />
				{/if}
			</div>
			<div class="detail__general" hidden={!exclusionSelected}>
				<FederationParticipationCard
					section="participation"
					bind:form
					{mappingSets}
					{mappingFailed}
					{mappingLoading}
					onreloadmappings={loadSets}
					disabled={!canEdit}
					spMappingManaged={mappingResources !== null}
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
					onlyRole={entityRole}
					onmaterialize={canMaterialize ? (entity) => (materializing = entity) : undefined}
				/>
			</div>
			<div class="detail__general" hidden={!mappingSelected && !outputSelected}>
				{#if !outputSelected}<FederationParticipationCard
						section="mapping"
						bind:form
						{mappingSets}
						{mappingFailed}
						{mappingLoading}
						onreloadmappings={loadSets}
						disabled={!canEdit}
						spMappingManaged={mappingResources !== null}
					/>{/if}
				{#if mappingResources && !outputSelected}
					<FederationRequestedAttributes
						{client}
						{id}
						sendable={sendableAttributes}
						refreshKey={revision}
					/>
				{/if}
				{#if mappingResources}
					{#key `${id}:${mappingEpoch}`}
						<ConnectionMapping
							section={outputSelected ? 'output' : 'mapping'}
							resources={mappingResources}
							explain={false}
							readonly={!canEdit}
							disabled={saving || refreshing}
							guardNavigation={false}
							bind:pending={mappingPending}
							bind:dirty={mappingDirty}
							bind:outputChosen
							bind:sendable={sendableAttributes}
						/>
					{/key}
				{/if}
			</div>
		</div>
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
		<!-- While the SP role's mapping has unsaved changes its own bar is the one shown; the page's
		     returns once the mapping is saved (which puts the set into this form). -->
		<SaveBar dirty={dirty && !mappingDirty} {saving} {invalid} onsave={save} ondiscard={discard} />
	{/if}
{/if}

<style>
	.remaining {
		margin: 0;
		padding-inline-start: 1.2em;
	}
	.detail__side > [hidden] {
		display: none;
	}
	.detail {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr);
		gap: var(--space-columns);
		align-items: start;
	}
	.detail__side,
	.detail__general {
		display: flex;
		flex-direction: column;
		gap: var(--space-columns);
		min-width: 0;
	}
	@media (max-width: 900px) {
		.detail {
			grid-template-columns: minmax(0, 1fr);
		}
	}
</style>
