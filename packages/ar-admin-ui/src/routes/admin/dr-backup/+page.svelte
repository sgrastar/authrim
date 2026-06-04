<script lang="ts">
	import { onMount } from 'svelte';
	import Alert from '$lib/components/Alert.svelte';
	import { adminSettingsAPI, type CategorySettings } from '$lib/api/admin-settings';
	import {
		adminStorageDestinationsAPI,
		type StorageDestination
	} from '$lib/api/admin-storage-destinations';
	import { adminSAMLAPI } from '$lib/api/admin-saml';
	import { settingsContext } from '$lib/stores/settings-context.svelte';
	import { LL } from '$i18n/i18n-svelte';

	let tenantId = $state('');
	let settings = $state<CategorySettings | null>(null);
	let loading = $state(true);
	let saving = $state(false);
	let error = $state('');
	let success = $state('');
	let storageDestinations = $state<StorageDestination[]>([]);
	let selectedStorageDestinationId = $state('');
	let storageDestinationError = $state('');
	let drBundleAction = $state('');
	let drBundleFileInput = $state<HTMLInputElement | null>(null);
	let drBundlePassphrase = $state('');
	let drBundlePassphraseConfirm = $state('');

	const canEdit = $derived(settingsContext.canEditAtCurrentScope());
	const canExportDRBundle = $derived(
		canEdit &&
			!drBundleAction &&
			drBundlePassphrase.length >= 12 &&
			drBundlePassphrase === drBundlePassphraseConfirm
	);
	const canImportDRBundle = $derived(canEdit && !drBundleAction && drBundlePassphrase.length >= 12);

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
			error = err instanceof Error ? err.message : $LL.admin_dr_backup_error_load_settings();
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
				err instanceof Error ? err.message : $LL.admin_dr_backup_error_load_destinations();
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
			success = $LL.admin_dr_backup_destination_updated();
		} catch (err) {
			storageDestinationError =
				err instanceof Error ? err.message : $LL.admin_dr_backup_error_update_destination();
		} finally {
			saving = false;
		}
	}

	function providerLabel(destination: StorageDestination): string {
		return destination.provider.toUpperCase().replace('_', ' ');
	}

	function downloadText(filename: string, contents: string, type = 'text/plain') {
		const blob = new Blob([contents], { type });
		const url = URL.createObjectURL(blob);
		const link = document.createElement('a');
		link.href = url;
		link.download = filename;
		document.body.appendChild(link);
		link.click();
		link.remove();
		URL.revokeObjectURL(url);
	}

	async function exportLocalSigningDRBundle() {
		if (drBundleAction || !canEdit) return;
		drBundleAction = 'export';
		error = '';
		success = '';
		try {
			const bundle = await adminSAMLAPI.exportLocalSigningDRBundle(drBundlePassphrase);
			const tenant = bundle.tenantId || tenantId || 'tenant';
			downloadText(
				`authrim-saml-local-signing-dr-bundle-${tenant}.json`,
				JSON.stringify(bundle, null, 2),
				'application/json'
			);
			success = $LL.admin_dr_backup_bundle_exported();
			clearDRBundlePassphrase();
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_dr_backup_error_export_bundle();
		} finally {
			drBundleAction = '';
		}
	}

	async function importLocalSigningDRBundle(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		if (!file || drBundleAction || !canEdit) return;
		drBundleAction = 'import';
		error = '';
		success = '';
		try {
			const bundle = JSON.parse(await file.text()) as unknown;
			await adminSAMLAPI.importLocalSigningDRBundle(bundle, drBundlePassphrase);
			success = $LL.admin_dr_backup_bundle_imported();
			clearDRBundlePassphrase();
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_dr_backup_error_import_bundle();
		} finally {
			drBundleAction = '';
			input.value = '';
		}
	}

	function clearDRBundlePassphrase() {
		drBundlePassphrase = '';
		drBundlePassphraseConfirm = '';
	}
</script>

<svelte:head>
	<title>{$LL.admin_dr_backup_page_title()}</title>
</svelte:head>

