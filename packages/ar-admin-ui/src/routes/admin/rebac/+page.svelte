<script lang="ts">
	import { onMount } from 'svelte';
	import {
		adminReBACAPI,
		type ObjectTypeSummary,
		type PermissionCheckResult
	} from '$lib/api/admin-rebac';
	import { adminSettingsAPI } from '$lib/api/admin-settings';
	import { ToggleSwitch } from '$lib/components';

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

	async function loadObjectTypes() {
		loading = true;
		error = '';

		try {
			const response = await adminReBACAPI.listObjectTypes();
			objectTypes = response.object_types;
		} catch (err) {
			console.error('Failed to load object types:', err);
			error = err instanceof Error ? err.message : 'Failed to load object types';
		} finally {
			loading = false;
		}
	}

	async function runPermissionCheck() {
		if (!checkUserId || !checkRelation || !checkObject) {
			checkError = 'All fields are required';
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
			console.error('Failed to check permission:', err);
			checkError = err instanceof Error ? err.message : 'Failed to check permission';
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
			console.error('Failed to load ReBAC status:', err);
			rebacError = 'Failed to load ReBAC status';
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
			featureFlagsVersion = result.newVersion;
		} catch (err) {
			console.error('Failed to update ReBAC status:', err);
			rebacError = err instanceof Error ? err.message : 'Failed to update ReBAC status';
			await loadRebacStatus();
		} finally {
			rebacSaving = false;
		}
	}

	onMount(() => {
		loadRebacStatus();
		loadObjectTypes();
	});
</script>

<svelte:head>
	<title>Relationship-Based Access Control - Admin Dashboard - Authrim</title>
</svelte:head>

<div class="admin-page">
	<div class="page-header">
		<div>
			<h1 class="page-title">Relationship-Based Access Control</h1>
			<p class="page-description">
				Manage relation definitions and relationship tuples using Zanzibar-style access control.
			</p>
		</div>
	</div>

	<!-- ReBAC Feature Flag Toggle -->
	<div class="panel feature-toggle-panel">
		<div class="feature-toggle-row">
			<div class="feature-toggle-info">
				<h3 class="feature-toggle-title">ReBAC Engine</h3>
				<p class="feature-toggle-description">
					Enable Relationship-Based Access Control. When enabled, permission checks will evaluate
					relationship tuples.
				</p>
			</div>
			<div class="feature-toggle-control">
				{#if rebacLoading}
					<span class="loading-text">Loading...</span>
				{:else}
					<ToggleSwitch checked={rebacEnabled} disabled={rebacSaving} onchange={toggleRebac} />
				{/if}
			</div>
		</div>
		{#if rebacError}
			<div class="alert alert-error alert-sm">{rebacError}</div>
		{/if}
		{#if rebacSaving}
			<div class="saving-indicator">Saving...</div>
		{/if}
	</div>

	{#if !rebacEnabled && !rebacLoading}
		<div class="alert alert-warning">
			<strong>ReBAC is disabled.</strong> Enable it above to use relationship-based permission checks.
			When disabled, relationship tuples will not be evaluated.
		</div>
	{/if}

	{#if error}
		<div class="alert alert-error">
			<span>{error}</span>
			<button class="btn btn-secondary btn-sm" onclick={loadObjectTypes}>Retry</button>
		</div>
	{/if}

	<div class="rebac-content-grid">
		<!-- Navigation Cards -->
		<div class="section">
			<h2 class="section-title">Management</h2>
			<div class="nav-cards">
				<a href="/admin/rebac/definitions" class="nav-card">
					<div class="nav-card-icon">
						<i class="i-ph-list-checks"></i>
					</div>
					<div class="nav-card-content">
						<h3>Relation Definitions</h3>
						<p class="muted">
							Configure how relations are computed (union, intersection, inheritance)
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
						<h3>Relationship Tuples</h3>
						<p class="muted">Manage user-relation-object assignments</p>
					</div>
					<div class="nav-card-arrow">
						<i class="i-ph-arrow-right"></i>
					</div>
				</a>
			</div>
		</div>

		<!-- Object Types Summary -->
		<div class="section">
			<h2 class="section-title">Object Types</h2>
			{#if loading}
				<div class="loading-state">
					<i class="i-ph-circle-notch loading-spinner"></i>
					<p>Loading...</p>
				</div>
			{:else if objectTypes.length === 0}
				<div class="panel">
					<div class="empty-state">
						<p class="empty-state-description">No relation definitions configured yet.</p>
						<a href="/admin/rebac/definitions" class="btn btn-primary">Create Definition</a>
					</div>
				</div>
			{:else}
				<div class="object-types-grid">
					{#each objectTypes as objType (objType.name)}
						<a href="/admin/rebac/definitions?object_type={objType.name}" class="object-type-card">
							<div class="type-name">{objType.name}</div>
							<div class="type-count muted">{objType.definition_count} definitions</div>
						</a>
					{/each}
				</div>
			{/if}
		</div>

		<!-- Permission Check Tool -->
		<div class="panel">
			<h2 class="panel-title">Permission Check</h2>
			<p class="muted">Test if a user has a specific relation to an object.</p>

			<div class="check-form">
				<div class="form-group">
					<label for="check-user" class="form-label">User ID</label>
					<input
						id="check-user"
						type="text"
						class="form-input"
						bind:value={checkUserId}
						placeholder="user_123"
					/>
				</div>

				<div class="form-group">
					<label for="check-relation" class="form-label">Relation</label>
					<input
						id="check-relation"
						type="text"
						class="form-input"
						bind:value={checkRelation}
						placeholder="viewer"
					/>
				</div>

				<div class="form-group">
					<label for="check-object" class="form-label">Object</label>
					<input
						id="check-object"
						type="text"
						class="form-input"
						bind:value={checkObject}
						placeholder="document:doc_456"
					/>
				</div>

				<button class="btn btn-primary" onclick={runPermissionCheck} disabled={checking}>
					{checking ? 'Checking...' : 'Check Permission'}
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
						<span>{checkResult.allowed ? 'ALLOWED' : 'DENIED'}</span>
					</div>
					{#if checkResult.resolved_via}
						<div class="result-detail">
							<span class="muted">Resolved via:</span>
							<span>{checkResult.resolved_via}</span>
						</div>
					{/if}
					{#if checkResult.path && checkResult.path.length > 0}
						<div class="result-detail">
							<span class="muted">Path:</span>
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
