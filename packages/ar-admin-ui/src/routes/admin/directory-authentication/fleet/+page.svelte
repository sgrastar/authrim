<script lang="ts">
	import { onMount } from 'svelte';
	import {
		adminDirectoryConnectorsAPI,
		type DirectoryConnectorFleetInstance,
		type DirectoryConnectorStatusEpisode
	} from '$lib/api/admin-directory-connectors';
	import { AdminPageHeader, AdminPageShell, AdminSection } from '$lib/components/admin';
	import { settingsContext } from '$lib/stores/settings-context.svelte';
	import { LL } from '$i18n/i18n-svelte';
	import DirectoryAuthenticationTabs from '../DirectoryAuthenticationTabs.svelte';

	let loading = $state(true);
	let actionInstanceId = $state('');
	let error = $state('');
	let successMessage = $state('');
	let tenantId = $state('');
	let instances = $state<DirectoryConnectorFleetInstance[]>([]);
	let episodes = $state<DirectoryConnectorStatusEpisode[]>([]);

	const currentTenantId = $derived(settingsContext.tenantId);
	const canEdit = $derived(settingsContext.canEditAtCurrentScope());

	function formatTime(value: number | string | null | undefined): string {
		if (value === null || value === undefined || value === '') return '-';
		const date = typeof value === 'number' ? new Date(value) : new Date(value);
		return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
	}

	function currentEpisode(instance: DirectoryConnectorFleetInstance) {
		return episodes.find(
			(episode) =>
				episode.instance_id === instance.instance_id &&
				episode.connector_id === instance.connector_id &&
				episode.ended_at === null
		);
	}

	function recentEpisodes(instance: DirectoryConnectorFleetInstance) {
		return episodes
			.filter(
				(episode) =>
					episode.instance_id === instance.instance_id &&
					episode.connector_id === instance.connector_id
			)
			.slice(0, 5);
	}

	function healthSummary(instance: DirectoryConnectorFleetInstance): string {
		const entries = Object.entries(instance.health_summary ?? {});
		if (entries.length === 0) return '-';
		return entries
			.slice(0, 4)
			.map(([key, value]) => `${key}: ${String(value)}`)
			.join(', ');
	}

	async function loadFleet(selectedTenantId: string) {
		loading = true;
		error = '';
		successMessage = '';
		tenantId = selectedTenantId;
		try {
			const response = await adminDirectoryConnectorsAPI.listFleet(selectedTenantId);
			instances = response.items;
			episodes = response.episodes;
		} catch (err) {
			error =
				err instanceof Error ? err.message : $LL.admin_directory_authentication_fleet_load_failed();
			instances = [];
			episodes = [];
		} finally {
			loading = false;
		}
	}

	async function updateInstance(
		instance: DirectoryConnectorFleetInstance,
		action: 'acknowledge' | 'deactivate' | 'reactivate'
	) {
		if (!tenantId || !canEdit) return;
		actionInstanceId = instance.instance_id;
		error = '';
		successMessage = '';
		try {
			await adminDirectoryConnectorsAPI.updateFleetInstance(tenantId, instance.instance_id, {
				action,
				connector_id: instance.connector_id,
				reason: action === 'deactivate' ? 'admin_deactivated' : undefined
			});
			successMessage = $LL.admin_directory_authentication_fleet_updated();
			await loadFleet(tenantId);
		} catch (err) {
			error =
				err instanceof Error
					? err.message
					: $LL.admin_directory_authentication_fleet_update_failed();
		} finally {
			actionInstanceId = '';
		}
	}

	onMount(async () => {
		await settingsContext.initialize();
		const selectedTenantId = settingsContext.tenantId;
		if (!selectedTenantId) {
			loading = false;
			error = $LL.admin_directory_authentication_select_tenant();
			return;
		}
		await loadFleet(selectedTenantId);
	});

	$effect(() => {
		if (!currentTenantId || loading || currentTenantId === tenantId) return;
		void loadFleet(currentTenantId);
	});
</script>

