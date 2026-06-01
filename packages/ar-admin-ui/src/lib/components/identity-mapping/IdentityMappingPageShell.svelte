<script lang="ts">
	import { onMount } from 'svelte';
	import { adminIdentityMappingAPI } from '$lib/api/admin-identity-mapping';
	import IdentityMappingFlowEditor from '$lib/components/identity-mapping/IdentityMappingFlowEditor.svelte';
	import { buildIdentityMappingFlowSamples } from '$lib/components/identity-mapping/flow-data';
	import type { MappingDraftPayload, MappingSample } from '$lib/components/identity-mapping/types';
	import type {
		IdentityMappingCatalogSummary,
		IdentityMappingPolicyVersionSummary,
		IdentityMappingPolicySummary
	} from '$lib/api/admin-identity-mapping';

	type ViewMode = 'overview' | 'inbound' | 'outbound';

	const {
		pageTitle = 'Identity Mapping',
		pageDescription = 'Preview inbound sources, canonical identity targets, and outbound projections from one control-plane view.',
		headTitle = pageTitle,
		editorAllowedViewModes = ['overview', 'inbound', 'outbound'],
		editorInitialViewMode = 'overview',
		editorEditable = true,
		showEditorToolbarSourceProfile = true,
		showEditorToolbarModeToggle = true,
		showEditorMetrics = true,
		showProfileModeControl = false,
		laneSelectorMode = 'profile',
		showGraphPolicyDraftLabel = true,
		showCompileDraftButton = true,
		showPolicySaveControl = false,
		primaryActionLabel = 'Compile draft',
		primaryActionBusyLabel = 'Compiling...'
	} = $props<{
		pageTitle?: string;
		pageDescription?: string;
		headTitle?: string;
		editorAllowedViewModes?: ViewMode[];
		editorInitialViewMode?: ViewMode;
		editorEditable?: boolean;
		showEditorToolbarSourceProfile?: boolean;
		showEditorToolbarModeToggle?: boolean;
		showEditorMetrics?: boolean;
		showProfileModeControl?: boolean;
		laneSelectorMode?: 'profile' | 'policy';
		showGraphPolicyDraftLabel?: boolean;
		showCompileDraftButton?: boolean;
		showPolicySaveControl?: boolean;
		primaryActionLabel?: string;
		primaryActionBusyLabel?: string;
	}>();

	let loading = $state(true);
	let loadError = $state<string | null>(null);
	let flowSamples = $state<MappingSample[]>([]);
	let policySummaries = $state<IdentityMappingPolicySummary[]>([]);
	let policyVersionsByPolicyId = $state<Record<string, IdentityMappingPolicyVersionSummary[]>>({});
	let catalogSummaries = $state<IdentityMappingCatalogSummary[]>([]);
	let editMode = $state<Extract<ViewMode, 'inbound' | 'outbound'>>('inbound');
	let selectedInboundProfileId = $state<string | null>(null);
	let selectedOutboundProfileId = $state<string | null>(null);
	let policyDisplayName = $state('Identity Mapping UI Draft');
	let editorDraftResetKey = $state(0);
	let editorHasUnsavedDraftChanges = $state(false);
	let summary = $state({
		policies: 0,
		catalogs: 0,
		profiles: 0,
		federationTrustSources: 0
	});
	const sourceProfileOptions = $derived(
		flowSamples.map((sample) => ({
			id: sample.id,
			title: sample.title
		}))
	);
	const destinationProfileOptions = $derived(destinationProfileOptionsFromSamples(flowSamples));
	const selectedEditorProfileId = $derived(
		editMode === 'inbound' ? selectedInboundProfileId : selectedOutboundProfileId
	);
	const policySelectorOptions = $derived(
		policySummaries.flatMap((policy) =>
			(policyVersionsByPolicyId[policy.id] ?? [])
				.filter((version) => isActivePolicyVersion(policy, version))
				.flatMap((version) => {
					const title = `${policy.displayName || policy.policyKey} / ${version.versionLabel}`;
					const base = {
						id: `${policy.id}:${version.id}`,
						title,
						policyId: policy.id,
						versionId: version.id,
						sourceProfileIds: version.sourceProfileIds ?? [],
						destinationProfileIds: version.destinationProfileIds ?? []
					};
					const directions = version.directions ?? { inbound: false, outbound: false };
					const options = [];
					if (directions.inbound) {
						options.push({ ...base, id: `${base.id}:inbound`, direction: 'inbound' as const });
					}
					if (directions.outbound) {
						options.push({ ...base, id: `${base.id}:outbound`, direction: 'outbound' as const });
					}
					return options;
				})
		)
	);
	const editorSamples = $derived(
		laneSelectorMode === 'policy' && policySelectorOptions.length === 0 ? [] : flowSamples
	);

	$effect(() => {
		if (!selectedInboundProfileId && sourceProfileOptions.length > 0) {
			selectedInboundProfileId = sourceProfileOptions[0].id;
		}
		if (!selectedOutboundProfileId && destinationProfileOptions.length > 0) {
			selectedOutboundProfileId =
				destinationProfileOptions.find((option) => option.adapter === 'OIDC')?.id ??
				destinationProfileOptions[0].id;
		}
	});

	function destinationProfileOptionsFromSamples(samples: MappingSample[]) {
		const seen: string[] = [];
		return samples.flatMap((sample) =>
			sample.nodes
				.filter((node) => node.role === 'destination')
				.flatMap((node) => {
					const id = node.profileId ?? node.adapter ?? node.id;
					if (seen.includes(id)) return [];
					seen.push(id);
					return [
						{
							id,
							title: node.profileTitle ?? `${node.adapter ?? 'Destination'} profile`,
							adapter: node.adapter
						}
					];
				})
		);
	}

	function selectEditProfile(event: Event) {
		const select = event.currentTarget as HTMLSelectElement;
		const value = select.value || null;
		if (value === selectedEditorProfileId) return;
		if (!confirmDiscardEditorDraft()) {
			select.value = selectedEditorProfileId ?? '';
			return;
		}
		if (editMode === 'inbound') {
			selectedInboundProfileId = value;
		} else {
			selectedOutboundProfileId = value;
		}
		resetEditorDraft();
	}

	function selectEditMode(nextMode: Extract<ViewMode, 'inbound' | 'outbound'>) {
		if (nextMode === editMode) return;
		if (!confirmDiscardEditorDraft()) return;
		editMode = nextMode;
		resetEditorDraft();
	}

	function confirmDiscardEditorDraft(): boolean {
		if (!editorHasUnsavedDraftChanges) return true;
		return window.confirm('You have unsaved mapping draft changes. Discard them and switch view?');
	}

	function resetEditorDraft() {
		editorDraftResetKey += 1;
		editorHasUnsavedDraftChanges = false;
	}

	async function compileEditorDraft(draft: MappingDraftPayload) {
		const catalogVersionId = catalogSummaries.find((catalog) => catalog.versionId)?.versionId;
		if (!catalogVersionId) {
			throw new Error('No canonical catalog version is available for compile.');
		}
		const displayName = policyDisplayName.trim() || 'Identity Mapping UI Draft';
		const policyKey = policyKeyFromDisplayName(displayName);
		let policy = policySummaries.find((candidate) => candidate.policyKey === policyKey);
		if (!policy) {
			const createdPolicy = await adminIdentityMappingAPI.createPolicy({
				policyKey,
				displayName,
				description: 'Draft policy set created from the Admin UI Flow Editor.'
			});
			policy = createdPolicy.result;
			policySummaries = [policy, ...policySummaries];
		}
		const version = await adminIdentityMappingAPI.createPolicyVersion(policy.id, {
			versionLabel: draft.versionLabel,
			compatibilityRange: draft.compatibilityRange,
			rules: draft.rules
		});
		await adminIdentityMappingAPI.compilePolicyVersion(policy.id, version.result.id, {
			catalogVersionId,
			metadata: {
				source: 'admin_ui_flow_editor',
				policyDisplayName: displayName,
				...draft.metadata
			}
		});
		editorHasUnsavedDraftChanges = false;
	}

	function policyKeyFromDisplayName(value: string): string {
		const key = value
			.trim()
			.toLowerCase()
			.normalize('NFKC')
			.replace(/[^\p{L}\p{N}]+/gu, '-')
			.replace(/^-|-$/g, '')
			.slice(0, 80);
		return key || 'identity-mapping-ui-draft';
	}

	function isActivePolicyVersion(
		policy: IdentityMappingPolicySummary,
		version: IdentityMappingPolicyVersionSummary
	): boolean {
		if (policy.lifecycleState !== 'active') return false;
		return (
			version.lifecycleState === 'active' || version.latestSnapshot?.lifecycleState === 'active'
		);
	}

	onMount(async () => {
		try {
			const [
				policies,
				catalogs,
				sourceProfiles,
				destinationProfiles,
				protocolSchemas,
				externalSchemas,
				federationTrustSources,
				schemaReadiness
			] = await Promise.all([
				adminIdentityMappingAPI.listPolicies(),
				adminIdentityMappingAPI.listCatalogs(),
				adminIdentityMappingAPI.listSourceProfiles(),
				adminIdentityMappingAPI.listDestinationProfiles(),
				adminIdentityMappingAPI.listProtocolSchemas(),
				adminIdentityMappingAPI.listExternalSchemas(),
				adminIdentityMappingAPI.listFederationTrustSources(),
				adminIdentityMappingAPI.getSchemaReadiness()
			]);

			summary = {
				policies: policies.policies.length,
				catalogs: catalogs.catalogs.length,
				profiles:
					sourceProfiles.sourceProfiles.length +
					destinationProfiles.destinationProfiles.length +
					protocolSchemas.protocolSchemas.length +
					externalSchemas.externalSchemas.length,
				federationTrustSources: federationTrustSources.federationTrustSources.length
			};
			policySummaries = policies.policies;
			policyVersionsByPolicyId = Object.fromEntries(
				await Promise.all(
					policies.policies.map(async (policy) => {
						const versions = await adminIdentityMappingAPI.listPolicyVersions(policy.id);
						return [policy.id, versions.policyVersions] as const;
					})
				)
			);
			catalogSummaries = catalogs.catalogs;
			flowSamples = buildIdentityMappingFlowSamples({
				policies: policies.policies,
				catalogs: catalogs.catalogs,
				sourceProfiles: sourceProfiles.sourceProfiles,
				destinationProfiles: destinationProfiles.destinationProfiles,
				protocolSchemas: protocolSchemas.protocolSchemas,
				externalSchemas: externalSchemas.externalSchemas,
				schemaReadinessRows: schemaReadiness.rows
			});
		} catch (error) {
			loadError = error instanceof Error ? error.message : 'Failed to load identity mapping state';
		} finally {
			loading = false;
		}
	});
