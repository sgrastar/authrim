<script lang="ts">
	import { onMount } from 'svelte';
	import {
		adminExternalTokenRefreshAPI,
		type ExternalTokenRefreshConfig,
		type ExternalTokenRefreshRunSummary
	} from '$lib/api/admin-external-token-refresh';
	import { getLocale, LL } from '$i18n/i18n-svelte';
	import AdminDataTable from '$lib/components/admin/AdminDataTable.svelte';
	import AdminPageHeader from '$lib/components/admin/AdminPageHeader.svelte';
	import AdminPageShell from '$lib/components/admin/AdminPageShell.svelte';
	import AdminSection from '$lib/components/admin/AdminSection.svelte';

	let config: ExternalTokenRefreshConfig = $state({
		enabled: false,
		refreshThresholdSeconds: 3600,
		batchSize: 100,
		scheduledTenantBatchSize: 100,
		piiShardPageSize: 4
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
			error = err instanceof Error ? err.message : $LL.admin_external_token_refresh_load_failed();
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
			success = $LL.admin_external_token_refresh_save_success();
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_external_token_refresh_save_failed();
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
			success = $LL.admin_external_token_refresh_run_success({
				status: result.status,
				count: result.tokensRefreshed
			});
			const runsResponse = await adminExternalTokenRefreshAPI.listRuns();
			runs = runsResponse.runs;
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_external_token_refresh_run_failed();
		} finally {
			running = false;
		}
	}

	function formatDate(value: number | null): string {
		if (!value) return '-';
		return new Date(value).toLocaleString(getLocale() === 'ja' ? 'ja-JP' : 'en-US');
	}

	function formatDuration(run: ExternalTokenRefreshRunSummary): string {
		if (!run.completed_at) return '-';
		const seconds = Math.max(0, Math.round((run.completed_at - run.started_at) / 1000));
		return `${seconds}s`;
	}

	function statusClass(status: ExternalTokenRefreshRunSummary['status']): string {
		if (status === 'completed') return 'badge badge-success';
		if (status === 'partial_failure') return 'badge badge-warning';
		if (status === 'failed') return 'badge badge-danger';
		return 'badge badge-neutral';
	}

	function formatTrigger(triggerType: ExternalTokenRefreshRunSummary['trigger_type']): string {
		return triggerType === 'manual_tenant'
			? $LL.admin_external_token_refresh_trigger_manual()
			: $LL.admin_external_token_refresh_trigger_scheduled();
	}

	function formatStatus(status: ExternalTokenRefreshRunSummary['status']): string {
		switch (status) {
			case 'completed':
				return $LL.admin_external_token_refresh_status_completed();
			case 'partial_failure':
				return $LL.admin_external_token_refresh_status_partial_failure();
			case 'failed':
				return $LL.admin_external_token_refresh_status_failed();
			case 'running':
				return $LL.admin_external_token_refresh_status_running();
			default:
				return status;
		}
	}
</script>

<svelte:head>
	<title>{$LL.admin_external_token_refresh_page_title()}</title>
</svelte:head>

