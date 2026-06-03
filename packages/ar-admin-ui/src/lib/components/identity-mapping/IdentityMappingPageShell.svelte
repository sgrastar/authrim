<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { onMount } from 'svelte';
	import { adminIdentityMappingAPI } from '$lib/api/admin-identity-mapping';
	import IdentityMappingFlowEditor from '$lib/components/identity-mapping/IdentityMappingFlowEditor.svelte';
	import { buildIdentityMappingFlowSamples } from '$lib/components/identity-mapping/flow-data';
	import type {
		MappingAdapter,
		MappingDraftPayload,
		MappingSample
	} from '$lib/components/identity-mapping/types';
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
		backHref = null,
		backLabel = null,
		editorAllowedViewModes = ['overview', 'inbound', 'outbound'],
		editorInitialViewMode = 'overview',
		editorEditable = true,
		showEditorToolbarSourceProfile = true,
		showEditorToolbarModeToggle = true,
		showEditorMetrics = true,
		showEditorInspector = true,
		showControlPlaneStatus = true,
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
		backHref?: string | null;
		backLabel?: string | null;
		editorAllowedViewModes?: ViewMode[];
		editorInitialViewMode?: ViewMode;
		editorEditable?: boolean;
		showEditorToolbarSourceProfile?: boolean;
		showEditorToolbarModeToggle?: boolean;
		showEditorMetrics?: boolean;
		showEditorInspector?: boolean;
		showControlPlaneStatus?: boolean;
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
	let policyDisplayNameTouched = $state(false);
	let editorDraftResetKey = $state(0);
	let editorHasUnsavedDraftChanges = $state(false);
	let appliedRoutePolicyOptionId = $state<string | null>(null);
	let selectedPolicyControlId = $state<string | null>(null);
	let selectedPolicyVersionId = $state<string | null>(null);
	let selectedPolicyDirection = $state<Extract<ViewMode, 'inbound' | 'outbound'> | null>(null);
	let policyOperationBusy = $state(false);
	let policyOperationStatus = $state<string | null>(null);
	let confirmRollbackPolicyId = $state<string | null>(null);
	let confirmDeletePolicyId = $state<string | null>(null);
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
	const routePolicyDirection = $derived(routeDirectionFromSearchParams());
	const routePolicyOptionId = $derived(routePolicyOptionIdFromSearchParams());
	const selectedPolicyVersions = $derived(
		selectedPolicyControlId ? (policyVersionsByPolicyId[selectedPolicyControlId] ?? []) : []
	);
	const selectedPolicySummary = $derived(
		policySummaries.find((policy) => policy.id === selectedPolicyControlId) ?? null
	);
	const selectedPolicyVersion = $derived(
		selectedPolicyVersions.find((version) => version.id === selectedPolicyVersionId) ?? null
	);
	const selectedPolicyOptionId = $derived(selectedPolicyOptionIdFromState());
	const selectedPolicySnapshotId = $derived(selectedPolicyVersion?.latestSnapshot?.id ?? null);
	const selectedPolicyActive = $derived(
		selectedPolicyVersion?.lifecycleState === 'active' ||
			selectedPolicyVersion?.latestSnapshot?.lifecycleState === 'active'
	);
	const policyNameConflict = $derived(findPolicyNameConflict(policyDisplayName));
	const policySelectorOptions = $derived(
		policySummaries.flatMap((policy) =>
			(policyVersionsByPolicyId[policy.id] ?? [])
				.filter(
					(version) =>
						isActivePolicyVersion(policy, version) || isRoutePolicyVersion(policy, version)
				)
				.flatMap((version) => {
					const directions = policyVersionDirections(version);
					const base = {
						id: `${policy.id}:${version.id}`,
						policyId: policy.id,
						versionId: version.id,
						rules: version.rules ?? [],
						sourceProfileIds: version.sourceProfileIds ?? [],
						destinationProfileIds: version.destinationProfileIds ?? []
					};
					const options = [];
					if (directions.inbound) {
						const adapter = policyOptionAdapter(version, 'inbound');
						options.push({
							...base,
							id: `${base.id}:inbound`,
							title: `[${adapter}] ${policy.displayName || policy.policyKey}`,
							adapter,
							direction: 'inbound' as const
						});
					}
					if (directions.outbound) {
						const adapter = policyOptionAdapter(version, 'outbound');
						options.push({
							...base,
							id: `${base.id}:outbound`,
							title: `[${adapter}] ${policy.displayName || policy.policyKey}`,
							adapter,
							direction: 'outbound' as const
						});
					}
					return options;
				})
		)
	);
	const editorLaneSelectorMode = $derived(selectedPolicyOptionId ? 'policy' : laneSelectorMode);
	const editorSamples = $derived(
		editorLaneSelectorMode === 'policy' && policySelectorOptions.length === 0 ? [] : flowSamples
	);

	$effect(() => {
		if (!showProfileModeControl || !routePolicyDirection) return;
		const directionChanged = editMode !== routePolicyDirection;
		editMode = routePolicyDirection;
		selectedPolicyDirection = routePolicyDirection;
		if (!routePolicyOptionId) {
			if (directionChanged) resetEditorDraft();
			return;
		}
		if (appliedRoutePolicyOptionId === routePolicyOptionId) return;
		selectedPolicyControlId = $page.url.searchParams.get('policyId');
		selectedPolicyVersionId = $page.url.searchParams.get('versionId');
		appliedRoutePolicyOptionId = routePolicyOptionId;
		resetEditorDraft();
	});

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

	$effect(() => {
		if (!showPolicySaveControl || policyDisplayNameTouched) return;
		const selectedProfileTitle =
			editMode === 'inbound'
				? sourceProfileOptions.find((option) => option.id === selectedInboundProfileId)?.title
				: destinationProfileOptions.find((option) => option.id === selectedOutboundProfileId)
						?.title;
		if (!selectedProfileTitle) return;
		policyDisplayName = `${selectedProfileTitle} Policy`;
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

	function policyOptionAdapter(
		version: IdentityMappingPolicyVersionSummary,
		direction: 'inbound' | 'outbound'
	): MappingAdapter {
		if (direction === 'inbound') {
			const sample = flowSamples.find((candidate) =>
				(version.sourceProfileIds ?? []).includes(candidate.id)
			);
			return sample?.inboundAdapter ?? 'CSV';
		}
		const destinationProfileIds = version.destinationProfileIds ?? [];
		for (const sample of flowSamples) {
			const node = sample.nodes.find(
				(candidate) =>
					candidate.role === 'destination' &&
					candidate.profileId &&
					destinationProfileIds.includes(candidate.profileId)
			);
			if (node?.adapter) return node.adapter;
		}
		return 'OIDC';
	}

	function policyVersionDirections(version: IdentityMappingPolicyVersionSummary) {
		if (version.directions) return version.directions;
		const inbound = (version.sourceProfileIds?.length ?? 0) > 0;
		const outbound = (version.destinationProfileIds?.length ?? 0) > 0;
		return {
			inbound: inbound || (!outbound && routePolicyDirection === 'inbound'),
			outbound: outbound || (!inbound && routePolicyDirection === 'outbound')
		};
	}

	function routeDirectionFromSearchParams(): Extract<ViewMode, 'inbound' | 'outbound'> | null {
		const direction = $page.url.searchParams.get('direction');
		return direction === 'inbound' || direction === 'outbound' ? direction : null;
	}

	function routePolicyOptionIdFromSearchParams(): string | null {
		const policyId = $page.url.searchParams.get('policyId');
		const versionId = $page.url.searchParams.get('versionId');
		const direction = routeDirectionFromSearchParams();
		if (!policyId || !versionId || !direction) return null;
		return `${policyId}:${versionId}:${direction}`;
	}

	function selectedPolicyOptionIdFromState(): string | null {
		if (!selectedPolicyControlId || !selectedPolicyVersionId || !selectedPolicyDirection) {
			return null;
		}
		return `${selectedPolicyControlId}:${selectedPolicyVersionId}:${selectedPolicyDirection}`;
	}

	function selectPolicyVersion(event: Event) {
		const versionId = (event.currentTarget as HTMLSelectElement).value || null;
		if (versionId === selectedPolicyVersionId) return;
		if (!confirmDiscardEditorDraft()) return;
		selectedPolicyVersionId = versionId;
		policyOperationStatus = null;
		confirmRollbackPolicyId = null;
		confirmDeletePolicyId = null;
		resetEditorDraft();
	}

	async function refreshSelectedPolicyVersions() {
		if (!selectedPolicyControlId) return;
		const versions = await adminIdentityMappingAPI.listPolicyVersions(selectedPolicyControlId);
		policyVersionsByPolicyId = {
			...policyVersionsByPolicyId,
			[selectedPolicyControlId]: versions.policyVersions
		};
	}

	async function publishSelectedPolicyVersion() {
		await runPolicyVersionOperation('Published policy version', async (policyId, version) => {
			await adminIdentityMappingAPI.publishPolicyVersion(policyId, version.id);
			if (!version.latestSnapshot?.id) {
				const catalogVersionId = catalogSummaries.find((catalog) => catalog.versionId)?.versionId;
				if (!catalogVersionId) {
					throw new Error('No active catalog version is available to prepare this policy');
				}
				await adminIdentityMappingAPI.compilePolicyVersion(policyId, version.id, {
					catalogVersionId,
					metadata: { source: 'admin-ui-edit', triggeredBy: 'publish' }
				});
			}
		});
	}

	async function toggleSelectedPolicyActivation(event: Event) {
		const checked = (event.currentTarget as HTMLInputElement).checked;
		if (checked) {
			await activateSelectedPolicyVersion();
		} else {
			await deactivateSelectedPolicyVersion();
		}
	}

	async function activateSelectedPolicyVersion() {
		await runPolicyVersionOperation('Activated policy version', async (policyId, version) => {
			const snapshotId = version.latestSnapshot?.id;
			if (!snapshotId) {
				throw new Error('Publish this version before activation');
			}
			await adminIdentityMappingAPI.activatePolicyVersion(policyId, version.id, {
				snapshotId,
				activationScope: { kind: 'tenant' }
			});
		});
	}

	async function deactivateSelectedPolicyVersion() {
		await runPolicyVersionOperation('Deactivated policy version', async (policyId, version) => {
			await adminIdentityMappingAPI.deactivatePolicyVersion(policyId, version.id);
		});
	}

	async function rollbackSelectedPolicy() {
		if (!selectedPolicyControlId) {
			policyOperationStatus = 'Select a policy version first';
			return;
		}
		confirmDeletePolicyId = null;
		if (confirmRollbackPolicyId !== selectedPolicyControlId) {
			confirmRollbackPolicyId = selectedPolicyControlId;
			policyOperationStatus = 'Confirm rollback to continue';
			return;
		}
		policyOperationBusy = true;
		policyOperationStatus = null;
		try {
			await adminIdentityMappingAPI.rollbackPolicy(selectedPolicyControlId);
			confirmRollbackPolicyId = null;
			policyOperationStatus = 'Rollback requested';
			await refreshSelectedPolicyVersions();
		} catch (error) {
			policyOperationStatus = error instanceof Error ? error.message : 'Rollback failed';
		} finally {
			policyOperationBusy = false;
		}
	}

	async function deleteSelectedPolicy() {
		if (!selectedPolicyControlId) {
			policyOperationStatus = 'Select a policy version first';
			return;
		}
		confirmRollbackPolicyId = null;
		if (confirmDeletePolicyId !== selectedPolicyControlId) {
			confirmDeletePolicyId = selectedPolicyControlId;
			policyOperationStatus = 'Confirm delete to remove this policy';
			return;
		}
		policyOperationBusy = true;
		policyOperationStatus = null;
		try {
			await adminIdentityMappingAPI.deletePolicy(selectedPolicyControlId);
			policySummaries = policySummaries.filter((policy) => policy.id !== selectedPolicyControlId);
			const { [selectedPolicyControlId]: _removed, ...remainingVersions } = policyVersionsByPolicyId;
			policyVersionsByPolicyId = remainingVersions;
			selectedPolicyControlId = null;
			selectedPolicyVersionId = null;
			selectedPolicyDirection = null;
			confirmDeletePolicyId = null;
			editorHasUnsavedDraftChanges = false;
			await goto('/admin/identity-mapping/mapping-policies');
		} catch (error) {
			policyOperationStatus = error instanceof Error ? error.message : 'Policy delete failed';
		} finally {
			policyOperationBusy = false;
		}
	}

	async function runPolicyVersionOperation(
		successMessage: string,
		operation: (
			policyId: string,
			version: IdentityMappingPolicyVersionSummary
		) => Promise<void> | void
	) {
		const policyId = selectedPolicyControlId;
		const version = selectedPolicyVersion;
		policyOperationBusy = true;
		policyOperationStatus = null;
		try {
			if (!policyId || !version) {
				throw new Error('Select a policy version first');
			}
			await operation(policyId, version);
			confirmRollbackPolicyId = null;
			confirmDeletePolicyId = null;
			policyOperationStatus = successMessage;
			await refreshSelectedPolicyVersions();
		} catch (error) {
			policyOperationStatus = error instanceof Error ? error.message : 'Policy operation failed';
		} finally {
			policyOperationBusy = false;
		}
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

	function confirmDiscardEditorDraft(): boolean {
		if (!editorHasUnsavedDraftChanges) return true;
		return window.confirm('You have unsaved mapping draft changes. Discard them and switch view?');
	}

	function resetEditorDraft() {
		editorDraftResetKey += 1;
		editorHasUnsavedDraftChanges = false;
	}

	function updatePolicyDisplayName(event: Event) {
		policyDisplayNameTouched = true;
		policyDisplayName = (event.currentTarget as HTMLInputElement).value;
	}

	async function compileEditorDraft(draft: MappingDraftPayload) {
		const displayName = policyDisplayName.trim() || 'Identity Mapping UI Draft';
		const conflict = findPolicyNameConflict(displayName);
		if (conflict) {
			throw new Error(
				`A mapping policy named "${conflict.displayName}" already exists. Choose a different policy name.`
			);
		}
		const catalogVersionId = catalogSummaries.find((catalog) => catalog.versionId)?.versionId;
		if (!catalogVersionId) {
			throw new Error('No canonical catalog version is available for compile.');
		}
		const policyKey = policyKeyFromDisplayName(displayName);
		let policy = selectedPolicyControlId
			? (policySummaries.find((candidate) => candidate.id === selectedPolicyControlId) ?? null)
			: null;
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

	function findPolicyNameConflict(displayName: string): IdentityMappingPolicySummary | null {
		const policyKey = policyKeyFromDisplayName(displayName.trim() || 'Identity Mapping UI Draft');
		return (
			policySummaries.find(
				(policy) => policy.policyKey === policyKey && policy.id !== selectedPolicyControlId
			) ?? null
		);
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

	function isRoutePolicyVersion(
		policy: IdentityMappingPolicySummary,
		version: IdentityMappingPolicyVersionSummary
	): boolean {
		if (!routePolicyDirection) return false;
		return routePolicyOptionId === `${policy.id}:${version.id}:${routePolicyDirection}`;
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
			{#if backHref && backLabel}
				<a class="back-link" href={backHref}>{backLabel}</a>
			{/if}
			<h1>{pageTitle}</h1>
			<p class="summary">
				{pageDescription}
			</p>
			{#if showProfileModeControl}
				<div class="profile-mode-control" aria-label="Mapping edit profile selector">
					<div class="profile-mode-label">
						<span>Direction</span>
						<strong>{editMode === 'inbound' ? 'Inbound mapping' : 'Outbound release'}</strong>
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
						value={policyDisplayName}
						placeholder="Source profile Policy"
						oninput={updatePolicyDisplayName}
					/>
					{#if policyNameConflict}
						<small class="policy-name-warning">
							{policyNameConflict.displayName} already exists. Choose a different policy name.
						</small>
					{/if}
				</label>
			{/if}
		</div>
		{#if showProfileModeControl}
			<div class="policy-version-panel">
				<div class="policy-version-heading">
					<span>Policy version</span>
					<strong>{selectedPolicySummary?.displayName ?? 'No policy selected'}</strong>
				</div>
				<select
					aria-label="Policy version"
					value={selectedPolicyVersionId ?? ''}
					onchange={selectPolicyVersion}
					disabled={!selectedPolicyControlId ||
						selectedPolicyVersions.length === 0 ||
						policyOperationBusy}
				>
					<option value="" disabled>No version selected</option>
					{#each selectedPolicyVersions as version (version.id)}
						<option value={version.id}>{version.versionLabel} / {version.lifecycleState}</option>
					{/each}
				</select>
				<div class="policy-version-actions">
					<label class="activation-switch">
						<input
							type="checkbox"
							checked={selectedPolicyActive}
							onchange={toggleSelectedPolicyActivation}
							disabled={!selectedPolicyVersion || policyOperationBusy}
						/>
						<span aria-hidden="true"></span>
						<strong>Activate</strong>
					</label>
					<button
						type="button"
						onclick={publishSelectedPolicyVersion}
						disabled={!selectedPolicyVersion || policyOperationBusy}
					>
						Publish
					</button>
					<button
						type="button"
						onclick={rollbackSelectedPolicy}
						disabled={!selectedPolicyControlId || policyOperationBusy}
					>
						{confirmRollbackPolicyId === selectedPolicyControlId
							? 'Confirm Rollback'
							: 'Request Rollback'}
					</button>
					<button
						type="button"
						class="danger-action"
						onclick={deleteSelectedPolicy}
						disabled={!selectedPolicyControlId || policyOperationBusy}
					>
						{confirmDeletePolicyId === selectedPolicyControlId ? 'Confirm Delete' : 'Delete'}
					</button>
				</div>
				<div class="policy-version-meta">
					<span>{selectedPolicyDirection ?? 'direction not selected'}</span>
					<span>{selectedPolicySnapshotId ? 'snapshot ready' : 'no snapshot'}</span>
				</div>
				{#if policyOperationStatus}
					<p class="policy-operation-status">{policyOperationStatus}</p>
				{/if}
			</div>
		{/if}
		{#if showControlPlaneStatus && !showProfileModeControl}
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
							{summary.policies} policies, {summary.catalogs} catalogs, {summary.profiles}
							source/destination profiles.
						{/if}
					</small>
				</div>
			</div>
		{/if}
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
		showInspector={showEditorInspector}
		showLaneProfileSelectors={!showProfileModeControl}
		laneSelectorMode={editorLaneSelectorMode}
		{policySelectorOptions}
		{showGraphPolicyDraftLabel}
		{showCompileDraftButton}
		{primaryActionLabel}
		{primaryActionBusyLabel}
		initialPolicyOptionId={selectedPolicyOptionId}
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

	.back-link {
		display: inline-flex;
		margin-bottom: 12px;
		color: var(--color-primary);
		font-size: 13px;
		font-weight: 700;
		text-decoration: none;
	}

	.back-link:hover,
	.back-link:focus-visible {
		text-decoration: underline;
		outline: none;
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

	.profile-mode-label {
		display: grid;
		gap: 2px;
		min-height: 40px;
		padding: 6px 12px;
		border: 1px solid var(--border-color);
		border-radius: 8px;
		background: var(--bg-card);
	}

	.profile-mode-label span {
		color: var(--text-secondary);
		font-size: 10px;
		font-weight: 800;
		letter-spacing: 0.08em;
		text-transform: uppercase;
	}

	.profile-mode-label strong {
		color: var(--text-primary);
		font-size: 13px;
		line-height: 1.2;
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

	.policy-name-warning {
		color: #b45309;
		font-size: 12px;
		font-weight: 700;
		letter-spacing: 0;
		line-height: 1.4;
		text-transform: none;
	}

	.policy-version-panel {
		min-width: 360px;
		display: grid;
		gap: 10px;
		padding: 12px;
		border: 1px solid var(--border-color);
		border-radius: 8px;
		background: var(--bg-card);
	}

	.policy-version-heading {
		display: grid;
		gap: 3px;
	}

	.policy-version-heading span,
	.policy-version-meta,
	.policy-operation-status {
		color: var(--text-muted);
		font-size: 11px;
		font-weight: 800;
		letter-spacing: 0.08em;
		text-transform: uppercase;
	}

	.policy-version-heading strong {
		overflow: hidden;
		color: var(--text-primary);
		font-size: 13px;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.policy-version-panel select {
		height: 36px;
		border: 1px solid var(--border-color);
		border-radius: 8px;
		color: var(--text-primary);
		background: var(--bg-input);
		font-size: 13px;
		font-weight: 700;
	}

	.policy-version-actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
	}

	.policy-version-actions button {
		min-height: 32px;
		padding: 0 10px;
		border: 1px solid var(--border-color);
		border-radius: 8px;
		color: var(--text-primary);
		background: var(--bg-card);
		font-size: 12px;
		font-weight: 800;
	}

	.policy-version-actions button:disabled,
	.policy-version-panel select:disabled {
		cursor: not-allowed;
		opacity: 0.55;
	}

	.policy-version-actions .danger-action {
		border-color: color-mix(in srgb, #ef4444 62%, var(--border-color));
		color: #ef4444;
	}

	.policy-version-actions .danger-action:not(:disabled):hover {
		background: color-mix(in srgb, #ef4444 12%, var(--bg-hover));
	}

	.activation-switch {
		display: inline-flex;
		align-items: center;
		gap: 7px;
		color: var(--text-primary);
		font-size: 12px;
		font-weight: 800;
		cursor: pointer;
	}

	.activation-switch input {
		position: absolute;
		opacity: 0;
		pointer-events: none;
	}

	.activation-switch span {
		position: relative;
		width: 34px;
		height: 20px;
		border: 1px solid var(--border-color);
		border-radius: 999px;
		background: var(--bg-muted);
		transition:
			background 120ms ease,
			border-color 120ms ease;
	}

	.activation-switch span::after {
		position: absolute;
		top: 3px;
		left: 3px;
		width: 14px;
		height: 14px;
		border-radius: 999px;
		background: var(--text-muted);
		content: '';
		transition:
			background 120ms ease,
			transform 120ms ease;
	}

	.activation-switch input:checked + span {
		border-color: rgba(16, 185, 129, 0.65);
		background: rgba(16, 185, 129, 0.2);
	}

	.activation-switch input:checked + span::after {
		background: #10b981;
		transform: translateX(14px);
	}

	.activation-switch input:focus-visible + span {
		outline: 2px solid var(--color-primary);
		outline-offset: 2px;
	}

	.policy-version-meta {
		display: flex;
		flex-wrap: wrap;
		gap: 10px;
	}

	.policy-operation-status {
		margin: 0;
		color: var(--text-secondary);
		text-transform: none;
		letter-spacing: 0;
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

		.policy-version-panel {
			min-width: 0;
		}
	}
</style>
