<script lang="ts">
	import { onMount } from 'svelte';
	import { settingsContext } from '$lib/stores/settings-context.svelte';
	import {
		adminCacheModeAPI,
		type CacheMode,
		type PlatformCacheModeResponse,
		type CacheModeInfoResponse
	} from '$lib/api/admin-cache-mode';
	import Alert from '$lib/components/Alert.svelte';
	import { AdminDataTable } from '$lib/components/admin';
	import AdminPageHeader from '$lib/components/admin/AdminPageHeader.svelte';
	import AdminPageShell from '$lib/components/admin/AdminPageShell.svelte';

	// State
	let platformMode = $state<PlatformCacheModeResponse | null>(null);
	let modeInfo = $state<CacheModeInfoResponse | null>(null);
	let loading = $state(true);
	let saving = $state(false);
	let error = $state('');
	let successMessage = $state('');
	let selectedMode = $state<CacheMode>('fixed');

	// Check if currently in maintenance mode
	const isMaintenanceMode = $derived(platformMode?.effective === 'maintenance');

	onMount(async () => {
		await settingsContext.initialize();
		await loadData();
	});

	async function loadData() {
		loading = true;
		error = '';
		try {
			const [modeResult, infoResult] = await Promise.all([
				adminCacheModeAPI.getPlatformCacheMode(),
				adminCacheModeAPI.getCacheModeInfo()
			]);
			platformMode = modeResult;
			modeInfo = infoResult;
			selectedMode = modeResult.effective;
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to load cache mode settings';
		} finally {
			loading = false;
		}
	}

	async function saveCacheMode() {
		if (!platformMode || selectedMode === platformMode.effective) return;

		saving = true;
		error = '';
		successMessage = '';

		try {
			await adminCacheModeAPI.setPlatformCacheMode(selectedMode);
			successMessage = `Cache mode changed to ${selectedMode}`;
			await loadData();
			setTimeout(() => {
				successMessage = '';
			}, 5000);
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to save cache mode';
		} finally {
			saving = false;
		}
	}

	function formatTTL(seconds: number): string {
		if (seconds < 60) return `${seconds}s`;
		if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
		if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
		return `${Math.floor(seconds / 86400)}d`;
	}
</script>

<svelte:head>
	<title>Cache Mode Settings - Admin Dashboard - Authrim</title>
</svelte:head>

