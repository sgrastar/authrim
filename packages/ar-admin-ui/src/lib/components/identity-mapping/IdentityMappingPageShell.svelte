<script lang="ts">
	import { onMount } from 'svelte';
	import { adminIdentityMappingAPI } from '$lib/api/admin-identity-mapping';
	import IdentityMappingFlowEditor from '$lib/components/identity-mapping/IdentityMappingFlowEditor.svelte';
	import { buildIdentityMappingFlowSamples } from '$lib/components/identity-mapping/flow-data';
	import type {
		MappingDraftPayload,
		MappingSample
	} from '$lib/components/identity-mapping/types';
	import type {
		IdentityMappingCatalogSummary,
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
		showProfileModeControl = false
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
	}>();

	let loading = $state(true);
	let loadError = $state<string | null>(null);
	let flowSamples = $state<MappingSample[]>([]);
	let policySummaries = $state<IdentityMappingPolicySummary[]>([]);
	let catalogSummaries = $state<IdentityMappingCatalogSummary[]>([]);
	let editMode = $state<Extract<ViewMode, 'inbound' | 'outbound'>>('inbound');
	let selectedInboundProfileId = $state<string | null>(null);
	let selectedOutboundProfileId = $state<string | null>(null);
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
		let policy = policySummaries[0];
		if (!policy) {
			const createdPolicy = await adminIdentityMappingAPI.createPolicy({
				policyKey: 'identity-mapping-ui-draft',
				displayName: 'Identity Mapping UI Draft',
				description: 'Draft policy set created from the Admin UI Flow Editor.'
			});
			policy = createdPolicy.result;
			policySummaries = [policy];
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
				...draft.metadata
			}
		});
		editorHasUnsavedDraftChanges = false;
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
		samples={flowSamples}
		{loading}
		{loadError}
		allowedViewModes={editorAllowedViewModes}
		initialViewMode={editorInitialViewMode}
		editable={editorEditable}
		showToolbarSourceProfile={showEditorToolbarSourceProfile}
		showToolbarModeToggle={showEditorToolbarModeToggle}
		showMetrics={showEditorMetrics}
		showLaneProfileSelectors={!showProfileModeControl}
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
