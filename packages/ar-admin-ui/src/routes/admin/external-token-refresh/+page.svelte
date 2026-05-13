<script lang="ts">
	import { onMount } from 'svelte';
	import {
		adminExternalTokenRefreshAPI,
		type ExternalTokenRefreshConfig,
		type ExternalTokenRefreshRunSummary
	} from '$lib/api/admin-external-token-refresh';

	let config: ExternalTokenRefreshConfig = $state({
		enabled: true,
		refreshThresholdSeconds: 3600,
		batchSize: 100,
		scheduledTenantBatchSize: 100
	});
	let runs: ExternalTokenRefreshRunSummary[] = $state([]);
	let loading = $state(true);
	let saving = $state(false);
	let running = $state(false);
	let error = $state('');
	let success = $state('');

	onMount(() => {
		void load();
	});

	async function load() {
		loading = true;
		error = '';
		success = '';

		try {
			const [configResponse, runsResponse] = await Promise.all([
				adminExternalTokenRefreshAPI.getConfig(),
				adminExternalTokenRefreshAPI.listRuns()
			]);
			config = configResponse.config;
			runs = runsResponse.runs;
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to load token refresh settings';
		} finally {
			loading = false;
		}
	}

	async function saveConfig() {
		saving = true;
		error = '';
		success = '';

		try {
			const response = await adminExternalTokenRefreshAPI.updateConfig(config);
			config = response.config;
			success = 'Token refresh settings saved.';
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to save token refresh settings';
		} finally {
			saving = false;
		}
	}

	async function runNow() {
		running = true;
		error = '';
		success = '';

		try {
			const result = await adminExternalTokenRefreshAPI.runCurrentTenant();
			success = `Manual refresh ${result.status}; ${result.tokensRefreshed} token(s) refreshed.`;
			const runsResponse = await adminExternalTokenRefreshAPI.listRuns();
			runs = runsResponse.runs;
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to run token refresh';
		} finally {
			running = false;
		}
	}

	function formatDate(value: number | null): string {
		if (!value) return '-';
		return new Date(value).toLocaleString();
	}

	function formatDuration(run: ExternalTokenRefreshRunSummary): string {
		if (!run.completed_at) return '-';
		const seconds = Math.max(0, Math.round((run.completed_at - run.started_at) / 1000));
		return `${seconds}s`;
	}

	function statusClass(status: ExternalTokenRefreshRunSummary['status']): string {
		if (status === 'completed') return 'badge badge-success';
		if (status === 'partial_failure') return 'badge badge-warning';
		if (status === 'failed') return 'badge badge-error';
		return 'badge badge-neutral';
	}
</script>

<svelte:head>
	<title>External Token Refresh - Admin Dashboard - Authrim</title>
</svelte:head>

