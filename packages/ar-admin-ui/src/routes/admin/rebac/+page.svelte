<script lang="ts">
	import { onMount } from 'svelte';
	import { settingsContext } from '$lib/stores/settings-context.svelte';
	import {
		adminReBACAPI,
		type ObjectTypeSummary,
		type PermissionCheckResult
	} from '$lib/api/admin-rebac';
	import { adminSettingsAPI } from '$lib/api/admin-settings';
	import { ToggleSwitch } from '$lib/components';
	import { LL } from '$i18n/i18n-svelte';

	// State
	let objectTypes: ObjectTypeSummary[] = $state([]);
	let loading = $state(true);
	let error = $state('');

	// ReBAC Feature Flag state
	let rebacEnabled = $state(false);
	let rebacLoading = $state(true);
	let rebacError = $state('');
	let rebacSaving = $state(false);
	let featureFlagsVersion = $state('');

	// Permission check state
	let checkUserId = $state('');
	let checkRelation = $state('');
	let checkObject = $state('');
	let checkResult: PermissionCheckResult | null = $state(null);
	let checking = $state(false);
	let checkError = $state('');
	let loadedTenantId = $state('');

	async function loadObjectTypes() {
		loading = true;
		error = '';

		try {
			const response = await adminReBACAPI.listObjectTypes();
			objectTypes = response.object_types;
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_rebac_load_object_types_failed();
		} finally {
			loading = false;
		}
	}

	async function runPermissionCheck() {
		if (!checkUserId || !checkRelation || !checkObject) {
			checkError = $LL.admin_rebac_all_fields_required();
			return;
		}

		checking = true;
		checkError = '';
		checkResult = null;

		try {
			checkResult = await adminReBACAPI.checkPermission({
				user_id: checkUserId,
				relation: checkRelation,
				object: checkObject
			});
		} catch (err) {
			checkError = err instanceof Error ? err.message : $LL.admin_rebac_check_permission_failed();
		} finally {
			checking = false;
		}
	}

	async function loadRebacStatus() {
		rebacLoading = true;
		rebacError = '';

		try {
			const settings = await adminSettingsAPI.getSettings('feature-flags');
			rebacEnabled = settings.values['feature.enable_rebac'] === true;
			featureFlagsVersion = settings.version;
		} catch (err) {
			rebacError = err instanceof Error ? err.message : $LL.admin_rebac_status_load_failed();
		} finally {
			rebacLoading = false;
		}
	}

	async function toggleRebac() {
		if (rebacSaving) return;

		rebacSaving = true;
		rebacError = '';

		try {
			if (!featureFlagsVersion) {
				const settings = await adminSettingsAPI.getSettings('feature-flags');
				featureFlagsVersion = settings.version;
				rebacEnabled = settings.values['feature.enable_rebac'] === true;
			}

			const newValue = !rebacEnabled;
			const result = await adminSettingsAPI.updateSettings('feature-flags', {
				ifMatch: featureFlagsVersion,
				set: { 'feature.enable_rebac': newValue }
			});
			rebacEnabled = newValue;
			featureFlagsVersion = result.version;
		} catch (err) {
			rebacError = err instanceof Error ? err.message : $LL.admin_rebac_status_update_failed();
			await loadRebacStatus();
		} finally {
			rebacSaving = false;
		}
	}

	onMount(async () => {
		await settingsContext.initialize();
	});

	$effect(() => {
		const tenantId = settingsContext.tenantId;
		if (!tenantId || tenantId === loadedTenantId) return;
		loadedTenantId = tenantId;
		checkResult = null;
		checkError = '';
		loadRebacStatus();
		loadObjectTypes();
	});
</script>

<svelte:head>
	<title>{$LL.admin_rebac_head_title()}</title>
</svelte:head>

