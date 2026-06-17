<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { onMount } from 'svelte';
	import { adminCustomClaimsAPI } from '$lib/api/admin-custom-claims';
	import { adminIdentityMappingAPI } from '$lib/api/admin-identity-mapping';
	import { AdminPageHeader, AdminPageShell } from '$lib/components/admin';
	import IdentityMappingFlowEditor from '$lib/components/identity-mapping/IdentityMappingFlowEditor.svelte';
	import { buildIdentityMappingFlowSamples } from '$lib/components/identity-mapping/flow-data';
	import { LL } from '$i18n/i18n-svelte';
	import type {
		MappingAdapter,
		MappingDraftPayload,
		MappingSample
	} from '$lib/components/identity-mapping/types';
	import type {
		IdentityMappingCatalogSummary,
		IdentityMappingDestinationProfileSummary,
		IdentityMappingFieldMappingVersionSummary,
		IdentityMappingFieldMappingSetSummary,
		IdentityMappingSourceProfileSummary
	} from '$lib/api/admin-identity-mapping';

	type ViewMode = 'overview' | 'source' | 'destination';
	type MappingSide = Extract<ViewMode, 'source' | 'destination'>;
	type ProfileSelectorOption = {
		id: string;
		title: string;
		adapter?: MappingAdapter;
	};

	const {
		pageTitle = 'Field Mapping',
		pageDescription = 'Preview source profiles, canonical identity targets, and destination projections from one control-plane view.',
		headTitle = pageTitle,
		backHref = null,
		backLabel = null,
		editorAllowedViewModes = ['overview', 'source', 'destination'],
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
	let fieldMappingSetSummaries = $state<IdentityMappingFieldMappingSetSummary[]>([]);
	let fieldMappingVersionsByFieldMappingSetId = $state<
		Record<string, IdentityMappingFieldMappingVersionSummary[]>
	>({});
	let catalogSummaries = $state<IdentityMappingCatalogSummary[]>([]);
	let editSide = $state<MappingSide>('source');
	let selectedSourceProfileId = $state<string | null>(null);
	let selectedDestinationProfileId = $state<string | null>(null);
	let policyDisplayName = $state<string>($LL.admin_identity_mapping_editor_policy_default_name());
	let policyDisplayNameTouched = $state(false);
	let editorDraftResetKey = $state(0);
	let editorHasUnsavedDraftChanges = $state(false);
	let appliedRoutePolicyOptionId = $state<string | null>(null);
	let selectedFieldMappingSetId = $state<string | null>(null);
	let selectedFieldMappingVersionId = $state<string | null>(null);
	let selectedPolicySide = $state<MappingSide | null>(null);
	let policyOperationBusy = $state(false);
	let policyOperationStatus = $state<string | null>(null);
	let confirmRollbackFieldMappingSetId = $state<string | null>(null);
	let confirmDeleteFieldMappingSetId = $state<string | null>(null);
	let sourceProfileCount = $state(0);
	let sourceProfileSchemaCount = $state(0);
	let destinationProfileCount = $state(0);
	let destinationProfileSchemaCount = $state(0);
	let registeredSourceProfileOptions = $state<ProfileSelectorOption[]>([]);
	let registeredDestinationProfileOptions = $state<ProfileSelectorOption[]>([]);
	let summary = $state({
		policies: 0,
		catalogs: 0,
		profiles: 0,
		federationTrustSources: 0
	});
	const sourceProfileOptions = $derived(
		mergeProfileOptions([
			...flowSamples
				.filter((sample) => sample.nodes.some((node) => node.role === 'source'))
				.map((sample) => ({
					id: sample.id,
					title: sample.title,
					adapter: sample.sourceAdapter
				})),
			...registeredSourceProfileOptions
		])
	);
	const destinationProfileOptions = $derived(
		mergeProfileOptions([
			...destinationProfileOptionsFromSamples(flowSamples),
			...registeredDestinationProfileOptions
		])
	);
	const selectedEditorProfileId = $derived(
		editSide === 'source' ? selectedSourceProfileId : selectedDestinationProfileId
	);
	const routePolicySide = $derived(routeSideFromSearchParams());
	const routePolicyOptionId = $derived(routePolicyOptionIdFromSearchParams());
	const selectedFieldMappingVersions = $derived(
		selectedFieldMappingSetId
			? (fieldMappingVersionsByFieldMappingSetId[selectedFieldMappingSetId] ?? [])
			: []
	);
	const selectedFieldMappingSetSummary = $derived(
		fieldMappingSetSummaries.find((policy) => policy.id === selectedFieldMappingSetId) ?? null
	);
	const selectedFieldMappingVersion = $derived(
		selectedFieldMappingVersions.find((version) => version.id === selectedFieldMappingVersionId) ??
			null
	);
	const selectedFieldMappingOptionId = $derived(selectedFieldMappingOptionIdFromState());
	const selectedFieldMappingSnapshotId = $derived(
		selectedFieldMappingVersion?.latestSnapshot?.id ?? null
	);
	const selectedFieldMappingActive = $derived(
		selectedFieldMappingVersion?.lifecycleState === 'active' ||
			selectedFieldMappingVersion?.latestSnapshot?.lifecycleState === 'active'
	);
	const policyNameConflict = $derived(findPolicyNameConflict(policyDisplayName));
	const policySelectorOptions = $derived(
		fieldMappingSetSummaries.flatMap((policy) =>
			(fieldMappingVersionsByFieldMappingSetId[policy.id] ?? [])
				.filter(
					(version) =>
						isActiveFieldMappingVersion(policy, version) ||
						isRouteFieldMappingVersion(policy, version)
				)
				.flatMap((version) => {
					const sides = policyVersionSides(version);
					const base = {
						id: `${policy.id}:${version.id}`,
						policyId: policy.id,
						versionId: version.id,
						rules: version.rules ?? [],
						sourceProfileIds: version.sourceProfileIds ?? [],
						destinationProfileIds: version.destinationProfileIds ?? []
					};
					const options = [];
					if (sides.source) {
						const adapter = policyOptionAdapter(version, 'source');
						options.push({
							...base,
							id: `${base.id}:source`,
							title: `[${adapter}] ${policy.displayName || policy.fieldMappingKey}`,
							adapter,
							direction: 'source' as const
						});
					}
					if (sides.destination) {
						const adapter = policyOptionAdapter(version, 'destination');
						options.push({
							...base,
							id: `${base.id}:destination`,
							title: `[${adapter}] ${policy.displayName || policy.fieldMappingKey}`,
							adapter,
							direction: 'destination' as const
						});
					}
					return options;
				})
		)
	);
	const editorLaneSelectorMode = $derived(
		selectedFieldMappingOptionId ? 'policy' : laneSelectorMode
	);
	const editorSamples = $derived(
		editorLaneSelectorMode === 'policy' && policySelectorOptions.length === 0 ? [] : flowSamples
	);
	const showProfileSchemaSetupHint = $derived(
		showProfileModeControl &&
			!loading &&
			!loadError &&
			editorSamples.length === 0 &&
			((editSide === 'source' && sourceProfileCount > 0 && sourceProfileSchemaCount === 0) ||
				(editSide === 'destination' &&
					destinationProfileCount > 0 &&
					destinationProfileSchemaCount === 0))
	);

	$effect(() => {
		if (!showProfileModeControl || !routePolicySide) return;
		const directionChanged = editSide !== routePolicySide;
		editSide = routePolicySide;
		selectedPolicySide = routePolicySide;
		if (!routePolicyOptionId) {
			if (directionChanged) resetEditorDraft();
			return;
		}
		if (appliedRoutePolicyOptionId === routePolicyOptionId) return;
		selectedFieldMappingSetId = $page.url.searchParams.get('policyId');
		selectedFieldMappingVersionId = $page.url.searchParams.get('versionId');
		appliedRoutePolicyOptionId = routePolicyOptionId;
		resetEditorDraft();
	});

	$effect(() => {
		if (!selectedSourceProfileId && sourceProfileOptions.length > 0) {
			selectedSourceProfileId = sourceProfileOptions[0].id;
		}
		if (!selectedDestinationProfileId && destinationProfileOptions.length > 0) {
			selectedDestinationProfileId =
				destinationProfileOptions.find((option) => option.adapter === 'OIDC')?.id ??
				destinationProfileOptions[0].id;
		}
	});

	$effect(() => {
		if (!showPolicySaveControl || policyDisplayNameTouched) return;
		const selectedProfileTitle =
			editSide === 'source'
				? sourceProfileOptions.find((option) => option.id === selectedSourceProfileId)?.title
				: destinationProfileOptions.find((option) => option.id === selectedDestinationProfileId)
						?.title;
		if (!selectedProfileTitle) return;
		policyDisplayName = `${String(selectedProfileTitle)} ${$LL.admin_identity_mapping_editor_policy_default_suffix()}`;
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
							title:
								node.profileTitle ??
								`${node.adapter ?? $LL.admin_identity_mapping_destination()} ${$LL.admin_identity_mapping_editor_destination_profile_fallback()}`,
							adapter: node.adapter
						}
					];
				})
		);
	}

	function mergeProfileOptions(options: ProfileSelectorOption[]): ProfileSelectorOption[] {
		const seen = new Set<string>();
		return options.filter((option) => {
			if (seen.has(option.id)) return false;
			seen.add(option.id);
			return true;
		});
	}

	function sourceProfileOption(
		profile: IdentityMappingSourceProfileSummary
	): ProfileSelectorOption {
		return {
			id: `source-profile-${profile.id}`,
			title: profile.displayName,
			adapter: profileAdapter(profile.sourceType)
		};
	}

	function destinationProfileOption(
		profile: IdentityMappingDestinationProfileSummary
	): ProfileSelectorOption {
		return {
			id: `destination-profile-${profile.id}`,
			title: profile.displayName,
			adapter: profileAdapter(profile.destinationType)
		};
	}

	function profileAdapter(value: string): MappingAdapter {
		const normalized = value.toLowerCase();
		if (normalized === 'saml') return 'SAML';
		if (normalized === 'oidc') return 'OIDC';
		if (normalized === 'scim') return 'SCIM';
		return 'CSV';
	}

	function policyOptionAdapter(
		version: IdentityMappingFieldMappingVersionSummary,
		side: MappingSide
	): MappingAdapter {
		if (side === 'source') {
			const sample = flowSamples.find((candidate) =>
				(version.sourceProfileIds ?? []).includes(candidate.id)
			);
			return sample?.sourceAdapter ?? 'CSV';
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

	function policyVersionSides(version: IdentityMappingFieldMappingVersionSummary) {
		if (version.directions) {
			return {
				source: version.directions.source,
				destination: version.directions.destination
			};
		}
		const hasSourceProfiles = (version.sourceProfileIds?.length ?? 0) > 0;
		const hasDestinationProfiles = (version.destinationProfileIds?.length ?? 0) > 0;
		return {
			source: hasSourceProfiles || (!hasDestinationProfiles && routePolicySide === 'source'),
			destination:
				hasDestinationProfiles || (!hasSourceProfiles && routePolicySide === 'destination')
		};
	}

	function routeSideFromSearchParams(): MappingSide | null {
		const direction = $page.url.searchParams.get('direction');
		if (direction === 'source') return 'source';
		if (direction === 'destination') return 'destination';
		return null;
	}

	function routePolicyOptionIdFromSearchParams(): string | null {
		const policyId = $page.url.searchParams.get('policyId');
		const versionId = $page.url.searchParams.get('versionId');
		const direction = routeSideFromSearchParams();
		if (!policyId || !versionId || !direction) return null;
		return `${policyId}:${versionId}:${direction}`;
	}

	function selectedFieldMappingOptionIdFromState(): string | null {
		if (!selectedFieldMappingSetId || !selectedFieldMappingVersionId || !selectedPolicySide) {
			return null;
		}
		return `${selectedFieldMappingSetId}:${selectedFieldMappingVersionId}:${selectedPolicySide}`;
	}

	function selectFieldMappingVersion(event: Event) {
		const versionId = (event.currentTarget as HTMLSelectElement).value || null;
		if (versionId === selectedFieldMappingVersionId) return;
		if (!confirmDiscardEditorDraft()) return;
		selectedFieldMappingVersionId = versionId;
		policyOperationStatus = null;
		confirmRollbackFieldMappingSetId = null;
		confirmDeleteFieldMappingSetId = null;
		resetEditorDraft();
	}

	async function refreshSelectedFieldMappingVersions() {
		if (!selectedFieldMappingSetId) return;
		const versions =
			await adminIdentityMappingAPI.listFieldMappingVersions(selectedFieldMappingSetId);
		fieldMappingVersionsByFieldMappingSetId = {
			...fieldMappingVersionsByFieldMappingSetId,
			[selectedFieldMappingSetId]: versions.fieldMappingVersions
		};
	}

	async function publishSelectedFieldMappingVersion() {
		await runFieldMappingVersionOperation(
			$LL.admin_identity_mapping_editor_policy_published(),
			async (policyId, version) => {
				await adminIdentityMappingAPI.publishFieldMappingVersion(policyId, version.id);
				if (!version.latestSnapshot?.id) {
					const catalogVersionId = catalogSummaries.find((catalog) => catalog.versionId)?.versionId;
					if (!catalogVersionId) {
						throw new Error($LL.admin_identity_mapping_editor_no_active_catalog());
					}
					await adminIdentityMappingAPI.compileFieldMappingVersion(policyId, version.id, {
						catalogVersionId,
						metadata: { source: 'admin-ui-edit', triggeredBy: 'publish' }
					});
				}
			}
		);
	}

	async function toggleSelectedPolicyActivation(event: Event) {
		const checked = (event.currentTarget as HTMLInputElement).checked;
		if (checked) {
			await activateSelectedFieldMappingVersion();
		} else {
			await deactivateSelectedFieldMappingVersion();
		}
	}

	async function activateSelectedFieldMappingVersion() {
		await runFieldMappingVersionOperation(
			$LL.admin_identity_mapping_editor_policy_activated(),
			async (policyId, version) => {
				const snapshotId = version.latestSnapshot?.id;
				if (!snapshotId) {
					throw new Error($LL.admin_identity_mapping_editor_publish_before_activation());
				}
				await adminIdentityMappingAPI.activateFieldMappingVersion(policyId, version.id, {
					snapshotId,
					activationScope: { kind: 'tenant' }
				});
			}
		);
	}

	async function deactivateSelectedFieldMappingVersion() {
		await runFieldMappingVersionOperation(
			$LL.admin_identity_mapping_editor_policy_deactivated(),
			async (policyId, version) => {
				await adminIdentityMappingAPI.deactivateFieldMappingVersion(policyId, version.id);
			}
		);
	}

	async function rollbackSelectedPolicy() {
		if (!selectedFieldMappingSetId) {
			policyOperationStatus = $LL.admin_identity_mapping_editor_select_policy_version_first();
			return;
		}
		confirmDeleteFieldMappingSetId = null;
		if (confirmRollbackFieldMappingSetId !== selectedFieldMappingSetId) {
			confirmRollbackFieldMappingSetId = selectedFieldMappingSetId;
			policyOperationStatus = $LL.admin_identity_mapping_editor_confirm_rollback_status();
			return;
		}
		policyOperationBusy = true;
		policyOperationStatus = null;
		try {
			await adminIdentityMappingAPI.rollbackFieldMappingSet(selectedFieldMappingSetId);
			confirmRollbackFieldMappingSetId = null;
			policyOperationStatus = $LL.admin_identity_mapping_editor_rollback_requested();
			await refreshSelectedFieldMappingVersions();
		} catch (error) {
			policyOperationStatus =
				error instanceof Error
					? error.message
					: $LL.admin_identity_mapping_editor_rollback_failed();
		} finally {
			policyOperationBusy = false;
		}
	}

	async function deleteSelectedPolicy() {
		if (!selectedFieldMappingSetId) {
			policyOperationStatus = $LL.admin_identity_mapping_editor_select_policy_version_first();
			return;
		}
		confirmRollbackFieldMappingSetId = null;
		if (confirmDeleteFieldMappingSetId !== selectedFieldMappingSetId) {
			confirmDeleteFieldMappingSetId = selectedFieldMappingSetId;
			policyOperationStatus = $LL.admin_identity_mapping_editor_confirm_delete_status();
			return;
		}
		policyOperationBusy = true;
		policyOperationStatus = null;
		try {
			await adminIdentityMappingAPI.deleteFieldMappingSet(selectedFieldMappingSetId);
			fieldMappingSetSummaries = fieldMappingSetSummaries.filter(
				(policy) => policy.id !== selectedFieldMappingSetId
			);
			const { [selectedFieldMappingSetId]: _removed, ...remainingVersions } =
				fieldMappingVersionsByFieldMappingSetId;
			fieldMappingVersionsByFieldMappingSetId = remainingVersions;
			selectedFieldMappingSetId = null;
			selectedFieldMappingVersionId = null;
			selectedPolicySide = null;
			confirmDeleteFieldMappingSetId = null;
			editorHasUnsavedDraftChanges = false;
			await goto('/admin/field-mapping/field-mapping-sets');
		} catch (error) {
			policyOperationStatus =
				error instanceof Error
					? error.message
					: $LL.admin_identity_mapping_editor_policy_delete_failed();
		} finally {
			policyOperationBusy = false;
		}
	}

	async function runFieldMappingVersionOperation(
		successMessage: string,
		operation: (
			policyId: string,
			version: IdentityMappingFieldMappingVersionSummary
		) => Promise<void> | void
	) {
		const policyId = selectedFieldMappingSetId;
		const version = selectedFieldMappingVersion;
		policyOperationBusy = true;
		policyOperationStatus = null;
		try {
			if (!policyId || !version) {
				throw new Error($LL.admin_identity_mapping_editor_select_policy_version_first());
			}
			await operation(policyId, version);
			confirmRollbackFieldMappingSetId = null;
			confirmDeleteFieldMappingSetId = null;
			policyOperationStatus = successMessage;
			await refreshSelectedFieldMappingVersions();
		} catch (error) {
			policyOperationStatus =
				error instanceof Error
					? error.message
					: $LL.admin_identity_mapping_editor_policy_operation_failed();
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
		if (editSide === 'source') {
			selectedSourceProfileId = value;
		} else {
			selectedDestinationProfileId = value;
		}
		resetEditorDraft();
	}

	function confirmDiscardEditorDraft(): boolean {
		if (!editorHasUnsavedDraftChanges) return true;
		return window.confirm($LL.admin_identity_mapping_editor_unsaved_confirm());
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
		const displayName =
			policyDisplayName.trim() || $LL.admin_identity_mapping_editor_policy_default_name();
		const conflict = findPolicyNameConflict(displayName);
		if (conflict) {
			throw new Error(
				$LL.admin_identity_mapping_editor_policy_conflict({
					name: conflict.displayName
				})
			);
		}
		const catalogVersionId = catalogSummaries.find((catalog) => catalog.versionId)?.versionId;
		if (!catalogVersionId) {
			throw new Error($LL.admin_identity_mapping_editor_no_canonical_catalog());
		}
		const fieldMappingKey = fieldMappingKeyFromDisplayName(displayName);
		let policy = selectedFieldMappingSetId
			? (fieldMappingSetSummaries.find((candidate) => candidate.id === selectedFieldMappingSetId) ??
				null)
			: null;
		if (!policy) {
			const createdPolicy = await adminIdentityMappingAPI.createFieldMappingSet({
				fieldMappingKey,
				displayName,
				description: $LL.admin_identity_mapping_editor_created_description()
			});
			policy = createdPolicy.result;
			fieldMappingSetSummaries = [policy, ...fieldMappingSetSummaries];
		}
		const version = await adminIdentityMappingAPI.createFieldMappingVersion(policy.id, {
			versionLabel: draft.versionLabel,
			compatibilityRange: draft.compatibilityRange,
			rules: draft.rules
		});
		await adminIdentityMappingAPI.compileFieldMappingVersion(policy.id, version.result.id, {
			catalogVersionId,
			metadata: {
				source: 'admin_ui_flow_editor',
				policyDisplayName: displayName,
				...draft.metadata
			}
		});
		editorHasUnsavedDraftChanges = false;
	}

	function fieldMappingKeyFromDisplayName(value: string): string {
		const key = value
			.trim()
			.toLowerCase()
			.normalize('NFKC')
			.replace(/[^\p{L}\p{N}]+/gu, '-')
			.replace(/^-|-$/g, '')
			.slice(0, 80);
		return key || 'identity-mapping-ui-draft';
	}

	function findPolicyNameConflict(
		displayName: string
	): IdentityMappingFieldMappingSetSummary | null {
		const fieldMappingKey = fieldMappingKeyFromDisplayName(
			displayName.trim() || $LL.admin_identity_mapping_editor_policy_default_name()
		);
		return (
			fieldMappingSetSummaries.find(
				(policy) =>
					policy.fieldMappingKey === fieldMappingKey && policy.id !== selectedFieldMappingSetId
			) ?? null
		);
	}

	function isActiveFieldMappingVersion(
		policy: IdentityMappingFieldMappingSetSummary,
		version: IdentityMappingFieldMappingVersionSummary
	): boolean {
		if (policy.lifecycleState !== 'active') return false;
		return (
			version.lifecycleState === 'active' || version.latestSnapshot?.lifecycleState === 'active'
		);
	}

	function isRouteFieldMappingVersion(
		policy: IdentityMappingFieldMappingSetSummary,
		version: IdentityMappingFieldMappingVersionSummary
	): boolean {
		if (!routePolicySide) return false;
		return routePolicyOptionId === `${policy.id}:${version.id}:${routePolicySide}`;
	}

	onMount(async () => {
		try {
			const [
				policies,
				catalogs,
				identitySchemas,
				sourceProfiles,
				destinationProfiles,
				protocolSchemas,
				externalSchemas,
				federationTrustSources,
				schemaReadiness
			] = await Promise.all([
				adminIdentityMappingAPI.listFieldMappingSets(),
				adminIdentityMappingAPI.listCatalogs(),
				adminCustomClaimsAPI.listSchemas({ limit: 200, is_active: '1' }),
				adminIdentityMappingAPI.listSourceProfiles(),
				adminIdentityMappingAPI.listDestinationProfiles(),
				adminIdentityMappingAPI.listProtocolSchemas(),
				adminIdentityMappingAPI.listExternalSchemas(),
				adminIdentityMappingAPI.listFederationTrustSources(),
				adminIdentityMappingAPI.getSchemaReadiness()
			]);

			summary = {
				policies: policies.fieldMappingSets.length,
				catalogs: catalogs.catalogs.length,
				profiles:
					sourceProfiles.sourceProfiles.length +
					destinationProfiles.destinationProfiles.length +
					protocolSchemas.protocolSchemas.length +
					externalSchemas.externalSchemas.length,
				federationTrustSources: federationTrustSources.federationTrustSources.length
			};
			fieldMappingSetSummaries = policies.fieldMappingSets;
			fieldMappingVersionsByFieldMappingSetId = Object.fromEntries(
				await Promise.all(
					policies.fieldMappingSets.map(async (policy) => {
						const versions = await adminIdentityMappingAPI.listFieldMappingVersions(policy.id);
						return [policy.id, versions.fieldMappingVersions] as const;
					})
				)
			);
			catalogSummaries = catalogs.catalogs;
			sourceProfileCount = sourceProfiles.sourceProfiles.length;
			sourceProfileSchemaCount =
				sourceProfiles.sourceProfiles.filter(sourceProfileHasSchema).length;
			destinationProfileCount = destinationProfiles.destinationProfiles.length;
			destinationProfileSchemaCount = destinationProfiles.destinationProfiles.filter(
				destinationProfileHasSchema
			).length;
			registeredSourceProfileOptions = sourceProfiles.sourceProfiles.map(sourceProfileOption);
			registeredDestinationProfileOptions =
				destinationProfiles.destinationProfiles.map(destinationProfileOption);
			flowSamples = buildIdentityMappingFlowSamples({
				policies: policies.fieldMappingSets,
				catalogs: catalogs.catalogs,
				identitySchemas: identitySchemas.schemas,
				sourceProfiles: sourceProfiles.sourceProfiles,
				destinationProfiles: destinationProfiles.destinationProfiles,
				protocolSchemas: protocolSchemas.protocolSchemas,
				externalSchemas: externalSchemas.externalSchemas,
				schemaReadinessRows: schemaReadiness.rows
			});
		} catch (error) {
			loadError =
				error instanceof Error ? error.message : $LL.admin_identity_mapping_editor_load_failed();
		} finally {
			loading = false;
		}
	});

	function sourceProfileHasSchema(profile: IdentityMappingSourceProfileSummary): boolean {
		return Boolean(profile.version?.schema);
	}

	function destinationProfileHasSchema(profile: IdentityMappingDestinationProfileSummary): boolean {
		return Boolean(profile.version?.schema);
	}
</script>

<svelte:head>
	<title>{headTitle} - Authrim Admin</title>
</svelte:head>

<AdminPageShell>
	<div class="identity-mapping-page">
		{#if backHref && backLabel}
			<a class="back-link" href={backHref}>{backLabel}</a>
		{/if}

		<AdminPageHeader
			eyebrow={$LL.admin_identity_mapping_title()}
			title={pageTitle}
			description={pageDescription}
		>
			{#snippet actions()}
				{#if showProfileModeControl}
					<div class="policy-version-panel">
						<div class="policy-version-heading">
							<span>{$LL.admin_identity_mapping_editor_policy_version()}</span>
							<strong>
								{selectedFieldMappingSetSummary?.displayName ??
									$LL.admin_identity_mapping_editor_no_policy_selected()}
							</strong>
						</div>
						<select
							aria-label={$LL.admin_identity_mapping_editor_policy_version()}
							value={selectedFieldMappingVersionId ?? ''}
							onchange={selectFieldMappingVersion}
							disabled={!selectedFieldMappingSetId ||
								selectedFieldMappingVersions.length === 0 ||
								policyOperationBusy}
						>
							<option value="" disabled
								>{$LL.admin_identity_mapping_editor_no_version_selected()}</option
							>
							{#each selectedFieldMappingVersions as version (version.id)}
								<option value={version.id}>{version.versionLabel} / {version.lifecycleState}</option
								>
							{/each}
						</select>
						<div class="policy-version-actions">
							<label class="activation-switch">
								<input
									type="checkbox"
									checked={selectedFieldMappingActive}
									onchange={toggleSelectedPolicyActivation}
									disabled={!selectedFieldMappingVersion || policyOperationBusy}
								/>
								<span aria-hidden="true"></span>
								<strong>{$LL.admin_identity_mapping_editor_activate()}</strong>
							</label>
							<button
								type="button"
								onclick={publishSelectedFieldMappingVersion}
								disabled={!selectedFieldMappingVersion || policyOperationBusy}
							>
								{$LL.admin_identity_mapping_editor_publish()}
							</button>
							<button
								type="button"
								onclick={rollbackSelectedPolicy}
								disabled={!selectedFieldMappingSetId || policyOperationBusy}
							>
								{confirmRollbackFieldMappingSetId === selectedFieldMappingSetId
									? $LL.admin_identity_mapping_editor_confirm_rollback()
									: $LL.admin_identity_mapping_editor_request_rollback()}
							</button>
							<button
								type="button"
								class="danger-action"
								onclick={deleteSelectedPolicy}
								disabled={!selectedFieldMappingSetId || policyOperationBusy}
							>
								{confirmDeleteFieldMappingSetId === selectedFieldMappingSetId
									? $LL.admin_identity_mapping_editor_confirm_delete()
									: $LL.admin_identity_mapping_editor_delete()}
							</button>
						</div>
						<div class="policy-version-meta">
							<span>
								{selectedPolicySide === 'source'
									? $LL.admin_identity_mapping_source()
									: selectedPolicySide === 'destination'
										? $LL.admin_identity_mapping_destination()
										: $LL.admin_identity_mapping_editor_side_not_selected()}
							</span>
							<span>
								{selectedFieldMappingSnapshotId
									? $LL.admin_identity_mapping_editor_snapshot_ready()
									: $LL.admin_identity_mapping_editor_no_snapshot()}
							</span>
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
									? $LL.admin_identity_mapping_editor_loading_control_plane()
									: loadError
										? $LL.admin_identity_mapping_editor_preview_fallback()
										: $LL.admin_identity_mapping_editor_control_plane_ready()}</strong
							>
							<small>
								{#if loading}
									{$LL.admin_identity_mapping_editor_loading_summaries()}
								{:else if loadError}
									{loadError}
								{:else}
									{$LL.admin_identity_mapping_editor_summary_counts({
										policies: summary.policies,
										catalogs: summary.catalogs,
										profiles: summary.profiles
									})}
								{/if}
							</small>
						</div>
					</div>
				{/if}
			{/snippet}
		</AdminPageHeader>

		{#if showProfileModeControl || showPolicySaveControl}
			<div class="identity-mapping-controls">
				{#if showProfileModeControl}
					<div
						class="profile-mode-control"
						aria-label={$LL.admin_identity_mapping_editor_profile_selector_aria()}
					>
						<div class="profile-mode-label">
							<span>{$LL.admin_identity_mapping_editor_profile_side()}</span>
							<strong>
								{editSide === 'source'
									? $LL.admin_identity_mapping_editor_source_mapping()
									: $LL.admin_identity_mapping_editor_destination_release()}
							</strong>
						</div>
						<select
							aria-label={editSide === 'source'
								? $LL.admin_identity_mapping_source_profile()
								: $LL.admin_identity_mapping_destination_profile()}
							value={selectedEditorProfileId ?? ''}
							onchange={selectEditProfile}
						>
							<option value="" disabled>
								{editSide === 'source'
									? $LL.admin_identity_mapping_editor_select_source_profile()
									: $LL.admin_identity_mapping_editor_select_destination_profile()}
							</option>
							{#if editSide === 'source'}
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
						<span>{$LL.admin_identity_mapping_editor_policy_name()}</span>
						<input
							type="text"
							value={policyDisplayName}
							placeholder={$LL.admin_identity_mapping_editor_policy_placeholder()}
							oninput={updatePolicyDisplayName}
						/>
						{#if policyNameConflict}
							<small class="policy-name-warning">
								{$LL.admin_identity_mapping_editor_policy_exists({
									name: policyNameConflict.displayName
								})}
							</small>
						{/if}
					</label>
				{/if}
			</div>
		{/if}

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
			initialPolicyOptionId={selectedFieldMappingOptionId}
			selectedViewMode={showProfileModeControl ? editSide : null}
			selectedProfileId={showProfileModeControl ? selectedEditorProfileId : null}
			emptyStateTitle={showProfileSchemaSetupHint
				? $LL.admin_identity_mapping_flow_schema_not_configured()
				: null}
			emptyStateDescription={showProfileSchemaSetupHint
				? $LL.admin_identity_mapping_flow_schema_not_configured_desc()
				: null}
			emptyStateActionHref={showProfileSchemaSetupHint ? '/admin/field-mapping/profiles' : null}
			emptyStateActionLabel={showProfileSchemaSetupHint
				? $LL.admin_identity_mapping_flow_schema_not_configured_action()
				: null}
			draftResetKey={editorDraftResetKey}
			onDraftDirtyChange={(dirty) => (editorHasUnsavedDraftChanges = dirty)}
			onCompileDraft={compileEditorDraft}
		/>
	</div>
</AdminPageShell>

<style>
	.identity-mapping-page {
		display: grid;
		gap: var(--identity-mapping-page-gap, 18px);
	}

	.back-link {
		display: inline-flex;
		width: fit-content;
		color: var(--color-accent);
		font-size: 13px;
		font-weight: 700;
		text-decoration: none;
	}

	.back-link:hover,
	.back-link:focus-visible {
		text-decoration: underline;
		outline: none;
	}

	.identity-mapping-controls {
		display: flex;
		align-items: flex-end;
		gap: 14px;
		flex-wrap: wrap;
	}

	.profile-mode-control {
		display: flex;
		align-items: center;
		gap: 12px;
		flex-wrap: wrap;
	}

	.profile-mode-label {
		display: grid;
		gap: 2px;
		min-height: 40px;
		padding: 6px 12px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-control);
		background: var(--color-surface);
	}

	.profile-mode-label span {
		color: var(--color-text-muted);
		font-family: var(--font-meta, var(--font-body));
		font-size: var(--field-label-size, 0.68rem);
		font-weight: 800;
		letter-spacing: var(--field-label-letter-spacing, 0.16em);
		text-transform: uppercase;
	}

	.profile-mode-label strong {
		color: var(--color-text);
		font-size: 13px;
		line-height: 1.2;
	}

	.profile-mode-control select {
		min-width: 260px;
		min-height: var(--control-height, 40px);
		padding: var(--control-padding, 0 12px);
		border: var(--toolbar-control-border, 1px solid var(--color-border));
		border-radius: var(--toolbar-control-radius, var(--radius-control));
		color: var(--color-text);
		background: var(--toolbar-control-bg, var(--color-surface));
		font-size: 13px;
		font-weight: 700;
	}

	.policy-save-control {
		display: grid;
		gap: 6px;
		flex: 1 1 320px;
		max-width: 420px;
		color: var(--color-text-muted);
		font-family: var(--font-meta, var(--font-body));
		font-size: var(--field-label-size, 0.68rem);
		font-weight: 800;
		letter-spacing: var(--field-label-letter-spacing, 0.16em);
		text-transform: uppercase;
	}

	.policy-save-control input {
		min-height: var(--control-height, 40px);
		padding: var(--control-padding, 0 12px);
		border: var(--toolbar-control-border, 1px solid var(--color-border));
		border-radius: var(--toolbar-control-radius, var(--radius-control));
		color: var(--color-text);
		background: var(--toolbar-control-bg, var(--color-surface));
		font-size: 14px;
		font-weight: 700;
		letter-spacing: 0;
		text-transform: none;
	}

	.policy-name-warning {
		color: var(--color-warning);
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
		border: 1px solid var(--color-border);
		border-radius: var(--radius-control);
		background: var(--color-surface);
	}

	.policy-version-heading {
		display: grid;
		gap: 3px;
	}

	.policy-version-heading span,
	.policy-version-meta,
	.policy-operation-status {
		color: var(--color-text-muted);
		font-family: var(--font-meta, var(--font-body));
		font-size: var(--field-label-size, 0.68rem);
		font-weight: 800;
		letter-spacing: var(--field-label-letter-spacing, 0.16em);
		text-transform: uppercase;
	}

	.policy-version-heading strong {
		overflow: hidden;
		color: var(--color-text);
		font-size: 13px;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.policy-version-panel select {
		min-height: var(--control-height, 36px);
		padding: var(--control-padding, 0 12px);
		border: var(--toolbar-control-border, 1px solid var(--color-border));
		border-radius: var(--toolbar-control-radius, var(--radius-control));
		color: var(--color-text);
		background: var(--toolbar-control-bg, var(--color-surface));
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
		min-height: var(--control-height, 32px);
		padding: 0 10px;
		border: var(--toolbar-control-border, 1px solid var(--color-border));
		border-radius: var(--toolbar-control-radius, var(--radius-control));
		color: var(--color-text);
		background: var(--toolbar-control-bg, var(--color-surface));
		font-size: 12px;
		font-weight: 800;
	}

	.policy-version-actions button:disabled,
	.policy-version-panel select:disabled {
		cursor: not-allowed;
		opacity: 0.55;
	}

	.policy-version-actions .danger-action {
		border-color: color-mix(in srgb, var(--color-danger) 62%, var(--color-border));
		color: var(--color-danger);
	}

	.policy-version-actions .danger-action:not(:disabled):hover {
		background: color-mix(in srgb, var(--color-danger) 12%, var(--color-surface-muted));
	}

	.activation-switch {
		display: inline-flex;
		align-items: center;
		gap: 7px;
		color: var(--color-text);
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
		border: 1px solid var(--color-border);
		border-radius: 999px;
		background: var(--color-surface-muted);
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
		background: var(--color-text-muted);
		content: '';
		transition:
			background 120ms ease,
			transform 120ms ease;
	}

	.activation-switch input:checked + span {
		border-color: color-mix(in srgb, var(--color-success) 65%, var(--color-border));
		background: color-mix(in srgb, var(--color-success) 20%, transparent);
	}

	.activation-switch input:checked + span::after {
		background: var(--color-success);
		transform: translateX(14px);
	}

	.activation-switch input:focus-visible + span {
		outline: 2px solid var(--color-accent);
		outline-offset: 2px;
	}

	.policy-version-meta {
		display: flex;
		flex-wrap: wrap;
		gap: 10px;
	}

	.policy-operation-status {
		margin: 0;
		color: var(--color-text-muted);
		text-transform: none;
		letter-spacing: 0;
	}

	.status-panel {
		min-width: 260px;
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 12px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-control);
		background: var(--color-surface);
	}

	.status-panel strong,
	.status-panel small {
		display: block;
	}

	.status-panel strong {
		color: var(--color-text);
		font-size: 13px;
	}

	.status-panel small {
		margin-top: 2px;
		color: var(--color-text-muted);
		font-size: 12px;
		line-height: 1.35;
	}

	.status-dot {
		width: 10px;
		height: 10px;
		border-radius: 999px;
		background: var(--color-warning);
		box-shadow: 0 0 0 4px color-mix(in srgb, var(--color-warning) 16%, transparent);
	}

	@media (max-width: 980px) {
		.status-panel {
			min-width: 0;
		}

		.policy-version-panel {
			min-width: 0;
		}

		.profile-mode-control,
		.profile-mode-control select,
		.policy-save-control {
			width: 100%;
			max-width: none;
		}
	}
</style>
