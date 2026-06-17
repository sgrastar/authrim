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
	import { AdminPageHeader, AdminPageShell, AdminSection } from '$lib/components/admin';
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

<AdminPageShell>
	<div class="info-callout">
		<i class="i-ph-info"></i>
		<div>
			<h2>{$LL.admin_rebac_info_title()}</h2>
			<p>
				{$LL.admin_rebac_info_prefix()}<strong>End Users</strong
				>{$LL.admin_rebac_info_middle()}<strong>Admin Operator</strong
				>{$LL.admin_rebac_info_suffix()}
				<a href="/admin/admin-rebac">Admin ReBAC</a>.
			</p>
		</div>
	</div>

	<AdminPageHeader title={$LL.admin_rebac_title()} description={$LL.admin_rebac_description()} />

	<!-- ReBAC Feature Flag Toggle -->
	<AdminSection>
		<div class="feature-toggle-panel">
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
	</AdminSection>

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
		<AdminSection title={$LL.admin_rebac_management()}>
			<div class="admin-link-grid">
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
		</AdminSection>

		<AdminSection title={$LL.admin_rebac_object_types()}>
			{#if loading}
				<div class="loading-state">
					<i class="i-ph-circle-notch loading-spinner"></i>
					<p>{$LL.admin_rebac_loading()}</p>
				</div>
			{:else if objectTypes.length === 0}
				<div class="empty-state">
					<p class="empty-state-description">{$LL.admin_rebac_no_definitions()}</p>
					<a href="/admin/rebac/definitions" class="btn btn-primary">
						{$LL.admin_rebac_create_definition()}
					</a>
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
		</AdminSection>

		<AdminSection
			title={$LL.admin_rebac_permission_check()}
			description={$LL.admin_rebac_permission_check_description()}
		>
			<div class="check-form">
				<div class="admin-field">
					<label for="check-user" class="admin-field__label">{$LL.admin_rebac_user_id()}</label>
					<input
						id="check-user"
						type="text"
						class="admin-input"
						bind:value={checkUserId}
						placeholder="user_123"
					/>
				</div>

				<div class="admin-field">
					<label for="check-relation" class="admin-field__label">{$LL.admin_rebac_relation()}</label
					>
					<input
						id="check-relation"
						type="text"
						class="admin-input"
						bind:value={checkRelation}
						placeholder="viewer"
					/>
				</div>

				<div class="admin-field">
					<label for="check-object" class="admin-field__label">{$LL.admin_rebac_object()}</label>
					<input
						id="check-object"
						type="text"
						class="admin-input"
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
		</AdminSection>
	</div>
</AdminPageShell>

<style>
	.info-callout {
		display: flex;
		align-items: flex-start;
		gap: 0.875rem;
		border: 1px solid color-mix(in srgb, var(--color-info) 24%, var(--color-border));
		border-radius: var(--radius-panel);
		background: color-mix(in srgb, var(--color-info) 8%, var(--color-surface));
		padding: 1rem;
		color: var(--color-text);
	}

	.info-callout > i {
		color: var(--color-info);
		font-size: 1.25rem;
		line-height: 1;
		margin-top: 0.1rem;
	}

	.info-callout h2 {
		margin: 0 0 0.25rem;
		font-size: 0.95rem;
		font-weight: 700;
	}

	.info-callout p {
		margin: 0;
		color: var(--color-text-muted);
		font-size: 0.875rem;
		line-height: 1.55;
	}

	.info-callout a {
		color: var(--color-accent);
		font-weight: 700;
		text-decoration: none;
	}

	.feature-toggle-panel {
		border: 1px solid var(--color-border);
		border-radius: var(--radius-panel);
		background: var(--color-surface);
		padding: 1rem;
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
		color: var(--color-text);
	}

	.feature-toggle-description {
		margin: 0.25rem 0 0;
		font-size: 0.875rem;
		color: var(--color-text-muted);
	}

	.feature-toggle-control {
		display: flex;
		align-items: center;
		gap: 0.75rem;
	}

	.loading-text {
		font-size: 0.875rem;
		color: var(--color-text-muted);
	}

	.saving-indicator {
		margin-top: 0.5rem;
		font-size: 0.75rem;
		color: var(--color-text-muted);
	}

	.alert-sm {
		margin-top: 0.75rem;
		padding: 0.5rem 0.75rem;
		font-size: 0.875rem;
	}

	.alert-warning {
		background: color-mix(in srgb, var(--color-warning) 10%, var(--color-surface));
		border: 1px solid color-mix(in srgb, var(--color-warning) 28%, var(--color-border));
		border-radius: var(--radius-md);
		padding: 0.75rem 1rem;
		color: var(--color-text);
		margin-bottom: 1rem;
	}

	.rebac-content-grid {
		display: grid;
		gap: 1.25rem;
	}

	.admin-link-grid,
	.object-types-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
		gap: 0.875rem;
	}

	.nav-card,
	.object-type-card {
		display: flex;
		align-items: center;
		gap: 0.875rem;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-panel);
		background: var(--color-surface);
		color: inherit;
		padding: 1rem;
		text-decoration: none;
		transition:
			background var(--transition-fast),
			border-color var(--transition-fast),
			transform var(--transition-fast);
	}

	.nav-card:hover,
	.object-type-card:hover {
		border-color: color-mix(in srgb, var(--color-accent) 34%, var(--color-border));
		background: color-mix(in srgb, var(--color-accent) 5%, var(--color-surface));
		transform: translateY(-1px);
	}

	.nav-card-icon {
		display: grid;
		place-items: center;
		width: 2.25rem;
		height: 2.25rem;
		border-radius: var(--radius-md);
		background: color-mix(in srgb, var(--color-accent) 12%, transparent);
		color: var(--color-accent);
		font-size: 1.2rem;
		flex: 0 0 auto;
	}

	.nav-card-content {
		min-width: 0;
		flex: 1;
	}

	.nav-card-content h3,
	.type-name {
		margin: 0;
		color: var(--color-text);
		font-size: 0.95rem;
		font-weight: 700;
	}

	.nav-card-content p {
		margin: 0.25rem 0 0;
	}

	.nav-card-arrow {
		color: var(--color-text-subtle);
		flex: 0 0 auto;
	}

	.object-type-card {
		align-items: flex-start;
		flex-direction: column;
		gap: 0.35rem;
	}

	.type-count,
	.muted {
		color: var(--color-text-muted);
		font-size: 0.875rem;
	}

	.check-form {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
		align-items: end;
		gap: 0.875rem;
	}

	.admin-field {
		display: grid;
		gap: 0.35rem;
	}

	.admin-field__label {
		color: var(--color-text-subtle);
		font-family: var(--font-meta, var(--font-body));
		font-size: 0.68rem;
		font-weight: 700;
		letter-spacing: 0.16em;
		text-transform: uppercase;
	}

	.admin-input {
		width: 100%;
		min-height: var(--control-height, 38px);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-control);
		background: var(--control-bg, var(--color-surface));
		color: var(--color-text);
		font: inherit;
		padding: var(--control-padding, 8px 12px);
		outline: none;
	}

	.admin-input:focus {
		border-color: var(--color-accent);
		box-shadow: 0 0 0 3px var(--color-accent-muted);
	}

	.check-result {
		margin-top: 1rem;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		background: var(--color-surface-subtle);
		padding: 1rem;
	}

	.check-result-allowed {
		border-left: 3px solid var(--color-success);
	}

	.check-result-denied {
		border-left: 3px solid var(--color-danger);
	}

	.result-status {
		display: flex;
		align-items: center;
		gap: 0.45rem;
		color: var(--color-text);
		font-weight: 700;
	}

	.result-detail {
		display: grid;
		gap: 0.2rem;
		margin-top: 0.75rem;
		color: var(--color-text);
	}

	@media (max-width: 720px) {
		.feature-toggle-row,
		.info-callout {
			flex-direction: column;
		}
	}
</style>