<div class="admin-page">
	<div class="page-header">
		<div>
			<h1 class="page-title">{$LL.admin_dr_backup_title()}</h1>
			<p class="page-description">{$LL.admin_dr_backup_description()}</p>
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
		<h2 class="panel-title">{$LL.admin_dr_backup_destination_title()}</h2>
		{#if loading}
			<div class="loading-state">
				<i class="i-ph-spinner loading-spinner"></i>
				<p>{$LL.admin_dr_backup_loading_settings()}</p>
			</div>
		{:else}
			<div class="form-group">
				<label for="storage-destination" class="form-label">
					{$LL.admin_dr_backup_storage_destination()}
				</label>
				<select
					id="storage-destination"
					class="form-select"
					value={selectedStorageDestinationId}
					disabled={saving || !canEdit}
					onchange={(event) =>
						handleStorageDestinationChange((event.currentTarget as HTMLSelectElement).value)}
				>
					<option value="">{$LL.admin_dr_backup_not_configured()}</option>
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
					{#each storageDestinations.filter((d) => d.id === selectedStorageDestinationId) as destination (destination.id)}
						<div class="destination-name">{destination.display_name || destination.name}</div>
						<div class="destination-meta">
							{providerLabel(destination)} · {destination.scope_type}
						</div>
					{/each}
				</div>
			{/if}
		{/if}
	</div>

	<div class="panel">
		<div class="panel-heading">
			<div>
				<h2 class="panel-title">{$LL.admin_dr_backup_saml_bundle_title()}</h2>
				<p class="panel-description">
					{$LL.admin_dr_backup_saml_bundle_desc()}
				</p>
			</div>
			<span class="sensitive-badge">{$LL.admin_dr_backup_sensitive()}</span>
		</div>

		<div class="warning-box">
			<i class="i-ph-warning-circle"></i>
			<span>
				{$LL.admin_dr_backup_saml_bundle_warning()}
			</span>
		</div>

		<div class="dr-bundle-fields">
			<label>
				<span>{$LL.admin_dr_backup_passphrase()}</span>
				<input
					class="form-input"
					type="password"
					autocomplete="new-password"
					bind:value={drBundlePassphrase}
					placeholder={$LL.admin_dr_backup_passphrase_placeholder()}
					disabled={!!drBundleAction || !canEdit}
				/>
			</label>
			<label>
				<span>{$LL.admin_dr_backup_confirm_passphrase()}</span>
				<input
					class="form-input"
					type="password"
					autocomplete="new-password"
					bind:value={drBundlePassphraseConfirm}
					placeholder={$LL.admin_dr_backup_confirm_passphrase_placeholder()}
					disabled={!!drBundleAction || !canEdit}
				/>
			</label>
		</div>

		<div class="form-actions">
			<button
				class="btn btn-secondary"
				onclick={exportLocalSigningDRBundle}
				disabled={!canExportDRBundle}
			>
				<i class="i-ph-download-simple"></i>
				{drBundleAction === 'export'
					? $LL.admin_dr_backup_exporting()
					: $LL.admin_dr_backup_export_bundle()}
			</button>
			<button
				class="btn btn-secondary"
				onclick={() => drBundleFileInput?.click()}
				disabled={!canImportDRBundle}
			>
				<i class="i-ph-upload-simple"></i>
				{drBundleAction === 'import'
					? $LL.admin_dr_backup_importing()
					: $LL.admin_dr_backup_import_bundle()}
			</button>
			<input
				bind:this={drBundleFileInput}
				class="hidden-file-input"
				type="file"
				accept="application/json,.json"
				onchange={importLocalSigningDRBundle}
			/>
		</div>
	</div>
</div>

<style>
	.panel {
		background: var(--bg-card);
		border: 1px solid var(--border);
		border-radius: var(--radius-lg);
		padding: 1.5rem;
	}

	.panel + .panel {
		margin-top: 1rem;
	}

	.panel-heading {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 1rem;
		margin-bottom: 1rem;
	}

	.panel-title {
		font-size: 1.125rem;
		font-weight: 600;
		color: var(--text-primary);
		margin: 0 0 1rem;
	}

	.panel-heading .panel-title {
		margin-bottom: 0.25rem;
	}

	.panel-description {
		color: var(--text-secondary);
		font-size: 0.875rem;
		line-height: 1.45;
		margin: 0;
	}

	.sensitive-badge {
		border-radius: 999px;
		background: rgba(245, 158, 11, 0.14);
		color: var(--warning);
		font-size: 0.75rem;
		font-weight: 700;
		padding: 0.25rem 0.625rem;
		white-space: nowrap;
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

	.warning-box {
		display: flex;
		align-items: flex-start;
		gap: 0.5rem;
		border: 1px solid rgba(245, 158, 11, 0.28);
		border-radius: var(--radius-md);
		background: rgba(245, 158, 11, 0.08);
		color: var(--text-secondary);
		font-size: 0.8125rem;
		line-height: 1.45;
		padding: 0.75rem;
	}

	.warning-box i {
		color: var(--warning);
		flex: 0 0 auto;
		margin-top: 0.125rem;
	}

	.dr-bundle-fields {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 320px));
		gap: 0.75rem;
		margin-top: 1rem;
	}

	.dr-bundle-fields label {
		display: grid;
		gap: 0.375rem;
		color: var(--text-primary);
		font-size: 0.875rem;
		font-weight: 600;
	}

	.form-input {
		width: 100%;
		padding: 0.5rem 0.75rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		background: var(--bg-input);
		color: var(--text-primary);
		font-size: 0.875rem;
	}

	.form-actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
		margin-top: 1rem;
	}

	.hidden-file-input {
		display: none;
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

	@media (max-width: 720px) {
		.panel-heading,
		.form-actions {
			display: grid;
			justify-content: stretch;
		}

		.dr-bundle-fields {
			grid-template-columns: 1fr;
		}
	}
</style>