{#snippet headerActions()}
	<a href="/admin/settings" class="back-link">
		<i class="i-ph-arrow-left"></i>
		Back to Settings
	</a>
{/snippet}

<AdminPageShell>
	<div class="cache-mode-page">
		<AdminPageHeader
			title="Cache Mode Settings"
			description="Configure caching behavior for client metadata and related data. Maintenance mode uses shorter TTLs for development and testing."
			actions={headerActions}
		/>

		<!-- Warning banner for maintenance mode -->
		{#if isMaintenanceMode && !loading}
			<Alert variant="warning" title="Maintenance Mode Active">
				Cache TTL is set to 30 seconds. This may impact performance in production environments.
				Consider switching to Fixed mode for production use.
			</Alert>
		{/if}

		<!-- Success/Error messages -->
		{#if successMessage}
			<Alert variant="success" dismissible onDismiss={() => (successMessage = '')}>
				{successMessage}
			</Alert>
		{/if}

		{#if error}
			<Alert variant="error" dismissible onDismiss={() => (error = '')}>
				{error}
			</Alert>
		{/if}

		{#if loading}
			<div class="loading-state">
				<i class="i-ph-circle-notch animate-spin"></i>
				<p>Loading cache settings...</p>
			</div>
		{:else if platformMode && modeInfo}
			<!-- Current Status Card -->
			<div class="status-card">
				<div class="status-header">
					<div class="status-icon" class:maintenance={isMaintenanceMode}>
						<i class={isMaintenanceMode ? 'i-ph-wrench' : 'i-ph-database'}></i>
					</div>
					<div class="status-info">
						<h2>Current Mode: <span class="mode-name">{platformMode.effective}</span></h2>
						<p class="status-description">
							{#if platformMode.mode === null}
								Using default mode (no custom setting)
							{:else}
								Custom mode set via Admin API
							{/if}
						</p>
					</div>
				</div>
			</div>

			<!-- Mode Selection -->
			<div class="mode-selection-card">
				<h3 class="card-section-title">Select Cache Mode</h3>

				<div class="mode-options">
					<!-- Maintenance Mode -->
					<label class="mode-option" class:selected={selectedMode === 'maintenance'}>
						<input
							type="radio"
							name="cacheMode"
							value="maintenance"
							bind:group={selectedMode}
							disabled={saving}
						/>
						<div class="mode-option-content">
							<div class="mode-option-header">
								<div class="mode-option-icon maintenance">
									<i class="i-ph-wrench"></i>
								</div>
								<div>
									<h4>Maintenance Mode</h4>
									<span class="mode-badge maintenance">Development / Testing</span>
								</div>
							</div>
							<p class="mode-option-description">
								{modeInfo.modes.maintenance.description}
							</p>
							<div class="mode-use-cases">
								<strong>Use cases:</strong>
								<ul>
									{#each modeInfo.modes.maintenance.use_cases as useCase (useCase)}
										<li>{useCase}</li>
									{/each}
								</ul>
							</div>
						</div>
					</label>

					<!-- Fixed Mode -->
					<label class="mode-option" class:selected={selectedMode === 'fixed'}>
						<input
							type="radio"
							name="cacheMode"
							value="fixed"
							bind:group={selectedMode}
							disabled={saving}
						/>
						<div class="mode-option-content">
							<div class="mode-option-header">
								<div class="mode-option-icon mode-option-icon--fixed">
									<i class="i-ph-database"></i>
								</div>
								<div>
									<h4>Fixed Mode</h4>
									<span class="mode-badge mode-badge--fixed">Production</span>
								</div>
							</div>
							<p class="mode-option-description">
								{modeInfo.modes.fixed.description}
							</p>
							<div class="mode-use-cases">
								<strong>Use cases:</strong>
								<ul>
									{#each modeInfo.modes.fixed.use_cases as useCase (useCase)}
										<li>{useCase}</li>
									{/each}
								</ul>
							</div>
						</div>
					</label>
				</div>

				<!-- Save Button -->
				<div class="save-section">
					<button
						class="btn btn-primary"
						onclick={saveCacheMode}
						disabled={saving || selectedMode === platformMode.effective}
					>
						{#if saving}
							<i class="i-ph-circle-notch animate-spin"></i>
							Saving...
						{:else}
							<i class="i-ph-floppy-disk"></i>
							Save Changes
						{/if}
					</button>
					{#if selectedMode !== platformMode.effective}
						<span class="unsaved-indicator">Unsaved changes</span>
					{/if}
				</div>
			</div>

			<!-- TTL Comparison Table -->
			<div class="ttl-comparison-card">
				<h3 class="card-section-title">TTL Configuration Comparison</h3>
				<p class="card-section-description">
					Cache TTL (Time To Live) values for each data type in different modes.
				</p>

				<AdminDataTable>
					<thead>
						<tr>
							<th>Data Type</th>
							<th class="mode-header maintenance">
								<i class="i-ph-wrench"></i>
								Maintenance
							</th>
							<th class="mode-header mode-header--fixed">
								<i class="i-ph-database"></i>
								Fixed
							</th>
						</tr>
					</thead>
					<tbody>
						<tr>
							<td>
								<div class="data-type">
									<span class="data-type-name">Client Metadata</span>
									<span class="data-type-desc">Basic client info</span>
								</div>
							</td>
							<td class="ttl-value"
								>{formatTTL(modeInfo.modes.maintenance.ttl_config.clientMetadata)}</td
							>
							<td class="ttl-value">{formatTTL(modeInfo.modes.fixed.ttl_config.clientMetadata)}</td>
						</tr>
						<tr>
							<td>
								<div class="data-type">
									<span class="data-type-name">Redirect URIs</span>
									<span class="data-type-desc">OAuth callback URLs</span>
								</div>
							</td>
							<td class="ttl-value"
								>{formatTTL(modeInfo.modes.maintenance.ttl_config.redirectUris)}</td
							>
							<td class="ttl-value">{formatTTL(modeInfo.modes.fixed.ttl_config.redirectUris)}</td>
						</tr>
						<tr>
							<td>
								<div class="data-type">
									<span class="data-type-name">Grant Types</span>
									<span class="data-type-desc">Allowed OAuth flows</span>
								</div>
							</td>
							<td class="ttl-value"
								>{formatTTL(modeInfo.modes.maintenance.ttl_config.grantTypes)}</td
							>
							<td class="ttl-value">{formatTTL(modeInfo.modes.fixed.ttl_config.grantTypes)}</td>
						</tr>
						<tr>
							<td>
								<div class="data-type">
									<span class="data-type-name">Scopes</span>
									<span class="data-type-desc">Permission definitions</span>
								</div>
							</td>
							<td class="ttl-value">{formatTTL(modeInfo.modes.maintenance.ttl_config.scopes)}</td>
							<td class="ttl-value">{formatTTL(modeInfo.modes.fixed.ttl_config.scopes)}</td>
						</tr>
						<tr>
							<td>
								<div class="data-type">
									<span class="data-type-name">JWKS</span>
									<span class="data-type-desc">Client signing keys</span>
								</div>
							</td>
							<td class="ttl-value">{formatTTL(modeInfo.modes.maintenance.ttl_config.jwks)}</td>
							<td class="ttl-value">{formatTTL(modeInfo.modes.fixed.ttl_config.jwks)}</td>
						</tr>
						<tr>
							<td>
								<div class="data-type">
									<span class="data-type-name">Client Secret</span>
									<span class="data-type-desc">Authentication credentials</span>
								</div>
							</td>
							<td class="ttl-value"
								>{formatTTL(modeInfo.modes.maintenance.ttl_config.clientSecret)}</td
							>
							<td class="ttl-value">{formatTTL(modeInfo.modes.fixed.ttl_config.clientSecret)}</td>
						</tr>
						<tr>
							<td>
								<div class="data-type">
									<span class="data-type-name">Tenant</span>
									<span class="data-type-desc">Tenant configuration</span>
								</div>
							</td>
							<td class="ttl-value">{formatTTL(modeInfo.modes.maintenance.ttl_config.tenant)}</td>
							<td class="ttl-value">{formatTTL(modeInfo.modes.fixed.ttl_config.tenant)}</td>
						</tr>
						<tr>
							<td>
								<div class="data-type">
									<span class="data-type-name">Policy</span>
									<span class="data-type-desc">RBAC/ABAC rules</span>
								</div>
							</td>
							<td class="ttl-value">{formatTTL(modeInfo.modes.maintenance.ttl_config.policy)}</td>
							<td class="ttl-value">{formatTTL(modeInfo.modes.fixed.ttl_config.policy)}</td>
						</tr>
					</tbody>
				</AdminDataTable>
			</div>

			<!-- Info box -->
			<div class="info-box">
				<div class="info-box-icon">
					<i class="i-ph-info"></i>
				</div>
				<div class="info-box-content">
					<h4>About Cache Modes</h4>
					<p>{modeInfo.hierarchy.description}</p>
					<p class="info-box-note">
						<strong>Evaluation order:</strong>
						{modeInfo.hierarchy.order.join(' → ')}
					</p>
					<p class="info-box-note">
						<strong>KV Key Version:</strong>
						{modeInfo.kv_key_version}
					</p>
				</div>
			</div>
		{/if}
	</div>
</AdminPageShell>

<style>
	.cache-mode-page {
		max-width: 900px;
	}

	.back-link {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		min-height: var(--control-height, 36px);
		padding: var(--button-padding, 8px 14px);
		border: 1px solid var(--control-border, var(--color-border));
		border-radius: var(--control-radius, var(--radius-control));
		background: var(--color-surface-muted);
		color: var(--color-text-muted);
		text-decoration: none;
		font-size: 0.875rem;
		font-weight: 600;
		transition: color var(--transition-fast);
	}

	.back-link:hover {
		color: var(--color-accent);
	}

	.back-link :global(i) {
		width: 16px;
		height: 16px;
	}

	/* Loading State */
	.loading-state {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		padding: 64px;
		color: var(--color-text-subtle);
		gap: 16px;
	}

	.loading-state :global(i) {
		width: 32px;
		height: 32px;
		color: var(--color-accent);
	}

	/* Status Card */
	.status-card {
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-panel, var(--radius-xl));
		padding: 24px;
		margin-bottom: 24px;
	}

	.status-header {
		display: flex;
		align-items: center;
		gap: 16px;
	}

	.status-icon {
		width: 56px;
		height: 56px;
		background: var(--color-accent-muted);
		border-radius: var(--radius-control, var(--radius-lg));
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
	}

	.status-icon.maintenance {
		background: color-mix(in srgb, var(--color-warning) 14%, transparent);
	}

	.status-icon :global(i) {
		width: 28px;
		height: 28px;
		color: var(--color-accent);
	}

	.status-icon.maintenance :global(i) {
		color: var(--color-warning);
	}

	.status-info h2 {
		font-size: 1.25rem;
		font-weight: 600;
		color: var(--color-text);
		margin: 0 0 4px 0;
	}

	.mode-name {
		text-transform: capitalize;
		color: var(--color-accent);
	}

	.status-description {
		color: var(--color-text-subtle);
		font-size: 0.875rem;
		margin: 0;
	}

	/* Mode Selection Card */
	.mode-selection-card {
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-panel, var(--radius-xl));
		padding: 24px;
		margin-bottom: 24px;
	}

	.card-section-title {
		font-size: 1.125rem;
		font-weight: 600;
		color: var(--color-text);
		margin: 0 0 16px 0;
	}

	.card-section-description {
		color: var(--color-text-muted);
		font-size: 0.875rem;
		margin: 0 0 20px 0;
	}

	.mode-options {
		display: flex;
		flex-direction: column;
		gap: 16px;
	}

	.mode-option {
		display: flex;
		border: 2px solid var(--color-border);
		border-radius: var(--radius-control, var(--radius-lg));
		padding: 20px;
		cursor: pointer;
		transition: all var(--transition-fast);
	}

	.mode-option:hover {
		border-color: var(--color-accent);
		background: color-mix(in srgb, var(--color-accent) 7%, var(--color-surface));
	}

	.mode-option.selected {
		border-color: var(--color-accent);
		background: var(--color-accent-muted);
	}

	.mode-option input[type='radio'] {
		display: none;
	}

	.mode-option-content {
		flex: 1;
	}

	.mode-option-header {
		display: flex;
		align-items: center;
		gap: 12px;
		margin-bottom: 12px;
	}

	.mode-option-icon {
		width: 44px;
		height: 44px;
		background: var(--color-surface-muted);
		border-radius: var(--radius-control, var(--radius-md));
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
	}

	.mode-option-icon.maintenance {
		background: color-mix(in srgb, var(--color-warning) 14%, transparent);
	}

	.mode-option-icon--fixed {
		background: color-mix(in srgb, var(--color-success) 14%, transparent);
	}

	.mode-option-icon :global(i) {
		width: 22px;
		height: 22px;
	}

	.mode-option-icon.maintenance :global(i) {
		color: var(--color-warning);
	}

	.mode-option-icon--fixed :global(i) {
		color: var(--color-success);
	}

	.mode-option-header h4 {
		font-size: 1rem;
		font-weight: 600;
		color: var(--color-text);
		margin: 0 0 4px 0;
	}

	.mode-badge {
		display: inline-block;
		padding: 2px 8px;
		border-radius: var(--radius-control, var(--radius-sm));
		font-size: 0.75rem;
		font-weight: 500;
	}

	.mode-badge.maintenance {
		background: color-mix(in srgb, var(--color-warning) 14%, transparent);
		color: var(--color-warning);
	}

	.mode-badge--fixed {
		background: color-mix(in srgb, var(--color-success) 14%, transparent);
		color: var(--color-success);
	}

	.mode-option-description {
		color: var(--color-text-muted);
		font-size: 0.875rem;
		margin: 0 0 12px 0;
		line-height: 1.5;
	}

	.mode-use-cases {
		font-size: 0.8125rem;
		color: var(--color-text-subtle);
	}

	.mode-use-cases strong {
		color: var(--color-text-muted);
	}

	.mode-use-cases ul {
		margin: 4px 0 0 0;
		padding-left: 20px;
	}

	.mode-use-cases li {
		margin-bottom: 2px;
	}

	/* Save Section */
	.save-section {
		display: flex;
		align-items: center;
		gap: 16px;
		margin-top: 24px;
		padding-top: 24px;
		border-top: 1px solid var(--color-border);
	}

	.btn {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		padding: 12px 24px;
		border-radius: var(--radius-control, var(--radius-lg));
		font-size: 0.9375rem;
		font-weight: 600;
		cursor: pointer;
		transition: all var(--transition-fast);
		border: none;
	}

	.btn :global(i) {
		width: 18px;
		height: 18px;
	}

	.btn-primary {
		background: var(--button-primary-bg, var(--color-accent));
		color: var(--button-primary-color, var(--color-accent-contrast));
	}

	.btn-primary:hover:not(:disabled) {
		background: var(
			--button-primary-hover-bg,
			color-mix(in srgb, var(--color-accent) 88%, var(--color-text))
		);
		transform: translateY(-1px);
	}

	.btn-primary:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.unsaved-indicator {
		color: var(--color-warning);
		font-size: 0.875rem;
		font-weight: 500;
	}

	/* TTL Comparison Card */
	.ttl-comparison-card {
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-panel, var(--radius-xl));
		padding: 24px;
		margin-bottom: 24px;
	}

	.mode-header {
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.mode-header :global(i) {
		width: 14px;
		height: 14px;
	}

	.mode-header.maintenance :global(i) {
		color: var(--color-warning);
	}

	.mode-header--fixed :global(i) {
		color: var(--color-success);
	}

	.data-type {
		display: flex;
		flex-direction: column;
	}

	.data-type-name {
		font-weight: 500;
		color: var(--color-text);
		font-size: 0.9375rem;
	}

	.data-type-desc {
		color: var(--color-text-subtle);
		font-size: 0.75rem;
	}

	.ttl-value {
		font-family: var(--font-mono, monospace);
		font-size: 0.875rem;
		color: var(--color-text);
		font-weight: 500;
	}

	/* Info Box */
	.info-box {
		display: flex;
		gap: 16px;
		background: var(--color-accent-muted);
		border: 1px solid color-mix(in srgb, var(--color-accent) 28%, var(--color-border));
		border-radius: var(--radius-panel, var(--radius-lg));
		padding: 20px;
	}

	.info-box-icon {
		width: 40px;
		height: 40px;
		background: var(--color-accent);
		border-radius: var(--radius-control, var(--radius-md));
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
	}

	.info-box-icon :global(i) {
		width: 20px;
		height: 20px;
		color: var(--color-accent-contrast);
	}

	.info-box-content h4 {
		font-size: 1rem;
		font-weight: 600;
		color: var(--color-text);
		margin: 0 0 8px 0;
	}

	.info-box-content p {
		color: var(--color-text-muted);
		font-size: 0.875rem;
		margin: 0;
		line-height: 1.5;
	}

	.info-box-note {
		margin-top: 8px !important;
		font-size: 0.8125rem !important;
		color: var(--color-text-subtle) !important;
	}

	/* Responsive */
	@media (max-width: 640px) {
		.status-header {
			flex-direction: column;
			align-items: flex-start;
			text-align: left;
		}

		.mode-option-header {
			flex-direction: column;
			align-items: flex-start;
		}

		.info-box {
			flex-direction: column;
		}
	}
</style>