<div class="admin-page">
	<div class="page-header">
		<div>
			<h1 class="page-title">External Token Refresh</h1>
			<p class="page-description">
				Refresh external IdP tokens for linked identities and review recent run history.
			</p>
		</div>
		<div class="page-actions">
			<button class="btn btn-secondary" onclick={load} disabled={loading || saving || running}>
				<i class="i-ph-arrow-clockwise"></i>
				Refresh
			</button>
			<button class="btn btn-primary" onclick={runNow} disabled={loading || saving || running}>
				<i class="i-ph-play"></i>
				{running ? 'Running...' : 'Run Current Tenant'}
			</button>
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
			<i class="i-ph-circle-notch loading-spinner"></i>
			<p>Loading...</p>
		</div>
	{:else}
		<div class="panel">
			<div class="panel-header">
				<h2>Settings</h2>
			</div>
			<div class="settings-grid">
				<label class="toggle-row">
					<input type="checkbox" bind:checked={config.enabled} />
					<span>Enable scheduled refresh</span>
				</label>

				<label class="form-field">
					<span>Refresh threshold seconds</span>
					<input
						type="number"
						min="1"
						bind:value={config.refreshThresholdSeconds}
						class="form-input"
					/>
				</label>

				<label class="form-field">
					<span>Token batch size</span>
					<input type="number" min="1" max="1000" bind:value={config.batchSize} class="form-input" />
				</label>

				<label class="form-field">
					<span>Scheduled tenant batch size</span>
					<input
						type="number"
						min="1"
						max="100"
						bind:value={config.scheduledTenantBatchSize}
						class="form-input"
					/>
				</label>
			</div>
			<div class="panel-actions">
				<button class="btn btn-primary" onclick={saveConfig} disabled={saving || running}>
					{saving ? 'Saving...' : 'Save Settings'}
				</button>
			</div>
		</div>

		<div class="metrics-grid">
			<div class="metric-card">
				<div class="metric-label">Recent Runs</div>
				<div class="metric-value">{runs.length}</div>
			</div>
			<div class="metric-card">
				<div class="metric-label">Failed Tenants</div>
				<div class="metric-value">
					{runs.reduce((sum, run) => sum + (run.failed_tenants || 0), 0)}
				</div>
			</div>
			<div class="metric-card">
				<div class="metric-label">Tokens Refreshed</div>
				<div class="metric-value">
					{runs.reduce((sum, run) => sum + (run.tokens_refreshed || 0), 0)}
				</div>
			</div>
		</div>

		<div class="data-table-container">
			<table class="data-table">
				<thead>
					<tr>
						<th>Started</th>
						<th>Trigger</th>
						<th>Status</th>
						<th>Tenant</th>
						<th>Processed</th>
						<th>Failed</th>
						<th>Tokens</th>
						<th>Duration</th>
					</tr>
				</thead>
				<tbody>
					{#if runs.length === 0}
						<tr>
							<td colspan="8" class="empty-cell">No token refresh runs recorded.</td>
						</tr>
					{:else}
						{#each runs as run (run.id)}
							<tr>
								<td>{formatDate(run.started_at)}</td>
								<td>{run.trigger_type === 'manual_tenant' ? 'Manual' : 'Scheduled'}</td>
								<td><span class={statusClass(run.status)}>{run.status}</span></td>
								<td class="mono">{run.requested_tenant_id || '-'}</td>
								<td>{run.processed_tenants} / {run.selected_tenants_count}</td>
								<td>{run.failed_tenants}</td>
								<td>{run.tokens_refreshed}</td>
								<td>{formatDuration(run)}</td>
							</tr>
							{#if run.error_message}
								<tr class="detail-row">
									<td colspan="8">{run.error_message}</td>
								</tr>
							{/if}
						{/each}
					{/if}
				</tbody>
			</table>
		</div>
	{/if}
</div>

<style>
	.settings-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
		gap: 16px;
	}

	.toggle-row,
	.form-field {
		display: flex;
		flex-direction: column;
		gap: 8px;
		font-size: 14px;
		color: var(--text-secondary);
	}

	.toggle-row {
		flex-direction: row;
		align-items: center;
		color: var(--text-primary);
	}

	.panel-actions {
		display: flex;
		justify-content: flex-end;
		margin-top: 20px;
	}

	.metrics-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
		gap: 16px;
		margin: 20px 0;
	}

	.metric-card {
		border: 1px solid var(--border-color);
		border-radius: 8px;
		padding: 16px;
		background: var(--surface);
	}

	.metric-label {
		font-size: 12px;
		text-transform: uppercase;
		color: var(--text-secondary);
		letter-spacing: 0;
	}

	.metric-value {
		margin-top: 8px;
		font-size: 24px;
		font-weight: 600;
		color: var(--text-primary);
	}

	.empty-cell {
		text-align: center;
		color: var(--text-secondary);
		padding: 32px;
	}

	.detail-row td {
		color: var(--danger);
		background: var(--danger-bg);
		font-size: 13px;
	}
</style>