<div class="admin-page">
	<!-- Info Banner -->
	<div class="mb-4 bg-blue-50 border border-blue-200 rounded-lg p-4">
		<div class="flex items-start">
			<span class="i-ph-info text-blue-600 text-xl mr-3 mt-0.5"></span>
			<div>
				<h3 class="font-semibold text-blue-900 mb-1">{$LL.admin_rebac_info_title()}</h3>
				<p class="text-sm text-blue-800">
					{$LL.admin_rebac_info_prefix()}<strong>End Users</strong
					>{$LL.admin_rebac_info_middle()}<strong>Admin Operator</strong
					>{$LL.admin_rebac_info_suffix()}
					<a href="/admin/admin-rebac" class="underline hover:text-blue-900">Admin ReBAC</a>.
				</p>
			</div>
		</div>
	</div>

	<div class="page-header">
		<div>
			<h1 class="page-title">{$LL.admin_rebac_title()}</h1>
			<p class="page-description">
				{$LL.admin_rebac_description()}
			</p>
		</div>
	</div>

	<!-- ReBAC Feature Flag Toggle -->
	<div class="panel feature-toggle-panel">
		<div class="feature-toggle-row">
			<div class="feature-toggle-info">
				<h3 class="feature-toggle-title">{$LL.admin_rebac_engine()}</h3>
				<p class="feature-toggle-description">
					{$LL.admin_rebac_engine_description()}
				</p>
			</div>
			<div class="feature-toggle-control">
				{#if rebacLoading}
					<span class="loading-text">{$LL.admin_rebac_loading()}</span>
				{:else}
					<ToggleSwitch checked={rebacEnabled} disabled={rebacSaving} onchange={toggleRebac} />
				{/if}
			</div>
		</div>
		{#if rebacError}
			<div class="alert alert-error alert-sm">{rebacError}</div>
		{/if}
		{#if rebacSaving}
			<div class="saving-indicator">{$LL.admin_rebac_saving()}</div>
		{/if}
	</div>

	{#if !rebacEnabled && !rebacLoading}
		<div class="alert alert-warning">
			<strong>{$LL.admin_rebac_disabled_title()}</strong>
			{$LL.admin_rebac_disabled_description()}
		</div>
	{/if}

	{#if error}
		<div class="alert alert-error">
			<span>{error}</span>
			<button class="btn btn-secondary btn-sm" onclick={loadObjectTypes}
				>{$LL.admin_rebac_retry()}</button
			>
		</div>
	{/if}

	<div class="rebac-content-grid">
		<!-- Navigation Cards -->
		<div class="section">
			<h2 class="section-title">{$LL.admin_rebac_management()}</h2>
			<div class="nav-cards">
				<a href="/admin/rebac/definitions" class="nav-card">
					<div class="nav-card-icon">
						<i class="i-ph-list-checks"></i>
					</div>
					<div class="nav-card-content">
						<h3>{$LL.admin_rebac_relation_definitions()}</h3>
						<p class="muted">
							{$LL.admin_rebac_relation_definitions_description()}
						</p>
					</div>
					<div class="nav-card-arrow">
						<i class="i-ph-arrow-right"></i>
					</div>
				</a>

				<a href="/admin/rebac/tuples" class="nav-card">
					<div class="nav-card-icon">
						<i class="i-ph-link"></i>
					</div>
					<div class="nav-card-content">
						<h3>{$LL.admin_rebac_relationship_tuples()}</h3>
						<p class="muted">{$LL.admin_rebac_relationship_tuples_description()}</p>
					</div>
					<div class="nav-card-arrow">
						<i class="i-ph-arrow-right"></i>
					</div>
				</a>
			</div>
		</div>

		<!-- Object Types Summary -->
		<div class="section">
			<h2 class="section-title">{$LL.admin_rebac_object_types()}</h2>
			{#if loading}
				<div class="loading-state">
					<i class="i-ph-circle-notch loading-spinner"></i>
					<p>{$LL.admin_rebac_loading()}</p>
				</div>
			{:else if objectTypes.length === 0}
				<div class="panel">
					<div class="empty-state">
						<p class="empty-state-description">{$LL.admin_rebac_no_definitions()}</p>
						<a href="/admin/rebac/definitions" class="btn btn-primary"
							>{$LL.admin_rebac_create_definition()}</a
						>
					</div>
				</div>
			{:else}
				<div class="object-types-grid">
					{#each objectTypes as objType (objType.name)}
						<a href="/admin/rebac/definitions?object_type={objType.name}" class="object-type-card">
							<div class="type-name">{objType.name}</div>
							<div class="type-count muted">
								{$LL.admin_rebac_definitions_count({ count: objType.definition_count })}
							</div>
						</a>
					{/each}
				</div>
			{/if}
		</div>

		<!-- Permission Check Tool -->
		<div class="panel">
			<h2 class="panel-title">{$LL.admin_rebac_permission_check()}</h2>
			<p class="muted">{$LL.admin_rebac_permission_check_description()}</p>

			<div class="check-form">
				<div class="form-group">
					<label for="check-user" class="form-label">{$LL.admin_rebac_user_id()}</label>
					<input
						id="check-user"
						type="text"
						class="form-input"
						bind:value={checkUserId}
						placeholder="user_123"
					/>
				</div>

				<div class="form-group">
					<label for="check-relation" class="form-label">{$LL.admin_rebac_relation()}</label>
					<input
						id="check-relation"
						type="text"
						class="form-input"
						bind:value={checkRelation}
						placeholder="viewer"
					/>
				</div>

				<div class="form-group">
					<label for="check-object" class="form-label">{$LL.admin_rebac_object()}</label>
					<input
						id="check-object"
						type="text"
						class="form-input"
						bind:value={checkObject}
						placeholder="document:doc_456"
					/>
				</div>

				<button class="btn btn-primary" onclick={runPermissionCheck} disabled={checking}>
					{checking ? $LL.admin_rebac_checking() : $LL.admin_rebac_check_permission()}
				</button>
			</div>

			{#if checkError}
				<div class="alert alert-error">{checkError}</div>
			{/if}

			{#if checkResult}
				<div
					class="check-result"
					class:check-result-allowed={checkResult.allowed}
					class:check-result-denied={!checkResult.allowed}
				>
					<div class="result-status">
						<i class={checkResult.allowed ? 'i-ph-check-circle' : 'i-ph-x-circle'}></i>
						<span
							>{checkResult.allowed
								? $LL.admin_rebac_result_allowed()
								: $LL.admin_rebac_result_denied()}</span
						>
					</div>
					{#if checkResult.resolved_via}
						<div class="result-detail">
							<span class="muted">{$LL.admin_rebac_resolved_via_label()}</span>
							<span>{checkResult.resolved_via}</span>
						</div>
					{/if}
					{#if checkResult.path && checkResult.path.length > 0}
						<div class="result-detail">
							<span class="muted">{$LL.admin_rebac_path_label()}</span>
							<span class="mono">{checkResult.path.join(' → ')}</span>
						</div>
					{/if}
				</div>
			{/if}
		</div>
	</div>
</div>

<style>
	/* Feature Toggle Panel Styles */
	.feature-toggle-panel {
		margin-bottom: 1.5rem;
		padding: 1rem 1.25rem;
	}

	.feature-toggle-row {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 1rem;
	}

	.feature-toggle-info {
		flex: 1;
	}

	.feature-toggle-title {
		margin: 0;
		font-size: 1rem;
		font-weight: 600;
		color: var(--text-primary);
	}

	.feature-toggle-description {
		margin: 0.25rem 0 0;
		font-size: 0.875rem;
		color: var(--text-secondary);
	}

	.feature-toggle-control {
		display: flex;
		align-items: center;
		gap: 0.75rem;
	}

	.loading-text {
		font-size: 0.875rem;
		color: var(--text-secondary);
	}

	.saving-indicator {
		margin-top: 0.5rem;
		font-size: 0.75rem;
		color: var(--text-secondary);
	}

	.alert-sm {
		margin-top: 0.75rem;
		padding: 0.5rem 0.75rem;
		font-size: 0.875rem;
	}

	.alert-warning {
		background-color: rgba(234, 179, 8, 0.1);
		border: 1px solid rgba(234, 179, 8, 0.3);
		border-radius: 0.375rem;
		padding: 0.75rem 1rem;
		color: var(--text-primary);
		margin-bottom: 1rem;
	}
</style>
