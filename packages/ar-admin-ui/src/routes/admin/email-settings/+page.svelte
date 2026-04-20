<script lang="ts">
	import { onMount } from 'svelte';
	import { settingsContext } from '$lib/stores/settings-context.svelte';
	import {
		adminEmailSettingsAPI,
		type EmailProviderEntry,
		type TenantEmailSettings
	} from '$lib/api/admin-email-settings';

	let loading = $state(true);
	let saving = $state(false);
	let error = $state('');
	let successMessage = $state('');
	let tenantId = $state('');
	let strategyLabel = $state('Priority + Failover');
	let providers = $state<EmailProviderEntry[]>([]);
	let settings = $state<TenantEmailSettings>({
		strategy: 'priority_failover',
		providerOrder: []
	});

	function syncProviderOrder(nextProviders: EmailProviderEntry[]) {
		providers = nextProviders;
		settings = {
			...settings,
			providerOrder: nextProviders.map((provider) => provider.id)
		};
	}

	function moveProvider(index: number, direction: -1 | 1) {
		const targetIndex = index + direction;
		if (targetIndex < 0 || targetIndex >= providers.length) {
			return;
		}

		const nextProviders = [...providers];
		const [provider] = nextProviders.splice(index, 1);
		nextProviders.splice(targetIndex, 0, provider);
		syncProviderOrder(nextProviders);
	}

	async function loadEmailSettings(selectedTenantId: string) {
		loading = true;
		error = '';

		try {
			const response = await adminEmailSettingsAPI.get(selectedTenantId);
			tenantId = response.tenantId;
			settings = response.settings;
			providers = response.providers;
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to load email settings';
		} finally {
			loading = false;
		}
	}

	async function saveSettings() {
		if (!tenantId) {
			return;
		}

		saving = true;
		error = '';
		successMessage = '';

		try {
			const response = await adminEmailSettingsAPI.update(tenantId, settings);
			settings = response.settings;
			providers = response.providers;
			successMessage = 'Email provider order saved';
			setTimeout(() => {
				successMessage = '';
			}, 3000);
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to save email settings';
		} finally {
			saving = false;
		}
	}

	onMount(async () => {
		const selectedTenantId = settingsContext.tenantId;
		if (!selectedTenantId) {
			loading = false;
			error = 'Select a tenant to manage email settings';
			return;
		}

		await loadEmailSettings(selectedTenantId);
	});

	$effect(() => {
		const selectedTenantId = settingsContext.tenantId;
		if (!selectedTenantId || selectedTenantId === tenantId) {
			return;
		}

		void loadEmailSettings(selectedTenantId);
	});
</script>

<svelte:head>
	<title>Email Settings - Authrim Admin</title>
</svelte:head>

<div class="page">
	<div class="page-header">
		<div>
			<h1>Email Settings</h1>
			<p>Choose the tenant-wide delivery order for enabled email providers.</p>
		</div>
		<button class="save-button" onclick={saveSettings} disabled={saving || loading || !tenantId}>
			{saving ? 'Saving...' : 'Save Order'}
		</button>
	</div>

	{#if loading}
		<div class="panel">
			<p>Loading email settings...</p>
		</div>
	{:else}
		{#if error}
			<div class="alert error">{error}</div>
		{/if}

		{#if successMessage}
			<div class="alert success">{successMessage}</div>
		{/if}

		<div class="panel summary">
			<div>
				<h2>Delivery Mode</h2>
				<p>{strategyLabel}</p>
			</div>
			<div>
				<h2>Tenant</h2>
				<p>{tenantId || 'Not selected'}</p>
			</div>
		</div>

		<div class="panel">
			<div class="panel-header">
				<div>
					<h2>Provider Priority</h2>
					<p>Enabled providers are tried in this order until delivery succeeds.</p>
				</div>
				<a class="plugin-link" href="/admin/plugins">Open Plugins Page</a>
			</div>

			{#if providers.length === 0}
				<div class="empty-state">
					<p>No email providers are enabled for this tenant.</p>
					<p>Enable Cloudflare Email Service or Resend on the Plugins page first.</p>
				</div>
			{:else}
				<div class="provider-list">
					{#each providers as provider, index (provider.id)}
						<div class="provider-card">
							<div class="provider-rank">{index + 1}</div>
							<div class="provider-body">
								<div class="provider-title-row">
									<div>
										<h3>{provider.name}</h3>
										<p>{provider.description}</p>
									</div>
									<a href={`/admin/plugins?plugin=${encodeURIComponent(provider.id)}`}>
										Provider Settings
									</a>
								</div>
								<div class="provider-id">{provider.id}</div>
							</div>
							<div class="provider-actions">
								<button onclick={() => moveProvider(index, -1)} disabled={index === 0}>
									Move Up
								</button>
								<button
									onclick={() => moveProvider(index, 1)}
									disabled={index === providers.length - 1}
								>
									Move Down
								</button>
							</div>
						</div>
					{/each}
				</div>
			{/if}
		</div>
	{/if}
</div>

<style>
	.page {
		display: flex;
		flex-direction: column;
		gap: 1.5rem;
	}

	.page-header {
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		gap: 1rem;
	}

	h1,
	h2,
	h3,
	p {
		margin: 0;
	}

	.panel {
		border: 1px solid var(--border-subtle, #d7dce3);
		border-radius: 16px;
		padding: 1.25rem;
		background: var(--surface-primary, #fff);
	}

	.summary {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
		gap: 1rem;
	}

	.panel-header {
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		gap: 1rem;
		margin-bottom: 1rem;
	}

	.provider-list {
		display: flex;
		flex-direction: column;
		gap: 0.875rem;
	}

	.provider-card {
		display: grid;
		grid-template-columns: auto 1fr auto;
		gap: 1rem;
		align-items: center;
		padding: 1rem;
		border-radius: 14px;
		border: 1px solid var(--border-subtle, #d7dce3);
		background: var(--surface-secondary, #f8fafc);
	}

	.provider-rank {
		width: 2rem;
		height: 2rem;
		border-radius: 999px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		font-weight: 700;
		background: #dbeafe;
		color: #1d4ed8;
	}

	.provider-title-row {
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		gap: 1rem;
	}

	.provider-title-row a,
	.plugin-link {
		color: #2563eb;
		text-decoration: none;
		font-weight: 600;
	}

	.provider-id {
		margin-top: 0.5rem;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 0.875rem;
		color: #475569;
	}

	.provider-actions {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	button,
	.save-button {
		border: none;
		border-radius: 10px;
		padding: 0.7rem 1rem;
		font: inherit;
		cursor: pointer;
		background: #0f172a;
		color: #fff;
	}

	button[disabled],
	.save-button[disabled] {
		opacity: 0.55;
		cursor: not-allowed;
	}

	.provider-actions button {
		background: #e2e8f0;
		color: #0f172a;
	}

	.alert {
		padding: 0.875rem 1rem;
		border-radius: 12px;
	}

	.alert.error {
		background: #fef2f2;
		color: #b91c1c;
	}

	.alert.success {
		background: #f0fdf4;
		color: #166534;
	}

	.empty-state {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		padding: 1rem 0;
		color: #475569;
	}

	@media (max-width: 768px) {
		.page-header,
		.panel-header,
		.provider-title-row,
		.provider-card {
			grid-template-columns: 1fr;
			display: flex;
			flex-direction: column;
			align-items: stretch;
		}

		.provider-actions {
			flex-direction: row;
		}
	}
</style>
