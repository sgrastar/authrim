<script lang="ts">
	import { onMount } from 'svelte';
	import {
		adminRuntimeProfilesAPI,
		type RuntimeProfileRecord,
		type StorageProfileListPolicy,
		type StorageProfileTenantOverridePolicy,
		type StorageSliceBoundaryPolicy
	} from '$lib/api/admin-runtime-profiles';

	let loading = $state(true);
	let saving = $state(false);
	let error = $state('');
	let success = $state('');

	let auditProfiles = $state<RuntimeProfileRecord[]>([]);
	let storageProfiles = $state<RuntimeProfileRecord[]>([]);
	let storagePolicy = $state<StorageProfileListPolicy | null>(null);
	let defaultAuditProfileId = $state('');
	let defaultStorageProfileId = $state('');
	let selectedProfileId = $state('');
	let profileIdInput = $state('');
	let profileJson = $state('');

	const boundaryClassLabels: Record<StorageSliceBoundaryPolicy['boundaryClass'], string> = {
		auth_core: 'Auth Core Plane',
		pii: 'PII Plane',
		custom_extension: 'Custom / Extension Plane'
	};

	function normalizeProfileJson(profile: RuntimeProfileRecord): string {
		const { id: _id, kind: _kind, builtin: _builtin, ...editable } = profile;
		return JSON.stringify(editable, null, 2);
	}

	function getStorageTenantPolicy(profileId: string): StorageProfileTenantOverridePolicy | null {
		return storagePolicy?.tenantOverrideEligibility?.[profileId] ?? null;
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

	function formatPolicyBadge(value: boolean): string {
		return value ? 'Allowed' : 'Blocked';
	}

	function setSelectedProfile(profile: RuntimeProfileRecord | null) {
		if (!profile) {
			selectedProfileId = '';
			profileIdInput = '';
			profileJson = JSON.stringify(
				{
					label: 'New Audit Profile',
					primary: null,
					archive: null,
					sinks: [
						{
							type: 'http',
							url: 'https://example.com/audit',
							headers: {
								'X-Authrim-Sink': 'enabled'
							}
						}
					]
				},
				null,
				2
			);
			return;
		}

		selectedProfileId = profile.id;
		profileIdInput = profile.id;
		profileJson = normalizeProfileJson(profile);
	}

	async function load() {
		loading = true;
		error = '';

		try {
			const [auditProfilesResult, storageProfilesResult, defaultsResult] = await Promise.all([
				adminRuntimeProfilesAPI.list('audit', true),
				adminRuntimeProfilesAPI.list('storage', true),
				adminRuntimeProfilesAPI.getDefaults()
			]);

			auditProfiles = auditProfilesResult.profiles.audit ?? [];
			storageProfiles = storageProfilesResult.profiles.storage ?? [];
			storagePolicy = storageProfilesResult.storage_policy ?? null;
			defaultAuditProfileId = defaultsResult.defaults.auditProfileId;
			defaultStorageProfileId = defaultsResult.defaults.storageProfileId;

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
			await adminRuntimeProfilesAPI.updateDefaults({ auditProfileId: defaultAuditProfileId });
			success = 'Default audit profile updated';
			await load();
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to update default profile';
		} finally {
			saving = false;
		}
	}

	function selectProfileById(id: string) {
		const profile = auditProfiles.find((item) => item.id === id) ?? null;
		setSelectedProfile(profile);
	}

	onMount(load);
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
								{#each storagePolicy.authCoreSlices as slice}
									<span class="badge">{slice}</span>
								{/each}
							{:else}
								<span class="badge">users_core</span>
							{/if}
						</div>
					</div>
				</div>

				<div class="policy-grid">
					{#if storagePolicy}
						{#each Object.values(storagePolicy.slicePolicies) as policy}
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
					{#each storageProfiles as profile}
						{@const tenantPolicy = getStorageTenantPolicy(profile.id)}
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
							</div>
							<div class="profile-id">{profile.id}</div>
							<div class="helper-text">{formatStorageProfileSummary(profile)}</div>
						</button>
					{/each}
				</div>
			</section>
		</div>

		<div class="profiles-grid">
			<section class="panel">
				<h2>Default Audit Profile</h2>
				<div class="field">
					<label for="defaultAuditProfile">Default profile</label>
					<select id="defaultAuditProfile" bind:value={defaultAuditProfileId}>
						{#each auditProfiles as profile}
							<option value={profile.id}>{profile.label} ({profile.id})</option>
						{/each}
					</select>
				</div>
				<button class="btn btn-primary" onclick={saveDefault} disabled={saving}>
					Save Default
				</button>

				<hr />

				<h2>Profiles</h2>
				<div class="profile-list">
					{#each auditProfiles as profile}
						<button class="profile-item" onclick={() => selectProfileById(profile.id)}>
							<div class="profile-title-row">
								<strong>{profile.label}</strong>
								{#if profile.builtin}
									<span class="badge">Builtin</span>
								{/if}
								{#if profile.id === defaultAuditProfileId}
									<span class="badge badge-primary">Default</span>
								{/if}
							</div>
							<div class="profile-id">{profile.id}</div>
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
					way to manage `http`, `logpush`, and `firehose` sinks until a richer form UI lands.
				</p>

				<div class="field">
					<label for="profileId">Profile ID</label>
					<input
						id="profileId"
						bind:value={profileIdInput}
						placeholder="custom:audit:http-export"
					/>
				</div>

				<div class="field">
					<label for="profileJson">Profile JSON</label>
					<textarea id="profileJson" bind:value={profileJson} rows="28" spellcheck="false"
					></textarea>
				</div>

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