{#snippet pageActions()}
	<button class="btn btn-secondary" onclick={load} disabled={loading || saving || running}>
		<i class="i-ph-arrow-clockwise" aria-hidden="true"></i>
		{$LL.admin_external_token_refresh_refresh()}
	</button>
	<button class="btn btn-primary" onclick={runNow} disabled={loading || saving || running}>
		<i class="i-ph-play" aria-hidden="true"></i>
		{running
			? $LL.admin_external_token_refresh_running()
			: $LL.admin_external_token_refresh_run_current_tenant()}
	</button>
{/snippet}

<AdminPageShell>
	<AdminPageHeader
		title={$LL.admin_external_token_refresh_title()}
		description={$LL.admin_external_token_refresh_description()}
		actions={pageActions}
	/>

	{#if error}
		<div class="alert alert-error">{error}</div>
	{/if}
	{#if success}
		<div class="alert alert-success">{success}</div>
	{/if}

	{#if loading}
		<div class="loading-state">
			<i class="i-ph-circle-notch loading-spinner"></i>
			<p>{$LL.admin_external_token_refresh_loading()}</p>
		</div>
	{:else}
		<AdminSection title={$LL.admin_external_token_refresh_settings()}>
			<div class="settings-grid">
				<label class="toggle-row">
					<input type="checkbox" bind:checked={config.enabled} />
					<span>{$LL.admin_external_token_refresh_enable_scheduled()}</span>
				</label>

				<label class="form-field">
					<span>{$LL.admin_external_token_refresh_threshold_seconds()}</span>
					<input
						type="number"
						min="1"
						bind:value={config.refreshThresholdSeconds}
						class="admin-input"
					/>
				</label>

				<label class="form-field">
					<span>{$LL.admin_external_token_refresh_token_batch_size()}</span>
					<input
						type="number"
						min="1"
						max="1000"
						bind:value={config.batchSize}
						class="admin-input"
					/>
				</label>

				<label class="form-field">
					<span>{$LL.admin_external_token_refresh_scheduled_tenant_batch_size()}</span>
					<input
						type="number"
						min="1"
						max="100"
						bind:value={config.scheduledTenantBatchSize}
						class="admin-input"
					/>
				</label>

				<label class="form-field">
					<span>{$LL.admin_external_token_refresh_pii_shard_page_size()}</span>
					<input
						type="number"
						min="1"
						max="32"
						bind:value={config.piiShardPageSize}
						class="admin-input"
					/>
				</label>
			</div>
			<div class="section-actions">
				<button class="btn btn-primary" onclick={saveConfig} disabled={saving || running}>
					{saving
						? $LL.admin_external_token_refresh_saving()
						: $LL.admin_external_token_refresh_save_settings()}
				</button>
			</div>
		</AdminSection>

		<div class="metrics-grid">
			<div class="metric-card">
				<div class="metric-label">{$LL.admin_external_token_refresh_recent_runs()}</div>
				<div class="metric-value">{runs.length}</div>
			</div>
			<div class="metric-card">
				<div class="metric-label">{$LL.admin_external_token_refresh_failed_tenants()}</div>
				<div class="metric-value">
					{runs.reduce((sum, run) => sum + (run.failed_tenants || 0), 0)}
				</div>
			</div>
			<div class="metric-card">
				<div class="metric-label">{$LL.admin_external_token_refresh_tokens_refreshed()}</div>
				<div class="metric-value">
					{runs.reduce((sum, run) => sum + (run.tokens_refreshed || 0), 0)}
				</div>
			</div>
		</div>

		<AdminSection title={$LL.admin_external_token_refresh_recent_runs()}>
			<AdminDataTable width="xwide">
				<thead>
					<tr>
						<th>{$LL.admin_external_token_refresh_started()}</th>
						<th>{$LL.admin_external_token_refresh_trigger()}</th>
						<th>{$LL.admin_external_token_refresh_status()}</th>
						<th>{$LL.admin_external_token_refresh_tenant()}</th>
						<th>{$LL.admin_external_token_refresh_processed()}</th>
						<th>{$LL.admin_external_token_refresh_failed()}</th>
						<th>{$LL.admin_external_token_refresh_tokens()}</th>
						<th>{$LL.admin_external_token_refresh_duration()}</th>
					</tr>
				</thead>
				<tbody>
					{#if runs.length === 0}
						<tr>
							<td colspan="8" class="empty-cell">{$LL.admin_external_token_refresh_no_runs()}</td>
						</tr>
					{:else}
						{#each runs as run (run.id)}
							<tr>
								<td>{formatDate(run.started_at)}</td>
								<td>{formatTrigger(run.trigger_type)}</td>
								<td><span class={statusClass(run.status)}>{formatStatus(run.status)}</span></td>
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
			</AdminDataTable>
		</AdminSection>
	{/if}
</AdminPageShell>

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
		color: var(--color-text-muted);
	}

	.toggle-row {
		flex-direction: row;
		align-items: center;
		color: var(--color-text);
	}

	.form-field :global(.admin-input) {
		width: 100%;
		min-height: var(--control-height, 38px);
		padding: var(--control-padding, 8px 12px);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-control);
		background: var(--control-bg, var(--color-surface));
		color: var(--color-text);
		font: inherit;
		outline: none;
	}

	.form-field :global(.admin-input:focus) {
		border-color: var(--color-accent);
		box-shadow: 0 0 0 3px var(--color-accent-muted);
	}

	.section-actions {
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
		border: 1px solid var(--color-border);
		border-radius: var(--radius-panel);
		padding: 16px;
		background: var(--color-surface);
		box-shadow: var(--shadow-sm);
	}

	.metric-label {
		font-size: 12px;
		text-transform: uppercase;
		color: var(--color-text-muted);
		letter-spacing: 0;
	}

	.metric-value {
		margin-top: 8px;
		font-size: 24px;
		font-weight: 600;
		color: var(--color-text);
	}

	.empty-cell {
		text-align: center;
		color: var(--color-text-muted);
		padding: 32px;
	}

	.detail-row td {
		color: var(--color-danger);
		background: color-mix(in srgb, var(--color-danger) 10%, transparent);
		font-size: 13px;
	}
</style>