<svelte:head>
	<title>{$LL.admin_directory_authentication_fleet_page_title()}</title>
</svelte:head>

{#snippet headerActions()}
	<button
		class="btn btn-primary"
		disabled={loading || !tenantId}
		onclick={() => loadFleet(tenantId)}
	>
		{$LL.admin_directory_authentication_pending_refresh()}
	</button>
{/snippet}

<AdminPageShell>
	<AdminPageHeader
		title={$LL.admin_directory_authentication_fleet_title()}
		description={$LL.admin_directory_authentication_fleet_description()}
		actions={headerActions}
	/>

	<DirectoryAuthenticationTabs active="fleet" />

	{#if error}
		<div class="alert alert--error">{error}</div>
	{/if}
	{#if successMessage}
		<div class="alert alert--success">{successMessage}</div>
	{/if}

	<AdminSection
		title={$LL.admin_directory_authentication_fleet_instances()}
		description={$LL.admin_directory_authentication_fleet_instances_description()}
	>
		{#if loading}
			<p class="state-text">{$LL.admin_directory_authentication_loading()}</p>
		{:else if instances.length === 0}
			<div class="empty-state">{$LL.admin_directory_authentication_fleet_empty()}</div>
		{:else}
			<div class="fleet-list">
				{#each instances as instance (instance.id)}
					<section class="fleet-row">
						<div class="fleet-row__header">
							<div>
								<h2>{instance.display_name || instance.instance_id}</h2>
								<p>
									<code>{instance.instance_id}</code>
									<span>{instance.transport}</span>
									<span>{instance.version}</span>
									<span>{instance.release_channel}</span>
								</p>
							</div>
							<span class={`status-pill status-pill--${instance.status}`}>
								{instance.status}
							</span>
						</div>

						<div class="fleet-grid">
							<div>
								<span>{$LL.admin_directory_authentication_connector_id()}</span>
								<code>{instance.connector_id}</code>
							</div>
							<div>
								<span>{$LL.admin_directory_authentication_fleet_last_seen()}</span>
								<strong>{formatTime(instance.last_seen_at)}</strong>
							</div>
							<div>
								<span>{$LL.admin_directory_authentication_fleet_started_at()}</span>
								<strong>{formatTime(instance.started_at)}</strong>
							</div>
							<div>
								<span>{$LL.admin_directory_authentication_fleet_health()}</span>
								<strong>{instance.health_status}</strong>
							</div>
							<div>
								<span>{$LL.admin_directory_authentication_fleet_drift()}</span>
								<strong>{instance.drift_severity}</strong>
							</div>
							<div>
								<span>{$LL.admin_directory_authentication_fleet_categories()}</span>
								<strong>{instance.config_categories.join(', ') || '-'}</strong>
							</div>
						</div>

						<p class="health-summary">{healthSummary(instance)}</p>

						{#if instance.deactivation_reason}
							<p class="security-note">
								{$LL.admin_directory_authentication_fleet_key_rotation_recommended()}
							</p>
						{/if}

						<div class="fleet-actions">
							<button
								type="button"
								class="btn btn-secondary"
								disabled={!canEdit || actionInstanceId === instance.instance_id}
								onclick={() => updateInstance(instance, 'acknowledge')}
							>
								{$LL.admin_directory_authentication_fleet_acknowledge()}
							</button>
							{#if instance.status === 'deactivated'}
								<button
									type="button"
									class="btn btn-primary"
									disabled={!canEdit || actionInstanceId === instance.instance_id}
									onclick={() => updateInstance(instance, 'reactivate')}
								>
									{$LL.admin_directory_authentication_fleet_reactivate()}
								</button>
							{:else}
								<button
									type="button"
									class="btn btn-danger"
									disabled={!canEdit || actionInstanceId === instance.instance_id}
									onclick={() => updateInstance(instance, 'deactivate')}
								>
									{$LL.admin_directory_authentication_fleet_deactivate()}
								</button>
							{/if}
						</div>

						<details class="episodes">
							<summary>
								{$LL.admin_directory_authentication_fleet_recent_episodes()}
								{#if currentEpisode(instance)?.acknowledged_at}
									<span>{$LL.admin_directory_authentication_fleet_acknowledged()}</span>
								{/if}
							</summary>
							{#each recentEpisodes(instance) as episode (episode.id)}
								<div class="episode-row">
									<span>{episode.status}</span>
									<strong>{formatTime(episode.started_at)}</strong>
									<code>{episode.reason ?? '-'}</code>
								</div>
							{/each}
						</details>
					</section>
				{/each}
			</div>
		{/if}
	</AdminSection>
</AdminPageShell>

<style>
	h2,
	p {
		margin: 0;
	}

	.alert,
	.empty-state,
	.fleet-row {
		border: 1px solid var(--color-border);
		border-radius: 8px;
		background: var(--color-surface);
	}

	.alert {
		margin-bottom: 16px;
		padding: 12px 14px;
		font-size: 0.9rem;
	}

	.alert--error {
		border-color: var(--color-danger, #d33);
		color: var(--color-danger, #b42318);
	}

	.alert--success {
		border-color: var(--color-success, #248a3d);
		color: var(--color-success, #1f7a34);
	}

	.empty-state {
		padding: 18px;
		color: var(--color-text-muted);
	}

	.fleet-list {
		display: grid;
		gap: 16px;
	}

	.fleet-row {
		padding: 18px;
	}

	.fleet-row__header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 16px;
		margin-bottom: 16px;
	}

	.fleet-row h2 {
		font-size: 1rem;
		font-weight: 700;
		color: var(--color-text);
	}

	.fleet-row__header p {
		display: flex;
		gap: 10px;
		flex-wrap: wrap;
		margin-top: 6px;
		color: var(--color-text-muted);
		font-size: 0.82rem;
	}

	.status-pill {
		border-radius: 999px;
		background: var(--color-surface-elevated, var(--color-surface));
		padding: 5px 10px;
		font-size: 0.78rem;
		font-weight: 700;
		color: var(--color-text);
	}

	.status-pill--connected {
		background: color-mix(in srgb, var(--color-success, #248a3d) 16%, transparent);
		color: var(--color-success, #1f7a34);
	}

	.status-pill--deactivated,
	.status-pill--unhealthy {
		background: color-mix(in srgb, var(--color-danger, #d33) 14%, transparent);
		color: var(--color-danger, #b42318);
	}

	.status-pill--stale,
	.status-pill--version_mismatch {
		background: color-mix(in srgb, var(--color-warning, #b76e00) 16%, transparent);
		color: var(--color-warning, #8a5400);
	}

	.fleet-grid {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 12px;
	}

	.fleet-grid div {
		display: grid;
		gap: 5px;
		min-width: 0;
	}

	.fleet-grid span {
		color: var(--color-text-muted);
		font-size: 0.76rem;
		font-weight: 700;
	}

	.fleet-grid strong,
	code {
		overflow-wrap: anywhere;
	}

	.health-summary,
	.security-note {
		margin-top: 14px;
		color: var(--color-text-muted);
		font-size: 0.85rem;
	}

	.security-note {
		color: var(--color-danger, #b42318);
		font-weight: 650;
	}

	.fleet-actions {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
		margin-top: 16px;
	}

	.episodes {
		margin-top: 16px;
		border-top: 1px solid var(--color-border);
		padding-top: 12px;
	}

	.episodes summary {
		cursor: pointer;
		font-size: 0.84rem;
		font-weight: 700;
	}

	.episodes summary span {
		margin-left: 8px;
		color: var(--color-success, #1f7a34);
	}

	.episode-row {
		display: grid;
		grid-template-columns: 160px minmax(160px, 1fr) minmax(100px, 1fr);
		gap: 12px;
		padding: 8px 0;
		border-top: 1px solid var(--color-border);
		font-size: 0.82rem;
	}

	@media (max-width: 760px) {
		.fleet-row__header {
			flex-direction: column;
		}

		.fleet-grid,
		.episode-row {
			grid-template-columns: 1fr;
		}
	}
</style>
