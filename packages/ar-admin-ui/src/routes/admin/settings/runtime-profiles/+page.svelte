<script lang="ts">
	import { onMount } from 'svelte';
	import {
		adminRuntimeProfilesAPI,
		type RuntimeProfileActivationStatus,
		type RuntimeProfileReferenceCatalog,
		type RuntimeProfileRecord,
		type RuntimeProfileReferenceManagementPolicy,
		type RuntimeProfileReferenceStatusEntry,
		type StorageProfileCapabilityStatus,
		type StorageProfileListPolicy,
		type StorageProfileTenantOverridePolicy,
		type StorageSliceBoundaryPolicy
	} from '$lib/api/admin-runtime-profiles';
	import {
		clearAuditArchiveTemplate,
		createEmptyAuditProfileDraftJson,
		ensureAuditArchiveTemplate,
		formatAuditTargetSummary,
		getAuditTargetDetails,
		insertAuditSinkTemplate,
		normalizeAuditProfileJson,
		parseAuditProfileEditorDraft,
		removeAuditSink,
		replaceAuditSinkTemplate,
		type AuditProfileDraft,
		type EditableAuditPrimaryType,
		type AuditTargetDraft,
		type EditableAuditSinkType,
		updateAuditArchiveField,
		updateAuditFailureMode,
		updateAuditPrimaryField,
		updateAuditPrimaryType,
		updateAuditRetentionBoolean,
		updateAuditRetentionNumber,
		updateAuditSinkField
	} from '$lib/admin/runtime-profile-audit-editor';

	let loading = $state(true);
	let saving = $state(false);
	let error = $state('');
	let success = $state('');

	let auditProfiles = $state<RuntimeProfileRecord[]>([]);
	let storageProfiles = $state<RuntimeProfileRecord[]>([]);
	let residencyProfiles = $state<RuntimeProfileRecord[]>([]);
	let storagePolicy = $state<StorageProfileListPolicy | null>(null);
	let referenceCatalog = $state<RuntimeProfileReferenceCatalog | null>(null);
	let auditReferenceStatus = $state<Record<string, RuntimeProfileReferenceStatusEntry[]>>({});
	let auditActivationStatus = $state<Record<string, RuntimeProfileActivationStatus>>({});
	let storageActivationStatus = $state<Record<string, RuntimeProfileActivationStatus>>({});
	let residencyActivationStatus = $state<Record<string, RuntimeProfileActivationStatus>>({});
	let defaultsActivationStatus = $state<Record<string, RuntimeProfileActivationStatus>>({});
	let referenceManagement = $state<RuntimeProfileReferenceManagementPolicy | null>(null);
	let defaultAuditProfileId = $state('');
	let defaultStorageProfileId = $state('');
	let defaultResidencyProfileId = $state('');
	let selectedProfileId = $state('');
	let profileIdInput = $state('');
	let profileJson = $state('');
	let profileJsonError = $state('');
	let parsedProfileDraft = $state<AuditProfileDraft | null>(null);

	const boundaryClassLabels: Record<StorageSliceBoundaryPolicy['boundaryClass'], string> = {
		auth_core: 'Auth Core Plane',
		pii: 'PII Plane',
		custom_extension: 'Custom / Extension Plane',
		authorization: 'Authorization Plane'
	};

	function getStorageTenantPolicy(profileId: string): StorageProfileTenantOverridePolicy | null {
		return storagePolicy?.tenantOverrideEligibility?.[profileId] ?? null;
	}

	function getStorageCapabilityStatus(profileId: string): StorageProfileCapabilityStatus | null {
		return storagePolicy?.capabilityStatus?.[profileId] ?? null;
	}

	function getStorageProfileSlices(profile: RuntimeProfileRecord): string[] {
		const slices = profile.slices;
		if (!slices || typeof slices !== 'object') {
			return [];
		}
		return Object.keys(slices as Record<string, unknown>);
	}

	function formatStorageProfileSummary(profile: RuntimeProfileRecord): string {
		const slices = getStorageProfileSlices(profile);
		if (slices.length === 0) {
			return 'No storage slices configured';
		}
		return slices.join(', ');
	}

	function describeTenantOverrideCompatibility(
		policy: StorageProfileTenantOverridePolicy | null
	): string {
		if (!policy) {
			return 'Compatibility unknown';
		}
		if (policy.tenantOverrideAllowed) {
			return 'Tenant override compatible';
		}
		return 'Auth core plane differs from the environment default';
	}

	function formatCapabilityReadiness(status: StorageProfileCapabilityStatus | null): string {
		if (!status) {
			return 'Capability status unknown';
		}
		if (status.mvpReady) {
			return 'MVP ready';
		}
		return `${status.unsupportedCount} unsupported / ${status.partialCount} partial`;
	}

	function formatPolicyBadge(value: boolean): string {
		return value ? 'Allowed' : 'Blocked';
	}

	function formatTenantDatabaseStatsAvailability(): string {
		const status = storagePolicy?.tenantDatabaseStatsStatus;
		if (!status) {
			return 'Unknown';
		}
		if (status.available) {
			return status.attentionRequired ? 'Attention required' : 'Healthy';
		}
		return status.unavailableReason === 'db_admin_not_configured'
			? 'Control DB unavailable'
			: 'Stats unavailable';
	}

	function getTenantDatabaseStatsSummaryItems(): Array<{ label: string; value: number }> {
		const summary = storagePolicy?.tenantDatabaseStatsStatus?.summary;
		if (!summary) {
			return [];
		}
		return [
			{ label: 'Active core DBs', value: summary.active_tenant_core_databases },
			{ label: 'Stats rows', value: summary.stats_rows },
			{ label: 'Missing stats', value: summary.missing_stats_count },
			{ label: 'Stale stats', value: summary.stale_stats_count },
			{ label: 'Warnings', value: summary.warning_count },
			{ label: 'Strong warnings', value: summary.strong_warning_count },
			{ label: 'Stale file size', value: summary.stale_file_size_count },
			{ label: 'Unavailable file size', value: summary.unavailable_file_size_count }
		];
	}

	function formatRuntimeRegistrySecurityStatus(): string {
		const status = storagePolicy?.runtimeRegistrySecurityNotifications;
		if (!status) {
			return 'Unknown';
		}
		if (status.available) {
			return status.attentionRequired ? 'Attention required' : 'Healthy';
		}
		return status.unavailableReason === 'db_admin_not_configured'
			? 'Control DB unavailable'
			: 'Alerts unavailable';
	}

	function getRuntimeRegistrySecurityItems(): Array<{ label: string; value: number | string }> {
		const summary = storagePolicy?.runtimeRegistrySecurityNotifications?.summary;
		if (!summary) {
			return [];
		}
		return [
			{ label: 'Pending', value: summary.pending_count },
			{ label: 'Failed', value: summary.failed_count },
			{ label: 'Dead letter', value: summary.dead_letter_count },
			{ label: 'Critical', value: summary.critical_count },
			{ label: 'High', value: summary.high_count },
			{ label: 'Latest', value: summary.latest_created_at ?? 'None' }
		];
	}

	function getActivationStatus(
		map: Record<string, RuntimeProfileActivationStatus>,
		profileId: string
	): RuntimeProfileActivationStatus | null {
		return map[profileId] ?? null;
	}

	function getReferenceStatus(
		map: Record<string, RuntimeProfileReferenceStatusEntry[]>,
		profileId: string
	): RuntimeProfileReferenceStatusEntry[] {
		return map[profileId] ?? [];
	}

	function getSelectedAuditReferenceStatus(): RuntimeProfileReferenceStatusEntry[] {
		return selectedProfileId ? getReferenceStatus(auditReferenceStatus, selectedProfileId) : [];
	}

	function getSelectedAuditActivationStatus(): RuntimeProfileActivationStatus | null {
		return selectedProfileId ? getActivationStatus(auditActivationStatus, selectedProfileId) : null;
	}

	function activationLabel(status: RuntimeProfileActivationStatus | null): string {
		if (!status) {
			return 'Unknown';
		}
		if (status.state === 'ready') {
			return 'Ready';
		}
		if (status.state === 'warning') {
			return 'Warning';
		}
		return 'Blocked';
	}

	function severityLabel(status: RuntimeProfileReferenceStatusEntry): string {
		return status.severity.toUpperCase();
	}

	function isActivationBlocked(status: RuntimeProfileActivationStatus | null): boolean {
		return status ? !status.activatable : false;
	}

	function getReferenceSummary(entry: RuntimeProfileReferenceStatusEntry): string {
		return entry.bindingRef ?? entry.connectionRef ?? entry.reference ?? 'inline';
	}

	function getReferenceCatalogValues(values: string[] | undefined): string[] {
		return values?.filter((value) => value.trim().length > 0) ?? [];
	}

	function getArchiveBucketOptions(): string[] {
		return getReferenceCatalogValues(referenceCatalog?.bindingRefs.r2);
	}

	function getConnectionRefOptions(): string[] {
		return getReferenceCatalogValues(referenceCatalog?.connectionRefs.all);
	}

	function getParsedProfileTarget(type: 'primary' | 'archive'): AuditTargetDraft | null {
		if (!parsedProfileDraft) {
			return null;
		}
		return type === 'primary' ? parsedProfileDraft.primary : parsedProfileDraft.archive;
	}

	function formatSinkLabel(target: AuditTargetDraft, index: number): string {
		return `Sink ${index + 1} · ${formatAuditTargetSummary(target)}`;
	}

	function insertSinkTemplate(type: EditableAuditSinkType) {
		profileJson = insertAuditSinkTemplate(profileJson, type);
	}

	function addArchiveTemplate() {
		profileJson = ensureAuditArchiveTemplate(profileJson);
	}

	function removeArchiveTemplate() {
		profileJson = clearAuditArchiveTemplate(profileJson);
	}

	function updateArchiveField(field: 'bucketRef' | 'prefix', value: string) {
		profileJson = updateAuditArchiveField(profileJson, field, value);
	}

	function updateFailureMode(field: 'archiveFailureMode' | 'sinkFailureMode', value: string) {
		profileJson = updateAuditFailureMode(profileJson, field, value);
	}

	function updatePrimaryType(type: EditableAuditPrimaryType) {
		profileJson = updateAuditPrimaryType(profileJson, type);
	}

	function updatePrimaryField(field: 'bindingRef' | 'connectionRef' | 'dataset', value: string) {
		profileJson = updateAuditPrimaryField(profileJson, field, value);
	}

	function updateRetentionNumber(
		field:
			| 'eventLogRetentionDays'
			| 'piiLogRetentionDays'
			| 'minimumRetentionDays'
			| 'primaryDays'
			| 'archiveDays',
		value: string
	) {
		profileJson = updateAuditRetentionNumber(profileJson, field, value);
	}

	function updateRetentionArchiveBeforeDelete(value: boolean) {
		profileJson = updateAuditRetentionBoolean(profileJson, 'archiveBeforeDelete', value);
	}

	function replaceSinkType(index: number, type: EditableAuditSinkType) {
		profileJson = replaceAuditSinkTemplate(profileJson, index, type);
	}

	function updateSinkField(index: number, field: string, value: string) {
		profileJson = updateAuditSinkField(profileJson, index, field, value);
	}

	function removeSink(index: number) {
		profileJson = removeAuditSink(profileJson, index);
	}

	function setSelectedProfile(profile: RuntimeProfileRecord | null) {
		if (!profile) {
			selectedProfileId = '';
			profileIdInput = '';
			profileJson = createEmptyAuditProfileDraftJson();
			return;
		}

		selectedProfileId = profile.id;
		profileIdInput = profile.id;
		profileJson = normalizeAuditProfileJson(profile);
	}

	async function load() {
		loading = true;
		error = '';

		try {
			const [auditProfilesResult, storageProfilesResult, residencyProfilesResult, defaultsResult] = await Promise.all([
				adminRuntimeProfilesAPI.list('audit', true),
				adminRuntimeProfilesAPI.list('storage', true),
				adminRuntimeProfilesAPI.list('residency', true),
				adminRuntimeProfilesAPI.getDefaults()
			]);

			auditProfiles = auditProfilesResult.profiles.audit ?? [];
			storageProfiles = storageProfilesResult.profiles.storage ?? [];
			residencyProfiles = residencyProfilesResult.profiles.residency ?? [];
			auditReferenceStatus = auditProfilesResult.reference_status?.audit ?? {};
			auditActivationStatus = auditProfilesResult.activation_status?.audit ?? {};
			storageActivationStatus = storageProfilesResult.activation_status?.storage ?? {};
			residencyActivationStatus = residencyProfilesResult.activation_status?.residency ?? {};
			defaultsActivationStatus = defaultsResult.activation_status ?? {};
			referenceManagement =
				auditProfilesResult.reference_management ??
				storageProfilesResult.reference_management ??
				residencyProfilesResult.reference_management ??
				defaultsResult.reference_management ??
				null;
			referenceCatalog =
				auditProfilesResult.reference_catalog ??
				storageProfilesResult.reference_catalog ??
				residencyProfilesResult.reference_catalog ??
				defaultsResult.reference_catalog ??
				null;
			storagePolicy = storageProfilesResult.storage_policy ?? null;
			defaultAuditProfileId = defaultsResult.defaults.auditProfileId;
			defaultStorageProfileId = defaultsResult.defaults.storageProfileId;
			defaultResidencyProfileId = defaultsResult.defaults.residencyProfileId;

			const selected =
				auditProfiles.find((profile) => profile.id === selectedProfileId) ||
				auditProfiles.find((profile) => profile.id === defaultAuditProfileId) ||
				auditProfiles[0] ||
				null;
			setSelectedProfile(selected);
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to load runtime profiles';
		} finally {
			loading = false;
		}
	}

	async function saveProfile() {
		error = '';
		success = '';
		saving = true;

		try {
			const id = profileIdInput.trim();
			if (!id) {
				throw new Error('Profile ID is required');
			}

			const parsed = JSON.parse(profileJson);
			const result = await adminRuntimeProfilesAPI.upsert('audit', id, parsed);
			success = result.created ? 'Audit profile created' : 'Audit profile updated';
			await load();
			setSelectedProfile(result.profile);
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to save profile';
		} finally {
			saving = false;
		}
	}

	async function deleteProfile() {
		error = '';
		success = '';
		if (!selectedProfileId) return;

		saving = true;
		try {
			await adminRuntimeProfilesAPI.remove('audit', selectedProfileId);
			success = 'Audit profile deleted';
			await load();
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to delete profile';
		} finally {
			saving = false;
		}
	}

	async function saveDefault() {
		error = '';
		success = '';
		saving = true;

		try {
			if (!defaultAuditProfileId) {
				throw new Error('Default audit profile is required');
			}
			if (!defaultStorageProfileId) {
				throw new Error('Default storage profile is required');
			}
			if (!defaultResidencyProfileId) {
				throw new Error('Default residency profile is required');
			}
			const selectedStorageActivation = getActivationStatus(
				storageActivationStatus,
				defaultStorageProfileId
			);
			if (selectedStorageActivation && !selectedStorageActivation.activatable) {
				throw new Error(
					selectedStorageActivation.blockingReasons[0] ??
						'Selected storage profile is not activatable'
				);
			}
			const selectedActivation = getActivationStatus(auditActivationStatus, defaultAuditProfileId);
			if (selectedActivation && !selectedActivation.activatable) {
				throw new Error(selectedActivation.blockingReasons[0] ?? 'Selected audit profile is not activatable');
			}
			const selectedResidencyActivation = getActivationStatus(
				residencyActivationStatus,
				defaultResidencyProfileId
			);
			if (selectedResidencyActivation && !selectedResidencyActivation.activatable) {
				throw new Error(
					selectedResidencyActivation.blockingReasons[0] ??
						'Selected residency profile is not activatable'
				);
			}
			await adminRuntimeProfilesAPI.updateDefaults({
				storageProfileId: defaultStorageProfileId,
				auditProfileId: defaultAuditProfileId,
				residencyProfileId: defaultResidencyProfileId
			});
			success = 'Default runtime profiles updated';
			await load();
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to update default profiles';
		} finally {
			saving = false;
		}
	}

	function selectProfileById(id: string) {
		const profile = auditProfiles.find((item) => item.id === id) ?? null;
		setSelectedProfile(profile);
	}

	onMount(load);

	$effect(() => {
		const parsed = parseAuditProfileEditorDraft(profileJson);
		parsedProfileDraft = parsed.profile;
		profileJsonError = parsed.error ?? '';
	});
