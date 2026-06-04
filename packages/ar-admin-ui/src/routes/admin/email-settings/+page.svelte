<script lang="ts">
	import { onMount } from 'svelte';
	import { settingsContext } from '$lib/stores/settings-context.svelte';
	import {
		adminEmailSettingsAPI,
		type EmailProviderEntry,
		type TenantEmailSettings
	} from '$lib/api/admin-email-settings';
	import { LL } from '$i18n/i18n-svelte';

	let loading = $state(true);
	let saving = $state(false);
	let error = $state('');
	let successMessage = $state('');
	let tenantId = $state('');
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
			error = err instanceof Error ? err.message : $LL.admin_email_settings_load_failed();
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
			successMessage = $LL.admin_email_settings_saved();
			setTimeout(() => {
				successMessage = '';
			}, 3000);
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_email_settings_save_failed();
		} finally {
			saving = false;
		}
	}

	onMount(async () => {
		const selectedTenantId = settingsContext.tenantId;
		if (!selectedTenantId) {
			loading = false;
			error = $LL.admin_email_settings_select_tenant();
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
	<title>{$LL.admin_email_settings_head_title()}</title>
</svelte:head>

<div class="page">
	<div class="page-header">
		<div>
			<h1>{$LL.admin_email_settings_title()}</h1>
			<p>{$LL.admin_email_settings_description()}</p>
		</div>
		<button class="save-button" onclick={saveSettings} disabled={saving || loading || !tenantId}>
			{saving ? $LL.admin_email_settings_saving() : $LL.admin_email_settings_save_order()}
		</button>
	</div>

	{#if loading}
		<div class="panel">
			<p>{$LL.admin_email_settings_loading()}</p>
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
				<h2>{$LL.admin_email_settings_delivery_mode()}</h2>
				<p>{$LL.admin_email_settings_strategy_priority_failover()}</p>
			</div>
			<div>
				<h2>{$LL.admin_email_settings_tenant()}</h2>
				<p>{tenantId || $LL.admin_email_settings_not_selected()}</p>
			</div>
		</div>

		<div class="panel">
			<div class="panel-header">
				<div>
					<h2>{$LL.admin_email_settings_provider_priority()}</h2>
					<p>{$LL.admin_email_settings_provider_priority_description()}</p>
				</div>
				<a class="plugin-link" href="/admin/plugins">{$LL.admin_email_settings_open_plugins()}</a>
			</div>

			{#if providers.length === 0}
				<div class="empty-state">
					<p>{$LL.admin_email_settings_empty()}</p>
					<p>{$LL.admin_email_settings_empty_hint()}</p>
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
										{$LL.admin_email_settings_provider_settings()}
									</a>
								</div>
								<div class="provider-id">{provider.id}</div>
								<div class="provider-meta">
									<span class="provider-meta-badge"
										>{$LL.admin_email_settings_configured_via({
											source: provider.configSource
										})}</span
									>
									{#if provider.defaultFrom}
										<span class="provider-meta-text"
											>{$LL.admin_email_settings_from({
												address: provider.defaultFrom
											})}</span
										>
									{/if}
								</div>
							</div>
							<div class="provider-actions">
								<button onclick={() => moveProvider(index, -1)} disabled={index === 0}>
									{$LL.admin_email_settings_move_up()}
								</button>
								<button
									onclick={() => moveProvider(index, 1)}
									disabled={index === providers.length - 1}
								>
									{$LL.admin_email_settings_move_down()}
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

	.provider-meta {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem 0.75rem;
		margin-top: 0.625rem;
		font-size: 0.875rem;
		color: var(--text-secondary, #4b5563);
	}

	.provider-meta-badge {
		display: inline-flex;
		align-items: center;
		border-radius: 999px;
		padding: 0.2rem 0.65rem;
		background: #e2e8f0;
		color: #1e293b;
		font-weight: 600;
	}

	.provider-meta-text {
		font-family: var(--font-mono, monospace);
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