</script>

<svelte:head>
	<title>{headTitle} - Authrim Admin</title>
</svelte:head>

<div class="identity-mapping-page">
	<div class="page-heading">
		<div>
			<h1>{pageTitle}</h1>
			<p class="summary">
				{pageDescription}
			</p>
			{#if showProfileModeControl}
				<div class="profile-mode-control" aria-label="Mapping edit profile selector">
					<div class="profile-mode-radio" role="radiogroup" aria-label="Mapping direction">
						<label>
							<input
								type="radio"
								name="mappingEditMode"
								value="inbound"
								checked={editMode === 'inbound'}
								onchange={() => selectEditMode('inbound')}
							/>
							<span>Inbound</span>
						</label>
						<label>
							<input
								type="radio"
								name="mappingEditMode"
								value="outbound"
								checked={editMode === 'outbound'}
								onchange={() => selectEditMode('outbound')}
							/>
							<span>Outbound</span>
						</label>
					</div>
					<select
						aria-label={editMode === 'inbound'
							? 'Inbound source profile'
							: 'Outbound destination profile'}
						value={selectedEditorProfileId ?? ''}
						onchange={selectEditProfile}
					>
						<option value="" disabled>
							{editMode === 'inbound' ? 'Select source profile' : 'Select destination profile'}
						</option>
						{#if editMode === 'inbound'}
							{#each sourceProfileOptions as option (option.id)}
								<option value={option.id}>{option.title}</option>
							{/each}
						{:else}
							{#each destinationProfileOptions as option (option.id)}
								<option value={option.id}>{option.title}</option>
							{/each}
						{/if}
					</select>
				</div>
			{/if}
			{#if showPolicySaveControl}
				<label class="policy-save-control">
					<span>Policy name</span>
					<input
						type="text"
						bind:value={policyDisplayName}
						placeholder="Identity Mapping UI Draft"
					/>
				</label>
			{/if}
		</div>
		<div class="status-panel">
			<span class="status-dot"></span>
			<div>
				<strong
					>{loading
						? 'Loading control plane'
						: loadError
							? 'Preview fallback'
							: 'Control plane ready'}</strong
				>
				<small>
					{#if loading}
						Loading policy, catalog, profile, and federation trust summaries.
					{:else if loadError}
						{loadError}
					{:else}
						{summary.policies} policies, {summary.catalogs} catalogs, {summary.profiles} source/destination
						profiles.
					{/if}
				</small>
			</div>
		</div>
	</div>

	<IdentityMappingFlowEditor
		samples={editorSamples}
		{loading}
		{loadError}
		allowedViewModes={editorAllowedViewModes}
		initialViewMode={editorInitialViewMode}
		editable={editorEditable}
		showToolbarSourceProfile={showEditorToolbarSourceProfile}
		showToolbarModeToggle={showEditorToolbarModeToggle}
		showMetrics={showEditorMetrics}
		showLaneProfileSelectors={!showProfileModeControl}
		{laneSelectorMode}
		{policySelectorOptions}
		{showGraphPolicyDraftLabel}
		{showCompileDraftButton}
		{primaryActionLabel}
		{primaryActionBusyLabel}
		selectedViewMode={showProfileModeControl ? editMode : null}
		selectedProfileId={showProfileModeControl ? selectedEditorProfileId : null}
		draftResetKey={editorDraftResetKey}
		onDraftDirtyChange={(dirty) => (editorHasUnsavedDraftChanges = dirty)}
		onCompileDraft={compileEditorDraft}
	/>
</div>

<style>
	.identity-mapping-page {
		display: grid;
		gap: 18px;
	}

	.page-heading {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 18px;
	}

	h1 {
		margin: 0;
		color: var(--text-primary);
		font-size: 28px;
		line-height: 1.2;
	}

	.summary {
		max-width: 760px;
		margin: 8px 0 0;
		color: var(--text-secondary);
		font-size: 14px;
		line-height: 1.5;
	}

	.profile-mode-control {
		display: flex;
		align-items: center;
		gap: 12px;
		margin-top: 14px;
	}

	.profile-mode-radio {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		padding: 4px;
		border: 1px solid var(--border-color);
		border-radius: 8px;
		background: var(--bg-card);
	}

	.profile-mode-radio label {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		min-height: 30px;
		padding: 0 10px;
		border-radius: 6px;
		color: var(--text-secondary);
		font-size: 13px;
		font-weight: 700;
		cursor: pointer;
	}

	.profile-mode-radio label:has(input:checked) {
		color: var(--text-primary);
		background: var(--bg-hover);
	}

	.profile-mode-radio input {
		margin: 0;
	}

	.profile-mode-control select {
		min-width: 260px;
		height: 40px;
		border: 1px solid var(--border-color);
		border-radius: 8px;
		color: var(--text-primary);
		background: var(--bg-card);
		font-size: 13px;
		font-weight: 700;
	}

	.policy-save-control {
		display: grid;
		gap: 6px;
		max-width: 360px;
		margin-top: 14px;
		color: var(--text-secondary);
		font-size: 11px;
		font-weight: 800;
		letter-spacing: 0.08em;
		text-transform: uppercase;
	}

	.policy-save-control input {
		height: 40px;
		padding: 0 12px;
		border: 1px solid var(--border-color);
		border-radius: 8px;
		color: var(--text-primary);
		background: var(--bg-card);
		font-size: 14px;
		font-weight: 700;
		letter-spacing: 0;
		text-transform: none;
	}

	.status-panel {
		min-width: 260px;
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 12px;
		border: 1px solid var(--border-color);
		border-radius: 8px;
		background: var(--bg-card);
	}

	.status-panel strong,
	.status-panel small {
		display: block;
	}

	.status-panel strong {
		color: var(--text-primary);
		font-size: 13px;
	}

	.status-panel small {
		margin-top: 2px;
		color: var(--text-muted);
		font-size: 12px;
		line-height: 1.35;
	}

	.status-dot {
		width: 10px;
		height: 10px;
		border-radius: 999px;
		background: #f59e0b;
		box-shadow: 0 0 0 4px rgba(245, 158, 11, 0.16);
	}

	@media (max-width: 980px) {
		.page-heading {
			display: grid;
		}

		.status-panel {
			min-width: 0;
		}
	}
</style>