</script>

<svelte:head>
	<title>Runtime Profiles - Admin Dashboard - Authrim</title>
</svelte:head>

<div class="runtime-profiles-page">
	<div class="page-header">
		<div>
			<a href="/admin/settings" class="back-link">&larr; Back to Settings</a>
			<h1 class="page-title">Runtime Profiles</h1>
			<p class="page-description">
				Review storage boundary policy and manage audit profiles. Tenant overrides are intentionally
				limited to PII and custom-extension slices.
			</p>
			{#if referenceManagement}
				<p class="helper-text">
					Reference management: <strong>{referenceManagement.mode}</strong>. Activation policy:
					<strong>{referenceManagement.activationPolicy}</strong>.
					{referenceManagement.note}
				</p>
			{/if}
		</div>
	</div>

	{#if error}
		<div class="alert alert-error">{error}</div>
	{/if}

	{#if success}
		<div class="alert alert-success">{success}</div>
	{/if}

	{#if loading}
		<div class="loading-state">
			<p>Loading runtime profiles...</p>
		</div>
	{:else}
		<div class="profiles-grid storage-grid">
			<section class="panel">
				<h2>Storage Boundary Policy</h2>
				<p class="helper-text">
					Auth core stays pinned to the environment default. Storage tenant overrides are intended
					for PII and custom-extension slices.
				</p>

				<div class="policy-summary">
					<div>
						<div class="summary-label">Default storage profile</div>
						<div class="summary-value">{defaultStorageProfileId}</div>
					</div>
					<div>
						<div class="summary-label">Auth core slices</div>
						<div class="chip-row">
							{#if storagePolicy?.authCoreSlices?.length}
									{#each storagePolicy.authCoreSlices as slice (slice)}
									<span class="badge">{slice}</span>
								{/each}
							{:else}
								<span class="badge">users_core</span>
							{/if}
						</div>
					</div>
				</div>

				<div class="status-panel">
					<div class="status-header">
						<h3>Tenant DB Stats</h3>
						<span
							class="badge"
							class:badge-primary={storagePolicy?.tenantDatabaseStatsStatus?.available &&
								!storagePolicy?.tenantDatabaseStatsStatus?.attentionRequired}
							class:badge-warning={storagePolicy?.tenantDatabaseStatsStatus?.available &&
								storagePolicy?.tenantDatabaseStatsStatus?.attentionRequired}
							class:badge-muted={!storagePolicy?.tenantDatabaseStatsStatus?.available}
						>
							{formatTenantDatabaseStatsAvailability()}
						</span>
					</div>
					{#if storagePolicy?.tenantDatabaseStatsStatus?.available}
						<div class="stats-grid">
							{#each getTenantDatabaseStatsSummaryItems() as item (item.label)}
								<div>
									<div class="summary-label">{item.label}</div>
									<div class="summary-value">{item.value}</div>
								</div>
							{/each}
						</div>
						<div class="helper-text">
							Stale threshold: {storagePolicy.tenantDatabaseStatsStatus.staleAfterHours} hours.
							Cutoff: {storagePolicy.tenantDatabaseStatsStatus.cutoffIso}.
						</div>
					{:else if storagePolicy?.tenantDatabaseStatsStatus?.unavailableReason}
						<p class="helper-text">
							{storagePolicy.tenantDatabaseStatsStatus.unavailableReason}
						</p>
					{:else}
						<p class="helper-text">Tenant DB stats have not been loaded.</p>
					{/if}
				</div>

				<div class="status-panel">
					<div class="status-header">
						<h3>Storage Registry Alerts</h3>
						<span
							class="badge"
							class:badge-primary={storagePolicy?.runtimeRegistrySecurityNotifications?.available &&
								!storagePolicy?.runtimeRegistrySecurityNotifications?.attentionRequired}
							class:badge-warning={storagePolicy?.runtimeRegistrySecurityNotifications?.available &&
								storagePolicy?.runtimeRegistrySecurityNotifications?.attentionRequired}
							class:badge-muted={!storagePolicy?.runtimeRegistrySecurityNotifications?.available}
						>
							{formatRuntimeRegistrySecurityStatus()}
						</span>
					</div>
					{#if storagePolicy?.runtimeRegistrySecurityNotifications?.available}
						<div class="stats-grid">
							{#each getRuntimeRegistrySecurityItems() as item (item.label)}
								<div>
									<div class="summary-label">{item.label}</div>
									<div class="summary-value compact">{item.value}</div>
								</div>
							{/each}
						</div>
					{:else if storagePolicy?.runtimeRegistrySecurityNotifications?.unavailableReason}
						<p class="helper-text">
							{storagePolicy.runtimeRegistrySecurityNotifications.unavailableReason}
						</p>
					{:else}
						<p class="helper-text">Storage registry alerts have not been loaded.</p>
					{/if}
				</div>

				<div class="policy-grid">
					{#if storagePolicy}
							{#each Object.values(storagePolicy.slicePolicies) as policy (policy.slice)}
							<article class="policy-card">
								<div class="policy-card-header">
									<strong>{policy.slice}</strong>
									<span
										class:badge-primary={policy.tenantOverrideAllowed}
										class:badge-muted={!policy.tenantOverrideAllowed}
										class="badge"
									>
										{formatPolicyBadge(policy.tenantOverrideAllowed)}
									</span>
								</div>
								<div class="policy-card-body">
									<div>{boundaryClassLabels[policy.boundaryClass]}</div>
									<div>D1 default: {policy.d1Default ? 'Yes' : 'No'}</div>
									<div>Non-D1 option required: {policy.nonD1OptionRequired ? 'Yes' : 'No'}</div>
									{#if policy.compatibilityShorthand}
										<div>`users_core` is treated as auth-core shorthand.</div>
									{/if}
								</div>
							</article>
						{/each}
					{/if}
				</div>
			</section>

			<section class="panel">
				<h2>Storage Profiles</h2>
				<p class="helper-text">
					Profiles shown here are read-only for now. The compatibility badge indicates whether a
					tenant may safely point at the profile without moving the auth core plane.
				</p>

				<div class="profile-list">
					{#each storageProfiles as profile (profile.id)}
						{@const tenantPolicy = getStorageTenantPolicy(profile.id)}
						{@const capabilityStatus = getStorageCapabilityStatus(profile.id)}
						{@const activation = getActivationStatus(storageActivationStatus, profile.id)}
						<button class="profile-item profile-item-static" disabled>
							<div class="profile-title-row">
								<strong>{profile.label}</strong>
								{#if profile.builtin}
									<span class="badge">Builtin</span>
								{/if}
								{#if profile.id === defaultStorageProfileId}
									<span class="badge badge-primary">Default</span>
								{/if}
								<span
									class:badge-primary={tenantPolicy?.tenantOverrideAllowed}
									class:badge-muted={!tenantPolicy?.tenantOverrideAllowed}
									class="badge"
								>
									{describeTenantOverrideCompatibility(tenantPolicy)}
								</span>
								<span
									class="badge"
									class:badge-primary={activation?.state === 'ready'}
									class:badge-warning={activation?.state === 'warning'}
									class:badge-danger={activation?.state === 'blocked'}
								>
									Activation: {activationLabel(activation)}
								</span>
								<span
									class="badge"
									class:badge-primary={capabilityStatus?.mvpReady}
									class:badge-warning={capabilityStatus && !capabilityStatus.mvpReady}
									class:badge-muted={!capabilityStatus}
								>
									{formatCapabilityReadiness(capabilityStatus)}
								</span>
							</div>
							<div class="profile-id">{profile.id}</div>
							<div class="helper-text">{formatStorageProfileSummary(profile)}</div>
							{#if capabilityStatus && !capabilityStatus.mvpReady}
								<div class="reference-status-list">
									{#each capabilityStatus.capabilities.filter((item) => item.state === 'unsupported' || item.state === 'partial').slice(0, 3) as item (item.id)}
										<div class="helper-text warning-text">
											{item.label}: {item.state}
										</div>
									{/each}
								</div>
							{/if}
							{#if activation?.blockingReasons?.length}
								<div class="helper-text warning-text">
									{activation.blockingReasons[0]}
								</div>
							{/if}
						</button>
					{/each}
				</div>
			</section>

			<section class="panel">
				<h2>Reference Catalog</h2>
				<p class="helper-text">
					Setup currently owns runtime bindings and connection aliases. You can save profile refs
					before setup catches up, but activation stays blocked until the runtime can resolve them.
				</p>
				{#if referenceCatalog}
					<div class="policy-grid">
						<article class="policy-card">
							<div class="policy-card-header">
								<strong>D1 Bindings</strong>
								<span class="badge badge-muted">{referenceCatalog.bindingRefs.d1.length}</span>
							</div>
							<div class="chip-row">
								{#if referenceCatalog.bindingRefs.d1.length}
									{#each referenceCatalog.bindingRefs.d1 as ref (ref)}
										<span class="badge">{ref}</span>
									{/each}
								{:else}
									<span class="helper-text">None detected</span>
								{/if}
							</div>
						</article>

						<article class="policy-card">
							<div class="policy-card-header">
								<strong>R2 Bindings</strong>
								<span class="badge badge-muted">{referenceCatalog.bindingRefs.r2.length}</span>
							</div>
							<div class="chip-row">
								{#if referenceCatalog.bindingRefs.r2.length}
									{#each referenceCatalog.bindingRefs.r2 as ref (ref)}
										<span class="badge">{ref}</span>
									{/each}
								{:else}
									<span class="helper-text">None detected</span>
								{/if}
							</div>
						</article>

						<article class="policy-card">
							<div class="policy-card-header">
								<strong>Hyperdrive Bindings</strong>
								<span class="badge badge-muted">{referenceCatalog.bindingRefs.hyperdrive.length}</span>
							</div>
							<div class="chip-row">
								{#if referenceCatalog.bindingRefs.hyperdrive.length}
									{#each referenceCatalog.bindingRefs.hyperdrive as ref (ref)}
										<span class="badge">{ref}</span>
									{/each}
								{:else}
									<span class="helper-text">None detected</span>
								{/if}
							</div>
						</article>

						<article class="policy-card">
							<div class="policy-card-header">
								<strong>Connection Refs</strong>
								<span class="badge badge-muted">{referenceCatalog.connectionRefs.all.length}</span>
							</div>
							<div class="chip-row">
								{#if referenceCatalog.connectionRefs.all.length}
									{#each referenceCatalog.connectionRefs.all as ref (ref)}
										<span class="badge">{ref}</span>
									{/each}
								{:else}
									<span class="helper-text">None detected</span>
								{/if}
							</div>
						</article>
					</div>
				{:else}
					<p class="helper-text">No runtime reference catalog is available.</p>
				{/if}
			</section>
		</div>

		<div class="profiles-grid">
			<section class="panel">
				<h2>Default Runtime Profiles</h2>
				<div class="field">
					<label for="defaultStorageProfile">Default storage profile</label>
					<select id="defaultStorageProfile" bind:value={defaultStorageProfileId}>
						{#each storageProfiles as profile (profile.id)}
							<option
								value={profile.id}
								disabled={isActivationBlocked(getActivationStatus(storageActivationStatus, profile.id))}
							>
								{profile.label} ({profile.id})
							</option>
						{/each}
					</select>
				</div>
				{#if defaultsActivationStatus.storage}
					<div class="helper-text">
						Current default storage activation: {activationLabel(defaultsActivationStatus.storage)}
					</div>
				{/if}
				{#if isActivationBlocked(getActivationStatus(storageActivationStatus, defaultStorageProfileId))}
					<div class="alert alert-error">
						{getActivationStatus(storageActivationStatus, defaultStorageProfileId)?.blockingReasons?.[0] ??
							'Selected storage profile cannot be activated.'}
					</div>
				{/if}

				<div class="field">
					<label for="defaultAuditProfile">Default profile</label>
					<select id="defaultAuditProfile" bind:value={defaultAuditProfileId}>
						{#each auditProfiles as profile (profile.id)}
							<option
								value={profile.id}
								disabled={isActivationBlocked(getActivationStatus(auditActivationStatus, profile.id))}
							>
								{profile.label} ({profile.id})
							</option>
						{/each}
					</select>
				</div>
				{#if defaultsActivationStatus.audit}
					<div class="helper-text">
						Current default audit activation: {activationLabel(defaultsActivationStatus.audit)}
					</div>
				{/if}
				{#if isActivationBlocked(getActivationStatus(auditActivationStatus, defaultAuditProfileId))}
					<div class="alert alert-error">
						{getActivationStatus(auditActivationStatus, defaultAuditProfileId)?.blockingReasons?.[0] ??
							'Selected audit profile cannot be activated.'}
					</div>
				{/if}

				<div class="field">
					<label for="defaultResidencyProfile">Default residency profile</label>
					<select id="defaultResidencyProfile" bind:value={defaultResidencyProfileId}>
						{#each residencyProfiles as profile (profile.id)}
							<option
								value={profile.id}
								disabled={isActivationBlocked(getActivationStatus(residencyActivationStatus, profile.id))}
							>
								{profile.label} ({profile.id})
							</option>
						{/each}
					</select>
				</div>
				{#if defaultsActivationStatus.residency}
					<div class="helper-text">
						Current default residency activation: {activationLabel(defaultsActivationStatus.residency)}
					</div>
				{/if}
				{#if isActivationBlocked(getActivationStatus(residencyActivationStatus, defaultResidencyProfileId))}
					<div class="alert alert-error">
						{getActivationStatus(residencyActivationStatus, defaultResidencyProfileId)?.blockingReasons?.[0] ??
							'Selected residency profile cannot be activated.'}
					</div>
				{/if}
				<button class="btn btn-primary" onclick={saveDefault} disabled={saving}>
					Save Defaults
				</button>

				<hr />

				<h2>Profiles</h2>
				<div class="profile-list">
					{#each auditProfiles as profile (profile.id)}
						{@const activation = getActivationStatus(auditActivationStatus, profile.id)}
						<button class="profile-item" onclick={() => selectProfileById(profile.id)}>
							<div class="profile-title-row">
								<strong>{profile.label}</strong>
								{#if profile.builtin}
									<span class="badge">Builtin</span>
								{/if}
								{#if profile.id === defaultAuditProfileId}
									<span class="badge badge-primary">Default</span>
								{/if}
								<span
									class="badge"
									class:badge-primary={activation?.state === 'ready'}
									class:badge-warning={activation?.state === 'warning'}
									class:badge-danger={activation?.state === 'blocked'}
								>
									{activationLabel(activation)}
								</span>
							</div>
							<div class="profile-id">{profile.id}</div>
							{#if activation?.blockingReasons?.length}
								<div class="helper-text warning-text">
									{activation.blockingReasons[0]}
								</div>
							{:else if activation?.warnings?.length}
								<div class="helper-text warning-text">{activation.warnings[0]}</div>
							{/if}
						</button>
					{/each}
				</div>
				<button class="btn btn-secondary" onclick={() => setSelectedProfile(null)}>
					New Custom Profile
				</button>
			</section>

			<section class="panel">
				<h2>Audit Profile Editor</h2>
				<p class="helper-text">
					Edit the JSON body sent to `/api/admin/runtime-profiles/audit/:id`. This is the fastest
					way to manage archive-only profiles and sink references while still keeping the exact
					runtime profile payload visible.
				</p>

				<div class="field">
					<label for="profileId">Profile ID</label>
					<input
						id="profileId"
						bind:value={profileIdInput}
						placeholder="custom:audit:http-export"
					/>
				</div>

				<div class="status-panel">
					<div class="status-header">
						<h3>Structured Helpers</h3>
						<span class="badge badge-muted">JSON-safe</span>
					</div>
					<p class="helper-text">
						Use these buttons to insert common archive and sink templates without rewriting the
						whole profile. Firehose remains intentionally out of scope here.
					</p>
					<div class="actions">
						<button class="btn btn-secondary" type="button" onclick={addArchiveTemplate}>
							Add R2 Archive Target
						</button>
						<button
							class="btn btn-secondary"
							type="button"
							onclick={() => insertSinkTemplate('http')}
						>
							Add HTTP Sink
						</button>
						<button
							class="btn btn-secondary"
							type="button"
							onclick={() => insertSinkTemplate('logpush')}
						>
							Add Logpush Sink
						</button>
					</div>
				</div>

				<div class="status-panel">
					<div class="status-header">
						<h3>Structured Audit Form</h3>
						{#if parsedProfileDraft}
							<span class="badge badge-primary">Parsed</span>
						{:else}
							<span class="badge badge-danger">Invalid JSON</span>
						{/if}
					</div>
					{#if profileJsonError}
						<div class="alert alert-error">{profileJsonError}</div>
					{:else if parsedProfileDraft}
						<div class="draft-card">
							<div class="status-header">
								<h3>Primary</h3>
								<span class="badge badge-muted">
									{formatAuditTargetSummary(getParsedProfileTarget('primary'))}
								</span>
							</div>
							<div class="field">
								<label for="primaryType">Primary Type</label>
								<select
									id="primaryType"
									value={parsedProfileDraft.primary?.type ?? 'archive-only'}
									onchange={(event) =>
										updatePrimaryType(
											(event.currentTarget as HTMLSelectElement).value as EditableAuditPrimaryType
										)}
								>
									<option value="archive-only">archive-only</option>
									<option value="d1">d1</option>
									<option value="postgres">postgres</option>
									<option value="mysql">mysql</option>
								</select>
							</div>
							{#if parsedProfileDraft.primary}
								<div class="field-grid">
									<div class="field">
										<label for="primaryBindingRef">Binding Ref</label>
										<input
											id="primaryBindingRef"
											list={
												parsedProfileDraft.primary.type === 'd1'
													? 'runtime-d1-binding-refs'
													: 'runtime-hyperdrive-binding-refs'
											}
											value={String(parsedProfileDraft.primary.bindingRef ?? '')}
											oninput={(event) =>
												updatePrimaryField(
													'bindingRef',
													(event.currentTarget as HTMLInputElement).value
												)}
										/>
									</div>
									<div class="field">
										<label for="primaryConnectionRef">Connection Ref</label>
										<input
											id="primaryConnectionRef"
											list="runtime-connection-refs"
											value={String(parsedProfileDraft.primary.connectionRef ?? '')}
											oninput={(event) =>
												updatePrimaryField(
													'connectionRef',
													(event.currentTarget as HTMLInputElement).value
												)}
										/>
									</div>
									<div class="field">
										<label for="primaryDataset">Dataset (optional)</label>
										<input
											id="primaryDataset"
											value={String(parsedProfileDraft.primary.dataset ?? '')}
											oninput={(event) =>
												updatePrimaryField('dataset', (event.currentTarget as HTMLInputElement).value)}
										/>
									</div>
								</div>
								{#each getAuditTargetDetails(parsedProfileDraft.primary) as detail (detail)}
									<div class="helper-text">{detail}</div>
								{/each}
							{:else}
								<p class="helper-text">
									Archive-only profile. No synchronous primary write target is configured.
								</p>
							{/if}
						</div>

						<div class="draft-card">
							<div class="status-header">
								<h3>Archive</h3>
								{#if parsedProfileDraft.archive}
									<button class="btn btn-secondary btn-sm" type="button" onclick={removeArchiveTemplate}>
										Remove
									</button>
								{/if}
							</div>
							{#if parsedProfileDraft.archive}
								<div class="field-grid">
									<div class="field">
										<label for="archiveBucketRef">Bucket Ref</label>
										<input
											id="archiveBucketRef"
											list="runtime-r2-binding-refs"
											value={String(parsedProfileDraft.archive.bucketRef ?? '')}
											oninput={(event) =>
												updateArchiveField('bucketRef', (event.currentTarget as HTMLInputElement).value)}
										/>
									</div>
									<div class="field">
										<label for="archivePrefix">Prefix</label>
										<input
											id="archivePrefix"
											value={String(parsedProfileDraft.archive.prefix ?? '')}
											oninput={(event) =>
												updateArchiveField('prefix', (event.currentTarget as HTMLInputElement).value)}
										/>
									</div>
								</div>
								<div class="helper-text">{formatAuditTargetSummary(parsedProfileDraft.archive)}</div>
							{:else}
								<p class="helper-text">No archive target configured.</p>
							{/if}
						</div>

						<div class="draft-card">
							<div class="status-header">
								<h3>Sinks</h3>
								<span class="badge badge-muted">{parsedProfileDraft.sinks.length}</span>
							</div>
							{#if parsedProfileDraft.sinks.length === 0}
								<p class="helper-text">No forwarding sinks configured.</p>
							{:else}
								<div class="reference-status-list">
									{#each parsedProfileDraft.sinks as sink, index (index)}
										<div class="reference-status-card">
											<div class="status-header">
												<strong>{formatSinkLabel(sink, index)}</strong>
												<button class="btn btn-secondary btn-sm" type="button" onclick={() => removeSink(index)}>
													Remove
												</button>
											</div>
											<div class="field">
												<label for={`sink-type-${index}`}>Sink Type</label>
												<select
													id={`sink-type-${index}`}
													value={sink.type === 'logpush' ? 'logpush' : 'http'}
													onchange={(event) =>
														replaceSinkType(index, (event.currentTarget as HTMLSelectElement).value as EditableAuditSinkType)}
												>
													<option value="http">HTTP</option>
													<option value="logpush">Logpush</option>
												</select>
											</div>
											{#if sink.type === 'logpush'}
												<div class="field-grid">
													<div class="field">
														<label for={`sink-destination-${index}`}>Destination Ref</label>
														<input
															id={`sink-destination-${index}`}
															value={String(sink.destinationRef ?? '')}
															oninput={(event) =>
																updateSinkField(index, 'destinationRef', (event.currentTarget as HTMLInputElement).value)}
														/>
													</div>
													<div class="field">
														<label for={`sink-dataset-${index}`}>Dataset</label>
														<input
															id={`sink-dataset-${index}`}
															value={String(sink.dataset ?? '')}
															oninput={(event) =>
																updateSinkField(index, 'dataset', (event.currentTarget as HTMLInputElement).value)}
														/>
													</div>
												</div>
											{:else}
												<div class="field-grid">
													<div class="field">
														<label for={`sink-url-${index}`}>Inline URL</label>
														<input
															id={`sink-url-${index}`}
															value={String(sink.url ?? '')}
															oninput={(event) =>
																updateSinkField(index, 'url', (event.currentTarget as HTMLInputElement).value)}
														/>
													</div>
													<div class="field">
														<label for={`sink-urlref-${index}`}>URL Ref</label>
														<input
															id={`sink-urlref-${index}`}
															value={String(sink.urlRef ?? '')}
															oninput={(event) =>
																updateSinkField(index, 'urlRef', (event.currentTarget as HTMLInputElement).value)}
														/>
													</div>
													<div class="field">
														<label for={`sink-tokenref-${index}`}>Auth Token Ref</label>
														<input
															id={`sink-tokenref-${index}`}
															value={String(sink.authTokenRef ?? '')}
															oninput={(event) =>
																updateSinkField(index, 'authTokenRef', (event.currentTarget as HTMLInputElement).value)}
														/>
													</div>
												</div>
											{/if}
											{#each getAuditTargetDetails(sink) as detail (detail)}
												<div class="helper-text">{detail}</div>
											{/each}
										</div>
									{/each}
								</div>
							{/if}
						</div>

						<div class="draft-grid">
							<article class="draft-card">
								<label for="archiveFailureMode">Archive Failure Mode</label>
								<select
									id="archiveFailureMode"
									value={parsedProfileDraft.archiveFailureMode ?? ''}
									onchange={(event) =>
										updateFailureMode(
											'archiveFailureMode',
											(event.currentTarget as HTMLSelectElement).value
										)}
								>
									<option value="">Not set</option>
									<option value="best_effort">best_effort</option>
									<option value="gate_cleanup">gate_cleanup</option>
								</select>
							</article>
							<article class="draft-card">
								<label for="sinkFailureMode">Sink Failure Mode</label>
								<select
									id="sinkFailureMode"
									value={parsedProfileDraft.sinkFailureMode ?? ''}
									onchange={(event) =>
										updateFailureMode(
											'sinkFailureMode',
											(event.currentTarget as HTMLSelectElement).value
										)}
								>
									<option value="">Not set</option>
									<option value="best_effort">best_effort</option>
									<option value="retry_until_ttl">retry_until_ttl</option>
								</select>
							</article>
						</div>

						{#if parsedProfileDraft.retention}
							<div class="draft-card">
								<div class="status-header">
									<h3>Retention</h3>
									<span class="badge badge-muted">structured</span>
								</div>
								<div class="field-grid">
									<div class="field">
										<label for="eventLogRetentionDays">Event Log Days</label>
										<input
											id="eventLogRetentionDays"
											type="number"
											min="1"
											value={String(parsedProfileDraft.retention.eventLogRetentionDays ?? '')}
											oninput={(event) =>
												updateRetentionNumber(
													'eventLogRetentionDays',
													(event.currentTarget as HTMLInputElement).value
												)}
										/>
									</div>
									<div class="field">
										<label for="piiLogRetentionDays">PII Log Days</label>
										<input
											id="piiLogRetentionDays"
											type="number"
											min="1"
											value={String(parsedProfileDraft.retention.piiLogRetentionDays ?? '')}
											oninput={(event) =>
												updateRetentionNumber(
													'piiLogRetentionDays',
													(event.currentTarget as HTMLInputElement).value
												)}
										/>
									</div>
									<div class="field">
										<label for="minimumRetentionDays">Minimum Retention Days</label>
										<input
											id="minimumRetentionDays"
											type="number"
											min="1"
											value={String(parsedProfileDraft.retention.minimumRetentionDays ?? '')}
											oninput={(event) =>
												updateRetentionNumber(
													'minimumRetentionDays',
													(event.currentTarget as HTMLInputElement).value
												)}
										/>
									</div>
									<div class="field">
										<label for="primaryDays">Primary Days</label>
										<input
											id="primaryDays"
											type="number"
											min="1"
											value={String(parsedProfileDraft.retention.primaryDays ?? '')}
											oninput={(event) =>
												updateRetentionNumber(
													'primaryDays',
													(event.currentTarget as HTMLInputElement).value
												)}
										/>
									</div>
									<div class="field">
										<label for="archiveDays">Archive Days</label>
										<input
											id="archiveDays"
											type="number"
											min="1"
											value={String(parsedProfileDraft.retention.archiveDays ?? '')}
											oninput={(event) =>
												updateRetentionNumber(
													'archiveDays',
													(event.currentTarget as HTMLInputElement).value
												)}
										/>
									</div>
								</div>
								<label class="checkbox-row">
									<input
										type="checkbox"
										checked={Boolean(parsedProfileDraft.retention.archiveBeforeDelete)}
										onchange={(event) =>
											updateRetentionArchiveBeforeDelete(
												(event.currentTarget as HTMLInputElement).checked
											)}
									/>
									<span>archiveBeforeDelete</span>
								</label>
							</div>
						{/if}
					{/if}
				</div>

				<datalist id="runtime-d1-binding-refs">
					{#each getReferenceCatalogValues(referenceCatalog?.bindingRefs.d1) as ref (ref)}
						<option value={ref}></option>
					{/each}
				</datalist>

				<datalist id="runtime-r2-binding-refs">
					{#each getArchiveBucketOptions() as ref (ref)}
						<option value={ref}></option>
					{/each}
				</datalist>

				<datalist id="runtime-hyperdrive-binding-refs">
					{#each getReferenceCatalogValues(referenceCatalog?.bindingRefs.hyperdrive) as ref (ref)}
						<option value={ref}></option>
					{/each}
				</datalist>

				<datalist id="runtime-connection-refs">
					{#each getConnectionRefOptions() as ref (ref)}
						<option value={ref}></option>
					{/each}
				</datalist>

				<div class="field">
					<label for="profileJson">Profile JSON</label>
					<textarea id="profileJson" bind:value={profileJson} rows="28" spellcheck="false"
					></textarea>
				</div>

				{#if selectedProfileId}
					<div class="status-panel">
						<div class="status-header">
							<h3>Activation Readiness</h3>
							<span
								class="badge"
								class:badge-primary={getSelectedAuditActivationStatus()?.state === 'ready'}
								class:badge-warning={getSelectedAuditActivationStatus()?.state === 'warning'}
								class:badge-danger={getSelectedAuditActivationStatus()?.state === 'blocked'}
							>
								{activationLabel(getSelectedAuditActivationStatus())}
							</span>
						</div>
						{#if getSelectedAuditActivationStatus()?.blockingReasons?.length}
							<ul class="status-list">
								{#each getSelectedAuditActivationStatus()?.blockingReasons ?? [] as reason (reason)}
									<li>{reason}</li>
								{/each}
							</ul>
						{:else if getSelectedAuditActivationStatus()?.warnings?.length}
							<ul class="status-list">
								{#each getSelectedAuditActivationStatus()?.warnings ?? [] as reason (reason)}
									<li>{reason}</li>
								{/each}
							</ul>
						{:else}
							<p class="helper-text">This profile is ready to be activated as the environment default.</p>
						{/if}
					</div>

					<div class="status-panel">
						<h3>Reference Status</h3>
						<div class="reference-status-list">
							{#each getSelectedAuditReferenceStatus() as entry (entry.path)}
								<div class="reference-status-card">
									<div class="profile-title-row">
										<strong>{entry.path}</strong>
										<span
											class="badge"
											class:badge-primary={entry.severity === 'info'}
											class:badge-warning={entry.severity === 'warning'}
											class:badge-danger={entry.severity === 'error'}
										>
											{severityLabel(entry)}
										</span>
										<span class="badge badge-muted">{entry.activation}</span>
									</div>
									<div class="helper-text">{entry.type} / {entry.resolution}</div>
									<div class="helper-text">Reference: {getReferenceSummary(entry)}</div>
									{#if entry.reason}
										<div class="helper-text warning-text">{entry.reason}</div>
									{/if}
								</div>
							{/each}
						</div>
					</div>
				{/if}

				<div class="actions">
					<button class="btn btn-primary" onclick={saveProfile} disabled={saving}>
						Save Profile
					</button>
					<button
						class="btn btn-danger"
						onclick={deleteProfile}
						disabled={saving || !selectedProfileId || selectedProfileId.startsWith('builtin:')}
					>
						Delete Profile
					</button>
				</div>
			</section>
		</div>
	{/if}
</div>

<style>
	.runtime-profiles-page {
		display: flex;
		flex-direction: column;
		gap: 20px;
	}

	.page-header {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.back-link {
		color: var(--text-secondary);
		text-decoration: none;
	}

	.profiles-grid {
		display: grid;
		grid-template-columns: minmax(320px, 380px) minmax(0, 1fr);
		gap: 20px;
	}

	.storage-grid {
		grid-template-columns: minmax(320px, 1fr) minmax(320px, 1fr);
	}

	.panel {
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: 16px;
		padding: 20px;
		display: flex;
		flex-direction: column;
		gap: 16px;
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	select,
	input,
	textarea {
		width: 100%;
		border: 1px solid var(--border);
		border-radius: 10px;
		padding: 10px 12px;
		background: var(--surface-elevated, var(--surface));
		color: var(--text-primary);
		font: inherit;
	}

	textarea {
		font-family: 'SF Mono', 'Monaco', 'Cascadia Code', monospace;
		min-height: 420px;
	}

	.profile-list {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	.profile-item {
		text-align: left;
		border: 1px solid var(--border);
		border-radius: 12px;
		padding: 12px;
		background: var(--surface-elevated, var(--surface));
	}

	.profile-item-static {
		cursor: default;
		opacity: 1;
	}

	.profile-title-row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
	}

	.profile-id,
	.helper-text {
		color: var(--text-secondary);
		font-size: 0.92rem;
	}

	.badge {
		display: inline-flex;
		align-items: center;
		padding: 2px 8px;
		border-radius: 999px;
		background: var(--neutral-100, #f3f4f6);
		font-size: 0.75rem;
	}

	.badge-primary {
		background: var(--primary-light, #dbeafe);
		color: var(--primary, #2563eb);
	}

	.badge-muted {
		background: var(--neutral-100, #f3f4f6);
		color: var(--text-secondary);
	}

	.badge-warning {
		background: #fef3c7;
		color: #92400e;
	}

	.badge-danger {
		background: #fee2e2;
		color: #b91c1c;
	}

	.policy-summary {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 12px;
		padding: 14px;
		border-radius: 12px;
		background: var(--surface-elevated, var(--surface));
		border: 1px solid var(--border);
	}

	.summary-label {
		font-size: 0.8rem;
		color: var(--text-secondary);
		margin-bottom: 4px;
	}

	.summary-value {
		font-weight: 600;
		word-break: break-word;
	}

	.summary-value.compact {
		font-size: 0.9rem;
	}

	.chip-row {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}

	.policy-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
		gap: 12px;
	}

	.stats-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
		gap: 12px;
	}

	.policy-card {
		border: 1px solid var(--border);
		border-radius: 12px;
		padding: 14px;
		background: var(--surface-elevated, var(--surface));
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	.policy-card-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
	}

	.policy-card-body {
		display: flex;
		flex-direction: column;
		gap: 6px;
		color: var(--text-secondary);
		font-size: 0.92rem;
	}

	.actions {
		display: flex;
		gap: 12px;
		flex-wrap: wrap;
	}

	.status-panel {
		border: 1px solid var(--border);
		border-radius: 12px;
		padding: 14px;
		background: var(--surface-elevated, var(--surface));
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	.status-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
	}

	.status-list {
		margin: 0;
		padding-left: 18px;
		color: var(--text-secondary);
	}

	.reference-status-list {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	.reference-status-card {
		border: 1px solid var(--border);
		border-radius: 10px;
		padding: 10px 12px;
		background: var(--surface);
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.draft-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
		gap: 12px;
	}

	.draft-card {
		border: 1px solid var(--border);
		border-radius: 10px;
		padding: 12px;
		background: var(--surface);
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.warning-text {
		color: #92400e;
	}

	.loading-state {
		padding: 32px 0;
	}

	@media (max-width: 960px) {
		.profiles-grid {
			grid-template-columns: 1fr;
		}

		.policy-summary {
			grid-template-columns: 1fr;
		}
	}
</style>
