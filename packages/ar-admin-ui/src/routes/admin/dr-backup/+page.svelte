<script lang="ts">
	import { onMount } from 'svelte';
	import Alert from '$lib/components/Alert.svelte';
	import { adminSettingsAPI, type CategorySettings } from '$lib/api/admin-settings';
	import {
		adminStorageDestinationsAPI,
		type StorageDestination
	} from '$lib/api/admin-storage-destinations';
	import { settingsContext } from '$lib/stores/settings-context.svelte';

	let tenantId = $state('');
	let settings = $state<CategorySettings | null>(null);
	let loading = $state(true);
	let saving = $state(false);
	let error = $state('');
	let success = $state('');
	let storageDestinations = $state<StorageDestination[]>([]);
	let selectedStorageDestinationId = $state('');
	let storageDestinationError = $state('');

	const canEdit = $derived(settingsContext.canEditAtCurrentScope());

	onMount(async () => {
		await settingsContext.initialize();
		tenantId = settingsContext.tenantId;
		await Promise.all([loadSettings(), loadStorageDestinations()]);
	});

	let previousTenantId = $state<string | null>(null);
	$effect(() => {
		const currentTenantId = settingsContext.tenantId;
		if (previousTenantId === null) {
			previousTenantId = currentTenantId;
			return;
		}
		if (currentTenantId === previousTenantId) return;
		previousTenantId = currentTenantId;
		tenantId = currentTenantId;
		loadSettings();
		loadStorageDestinations();
	});

	async function loadSettings() {
		loading = true;
		error = '';
		success = '';
		try {
			const result = await adminSettingsAPI.getSettings('dr-backup', tenantId);
			settings = result;
			selectedStorageDestinationId = String(
				result.values['dr-backup.storage_destination_id'] ?? ''
			);
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to load DR backup settings';
		} finally {
			loading = false;
		}
	}

	async function loadStorageDestinations() {
		storageDestinationError = '';
		try {
			const response = await adminStorageDestinationsAPI.listUsable();
			storageDestinations = response.items;
		} catch (err) {
			storageDestinationError =
				err instanceof Error ? err.message : 'Failed to load storage destinations';
			storageDestinations = [];
		}
	}

	async function handleStorageDestinationChange(destinationId: string) {
		if (!settings || saving || !canEdit) return;

		saving = true;
		error = '';
		success = '';
		storageDestinationError = '';

		try {
			const result = await adminSettingsAPI.updateSettings(
				'dr-backup',
				{
					ifMatch: settings.version,
					set: {
						'dr-backup.storage_destination_id': destinationId
					}
				},
				tenantId
			);

			if (destinationId) {
				await adminStorageDestinationsAPI.recordUsage(destinationId, {
					feature: 'dr_backup',
					resource_type: 'tenant',
					resource_id: tenantId,
					metadata: { setting: 'dr-backup.storage_destination_id' }
				});
			}

			settings = {
				...settings,
				version: result.version,
				values: {
					...settings.values,
					'dr-backup.storage_destination_id': destinationId
				}
			};
			selectedStorageDestinationId = destinationId;
			success = 'DR backup storage destination updated.';
		} catch (err) {
			storageDestinationError =
				err instanceof Error ? err.message : 'Failed to update DR backup storage destination';
		} finally {
			saving = false;
		}
	}

	function providerLabel(destination: StorageDestination): string {
		return destination.provider.toUpperCase().replace('_', ' ');
	}
</script>

<svelte:head>
	<title>DR Backup - Authrim</title>
</svelte:head>

<div class="admin-page">
	<div class="page-header">
		<div>
			<h1 class="page-title">DR Backup</h1>
			<p class="page-description">Configure disaster recovery backup artifact storage.</p>
		</div>
	</div>

	{#if error}
		<Alert variant="error" dismissible onDismiss={() => (error = '')}>
			{error}
		</Alert>
	{/if}
	{#if success}
		<Alert variant="success" dismissible onDismiss={() => (success = '')}>
			{success}
		</Alert>
	{/if}

	<div class="panel">
		<h2 class="panel-title">Backup Destination</h2>
		{#if loading}
			<div class="loading-state">
				<i class="i-ph-spinner loading-spinner"></i>
				<p>Loading settings...</p>
			</div>
		{:else}
			<div class="form-group">
				<label for="storage-destination" class="form-label">Storage Destination</label>
				<select
					id="storage-destination"
					class="form-select"
					value={selectedStorageDestinationId}
					disabled={saving || !canEdit}
					onchange={(event) =>
						handleStorageDestinationChange((event.currentTarget as HTMLSelectElement).value)}
				>
					<option value="">Not configured</option>
					{#each storageDestinations as destination (destination.id)}
						<option value={destination.id}>
							{destination.display_name || destination.name} ({providerLabel(destination)})
						</option>
					{/each}
				</select>
				{#if storageDestinationError}
					<p class="form-error">{storageDestinationError}</p>
				{/if}
			</div>

			{#if selectedStorageDestinationId}
				<div class="selected-destination">
					{#each storageDestinations.filter((d) => d.id === selectedStorageDestinationId) as destination}
						<div class="destination-name">{destination.display_name || destination.name}</div>
						<div class="destination-meta">
							{providerLabel(destination)} · {destination.scope_type}
						</div>
					{/each}
				</div>
			{/if}
		{/if}
	</div>
</div>

<style>
	.panel {
		background: var(--bg-card);
		border: 1px solid var(--border);
		border-radius: var(--radius-lg);
		padding: 1.5rem;
	}

	.panel-title {
		font-size: 1.125rem;
		font-weight: 600;
		color: var(--text-primary);
		margin: 0 0 1rem;
	}

	.form-group {
		margin-bottom: 1rem;
	}

	.form-label {
		display: block;
		font-size: 0.875rem;
		font-weight: 500;
		color: var(--text-primary);
		margin-bottom: 0.5rem;
	}

	.form-select {
		width: 100%;
		padding: 0.5rem 0.75rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		background: var(--bg-input);
		color: var(--text-primary);
		font-size: 0.875rem;
	}

	.form-error {
		color: var(--danger);
		font-size: 0.8125rem;
		margin-top: 0.5rem;
	}

	.selected-destination {
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		padding: 0.75rem;
		background: var(--bg-subtle);
	}

	.destination-name {
		font-weight: 600;
		color: var(--text-primary);
	}

	.destination-meta {
		font-size: 0.8125rem;
		color: var(--text-secondary);
		margin-top: 0.25rem;
	}
</style>
