<script lang="ts">
	import { onMount } from 'svelte';
	import Alert from '$lib/components/Alert.svelte';
	import { adminSettingsAPI, type CategorySettings } from '$lib/api/admin-settings';
	import {
		adminStorageDestinationsAPI,
		type StorageDestination
	} from '$lib/api/admin-storage-destinations';
	import {
		adminSAMLAPI,
		type SAMLSettings,
		type SAMLSigningKeyPolicy,
		type SAMLSigningKeyReference,
		type SAMLTrustCertificatePreview
	} from '$lib/api/admin-saml';
	import { settingsContext } from '$lib/stores/settings-context.svelte';
	import { LL } from '$i18n/i18n-svelte';

	type MetadataRole = 'idp' | 'sp';
	type CertificateSlot = 'active' | 'next' | 'backup';

	interface ExportCertificateRow {
		id: string;
		role: MetadataRole;
		slot: CertificateSlot;
		label: string;
		description: string;
		reference: SAMLSigningKeyReference;
	}

	let tenantId = $state('');
	let settings = $state<CategorySettings | null>(null);
	let loading = $state(true);
	let saving = $state(false);
	let error = $state('');
	let success = $state('');
	let storageDestinations = $state<StorageDestination[]>([]);
	let selectedStorageDestinationId = $state('');
	let storageDestinationError = $state('');
	let samlSettings = $state<SAMLSettings | null>(null);
	let certificatePreviewLoading = $state(false);
	let certificatePreviewError = $state('');
	let copiedKey = $state('');
	let drBundleAction = $state('');
	let drBundleFileInput = $state<HTMLInputElement | null>(null);
	let drBundlePassphrase = $state('');
	let drBundlePassphraseConfirm = $state('');
	let selectedCertificateDetail = $state<{
		row: ExportCertificateRow;
		certificate: string;
		preview?: SAMLTrustCertificatePreview;
		error?: string;
		loading: boolean;
	} | null>(null);

	const canEdit = $derived(settingsContext.canEditAtCurrentScope());
	const canExportDRBundle = $derived(
		canEdit &&
			!drBundleAction &&
			drBundlePassphrase.length >= 12 &&
			drBundlePassphrase === drBundlePassphraseConfirm
	);
	const canImportDRBundle = $derived(canEdit && !drBundleAction && drBundlePassphrase.length >= 12);
	const exportCertificateRows = $derived(buildExportCertificateRows(samlSettings));

	onMount(async () => {
		await settingsContext.initialize();
		tenantId = settingsContext.tenantId;
		await Promise.all([loadSettings(), loadStorageDestinations(), loadSAMLSettings()]);
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
		loadSAMLSettings();
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

	async function loadSAMLSettings() {
		certificatePreviewLoading = true;
		certificatePreviewError = '';
		try {
			samlSettings = await adminSAMLAPI.getSettings();
		} catch (err) {
			certificatePreviewError =
				err instanceof Error ? err.message : $LL.admin_dr_backup_error_load_certificates();
			samlSettings = null;
		} finally {
			certificatePreviewLoading = false;
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

	function buildExportCertificateRows(settingsValue: SAMLSettings | null): ExportCertificateRow[] {
		if (!settingsValue?.localSigning) return [];
		return [
			...certificateRowsForPolicy('idp', settingsValue.localSigning.idpSigningKeyPolicy),
			...certificateRowsForPolicy('sp', settingsValue.localSigning.spSigningKeyPolicy)
		];
	}

	function certificateRowsForPolicy(
		role: MetadataRole,
		policy: SAMLSigningKeyPolicy
	): ExportCertificateRow[] {
		const rows: ExportCertificateRow[] = [];
		addCertificateRow(rows, role, 'active', policy.active);
		addCertificateRow(rows, role, 'next', policy.next);
		for (const candidate of policy.nextCandidates ?? []) {
			addCertificateRow(rows, role, 'next', candidate);
		}
		addCertificateRow(rows, role, 'backup', policy.backup);
		return rows;
	}

	function addCertificateRow(
		rows: ExportCertificateRow[],
		role: MetadataRole,
		slot: CertificateSlot,
		reference?: SAMLSigningKeyReference
	) {
		if (!reference) return;
		const index = rows.filter((row) => row.role === role && row.slot === slot).length + 1;
		rows.push({
			id: `${role}-${slot}-${reference.kid ?? reference.keyRef ?? reference.id ?? reference.certificate ?? index}`,
			role,
			slot,
			label: certificateSlotLabel(slot, index),
			description: certificateSlotDescription(slot),
			reference
		});
	}

	function certificateSlotLabel(slot: CertificateSlot, index: number): string {
		if (slot === 'active') return $LL.admin_dr_backup_certificate_slot_active();
		if (slot === 'backup') return $LL.admin_dr_backup_certificate_slot_backup();
		return index > 1
			? $LL.admin_dr_backup_certificate_slot_next_numbered({ index })
			: $LL.admin_dr_backup_certificate_slot_next();
	}

	function certificateSlotDescription(slot: CertificateSlot): string {
		if (slot === 'active') return $LL.admin_dr_backup_certificate_active_desc();
		if (slot === 'backup') return $LL.admin_dr_backup_certificate_backup_desc();
		return $LL.admin_dr_backup_certificate_next_desc();
	}

	function roleLabel(role: MetadataRole): string {
		return role === 'idp' ? 'IdP' : 'SP';
	}

	function certificateStatus(row: ExportCertificateRow): string {
		if (row.slot === 'active') return $LL.admin_dr_backup_certificate_status_signing();
		if (row.slot === 'next') return $LL.admin_dr_backup_certificate_status_rollover();
		return $LL.admin_dr_backup_certificate_status_backup();
	}

	function formatDateTime(value?: string | number | null): string {
		if (value === undefined || value === null || value === '') return '-';
		const date = typeof value === 'number' ? new Date(value) : new Date(value);
		if (Number.isNaN(date.getTime())) return String(value);
		return new Intl.DateTimeFormat(undefined, {
			year: 'numeric',
			month: 'short',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit'
		}).format(date);
	}

	function fingerprint(value?: string): string {
		return value
			? value
					.match(/.{1,2}/g)
					?.join(':')
					.toUpperCase() || value
			: '-';
	}

	async function copy(value: string, key: string) {
		try {
			await navigator.clipboard.writeText(value);
			copiedKey = key;
			setTimeout(() => {
				if (copiedKey === key) copiedKey = '';
			}, 1600);
		} catch {
			// Clipboard access may be unavailable in embedded previews.
		}
	}

	async function openCertificateDetail(row: ExportCertificateRow) {
		const certificate = row.reference.certificate ?? '';
		if (!certificate) {
			selectedCertificateDetail = {
				row,
				certificate,
				loading: false,
				error: $LL.admin_dr_backup_certificate_detail_no_certificate()
			};
			return;
		}

		selectedCertificateDetail = {
			row,
			certificate,
			loading: true
		};

		try {
			const preview = await adminSAMLAPI.previewTrustCertificate({ certificate });
			if (selectedCertificateDetail?.row.id === row.id) {
				selectedCertificateDetail = {
					...selectedCertificateDetail,
					preview,
					loading: false
				};
			}
		} catch (err) {
			if (selectedCertificateDetail?.row.id === row.id) {
				selectedCertificateDetail = {
					...selectedCertificateDetail,
					loading: false,
					error:
						err instanceof Error ? err.message : $LL.admin_dr_backup_error_preview_certificate()
				};
			}
		}
	}

	function closeCertificateDetail() {
		selectedCertificateDetail = null;
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

		<div class="certificate-export-preview">
			<div class="certificate-export-header">
				<div>
					<h3>{$LL.admin_dr_backup_export_certificates_title()}</h3>
					<p>{$LL.admin_dr_backup_export_certificates_desc()}</p>
				</div>
				<button
					type="button"
					class="btn btn-secondary btn-sm"
					onclick={loadSAMLSettings}
					disabled={certificatePreviewLoading}
				>
					<i class="i-ph-arrows-clockwise"></i>
					{$LL.admin_dr_backup_refresh_certificates()}
				</button>
			</div>

			{#if certificatePreviewError}
				<div class="form-error">{certificatePreviewError}</div>
			{:else if exportCertificateRows.length === 0}
				<div class="empty-certificate-state">
					{$LL.admin_dr_backup_no_export_certificates()}
				</div>
			{:else}
				<div class="certificate-table-wrap">
					<table class="certificate-table">
						<thead>
							<tr>
								<th>{$LL.admin_dr_backup_certificate_role()}</th>
								<th>{$LL.admin_dr_backup_certificate_slot()}</th>
								<th>{$LL.admin_dr_backup_certificate_status()}</th>
								<th>{$LL.admin_dr_backup_certificate_key_ref()}</th>
								<th>{$LL.admin_dr_backup_certificate_valid_to()}</th>
								<th>{$LL.admin_dr_backup_certificate_actions()}</th>
							</tr>
						</thead>
						<tbody>
							{#each exportCertificateRows as row (row.id)}
								<tr>
									<td>{roleLabel(row.role)}</td>
									<td>
										<strong>{row.label}</strong>
										<span>{row.description}</span>
									</td>
									<td>{certificateStatus(row)}</td>
									<td>
										{#if row.reference.kid || row.reference.keyRef}
											<code>{row.reference.kid ?? row.reference.keyRef}</code>
										{:else}
											<span>-</span>
										{/if}
									</td>
									<td>{formatDateTime(row.reference.validTo)}</td>
									<td>
										<button
											type="button"
											class="btn btn-secondary btn-xs"
											onclick={() => openCertificateDetail(row)}
											disabled={!row.reference.certificate}
										>
											{$LL.admin_dr_backup_view_certificate()}
										</button>
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
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

{#if selectedCertificateDetail}
	<div class="modal-backdrop">
		<div
			class="certificate-detail-modal"
			role="dialog"
			aria-modal="true"
			aria-labelledby="dr-certificate-detail-title"
			tabindex="-1"
		>
			<div class="modal-header">
				<div>
					<h2 id="dr-certificate-detail-title">
						{$LL.admin_dr_backup_certificate_detail_title({
							role: roleLabel(selectedCertificateDetail.row.role),
							slot: selectedCertificateDetail.row.label
						})}
					</h2>
					<p>{certificateStatus(selectedCertificateDetail.row)}</p>
				</div>
				<button
					class="icon-btn"
					onclick={closeCertificateDetail}
					aria-label={$LL.dialog_close()}
					title={$LL.dialog_close()}
				>
					<i class="i-ph-x"></i>
				</button>
			</div>

			<div class="modal-body">
				{#if selectedCertificateDetail.loading}
					<div class="modal-alert">{$LL.admin_dr_backup_certificate_detail_loading()}</div>
				{:else if selectedCertificateDetail.error}
					<div class="modal-alert error">{selectedCertificateDetail.error}</div>
				{/if}

				{#if selectedCertificateDetail.preview}
					<div class="certificate-info-grid">
						<div>
							<span>{$LL.admin_dr_backup_certificate_subject()}</span>
							<strong>{selectedCertificateDetail.preview.subject}</strong>
						</div>
						<div>
							<span>{$LL.admin_dr_backup_certificate_issuer()}</span>
							<strong>{selectedCertificateDetail.preview.issuer}</strong>
						</div>
						<div>
							<span>{$LL.admin_dr_backup_certificate_serial()}</span>
							<strong>{selectedCertificateDetail.preview.serialNumber}</strong>
						</div>
						<div>
							<span>{$LL.admin_dr_backup_certificate_valid_from()}</span>
							<strong>{formatDateTime(selectedCertificateDetail.preview.validFrom)}</strong>
						</div>
						<div>
							<span>{$LL.admin_dr_backup_certificate_valid_to()}</span>
							<strong>{formatDateTime(selectedCertificateDetail.preview.validTo)}</strong>
						</div>
						<div>
							<span>{$LL.admin_dr_backup_certificate_signature()}</span>
							<strong>{selectedCertificateDetail.preview.signatureAlgorithm}</strong>
						</div>
						<div>
							<span>{$LL.admin_dr_backup_certificate_public_key()}</span>
							<strong>
								{selectedCertificateDetail.preview.publicKeyAlgorithm}
								{selectedCertificateDetail.preview.publicKeySizeBits
									? ` ${selectedCertificateDetail.preview.publicKeySizeBits} bit`
									: ''}
							</strong>
						</div>
					</div>

					<div class="fingerprint-grid">
						<div>
							<span>{$LL.admin_dr_backup_certificate_sha1()}</span>
							<code>{fingerprint(selectedCertificateDetail.preview.fingerprintSha1)}</code>
						</div>
						<div>
							<span>{$LL.admin_dr_backup_certificate_sha256()}</span>
							<code>{fingerprint(selectedCertificateDetail.preview.fingerprintSha256)}</code>
						</div>
					</div>

					{#if selectedCertificateDetail.preview.warnings.length > 0}
						<div class="certificate-warnings">
							{#each selectedCertificateDetail.preview.warnings as warning (warning)}
								<span><i class="i-ph-warning-circle"></i>{warning}</span>
							{/each}
						</div>
					{/if}
				{/if}

				{#if selectedCertificateDetail.certificate}
					<details class="certificate-pem">
						<summary>
							<i class="i-ph-caret-right"></i>
							<span>{$LL.admin_dr_backup_certificate_pem()}</span>
						</summary>
						<div class="field-copy-row">
							<textarea
								class="certificate-textarea"
								readonly
								value={selectedCertificateDetail.certificate}
							></textarea>
							<button
								class="icon-btn"
								class:copied={copiedKey === `dr_cert_pem_${selectedCertificateDetail.row.id}`}
								onclick={() =>
									copy(
										selectedCertificateDetail?.certificate ?? '',
										`dr_cert_pem_${selectedCertificateDetail?.row.id}`
									)}
								title={$LL.admin_dr_backup_copy_certificate()}
							>
								<i
									class={copiedKey === `dr_cert_pem_${selectedCertificateDetail.row.id}`
										? 'i-ph-check'
										: 'i-ph-copy'}
								></i>
							</button>
						</div>
					</details>
				{/if}
			</div>

			<div class="modal-footer">
				<button class="btn btn-secondary" onclick={closeCertificateDetail}>
					{$LL.dialog_close()}
				</button>
			</div>
		</div>
	</div>
{/if}

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

	.certificate-export-preview {
		margin-top: 1rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		background: var(--bg-subtle);
		padding: 1rem;
	}

	.certificate-export-header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 1rem;
		margin-bottom: 0.75rem;
	}

	.certificate-export-header h3 {
		margin: 0 0 0.25rem;
		color: var(--text-primary);
		font-size: 0.9375rem;
		font-weight: 700;
	}

	.certificate-export-header p,
	.empty-certificate-state {
		margin: 0;
		color: var(--text-secondary);
		font-size: 0.8125rem;
		line-height: 1.45;
	}

	.certificate-table-wrap {
		overflow-x: auto;
	}

	.certificate-table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.8125rem;
	}

	.certificate-table th,
	.certificate-table td {
		padding: 0.625rem;
		border-bottom: 1px solid var(--border);
		color: var(--text-secondary);
		text-align: left;
		vertical-align: top;
	}

	.certificate-table th {
		color: var(--text-primary);
		font-weight: 700;
		white-space: nowrap;
	}

	.certificate-table td strong,
	.certificate-table td span {
		display: block;
	}

	.certificate-table td strong {
		color: var(--text-primary);
	}

	.certificate-table code {
		display: inline-block;
		max-width: 220px;
		overflow: hidden;
		color: var(--text-primary);
		font-size: 0.75rem;
		text-overflow: ellipsis;
		vertical-align: top;
		white-space: nowrap;
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

	.btn-xs {
		min-height: 28px;
		padding: 0.25rem 0.5rem;
		font-size: 0.75rem;
	}

	.modal-backdrop {
		position: fixed;
		inset: 0;
		z-index: 80;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 1rem;
		background: rgba(15, 23, 42, 0.54);
	}

	.certificate-detail-modal {
		width: min(920px, 100%);
		max-height: min(92vh, 820px);
		display: grid;
		grid-template-rows: auto minmax(0, 1fr) auto;
		overflow: hidden;
		border: 1px solid var(--border);
		border-radius: var(--radius-lg);
		background: var(--bg-card);
		box-shadow: 0 24px 64px rgba(15, 23, 42, 0.28);
	}

	.modal-header,
	.modal-footer {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 1rem;
		padding: 1rem 1.25rem;
		border-bottom: 1px solid var(--border);
	}

	.modal-header h2 {
		margin: 0 0 0.25rem;
		color: var(--text-primary);
		font-size: 1rem;
	}

	.modal-header p {
		margin: 0;
		color: var(--text-secondary);
		font-size: 0.8125rem;
	}

	.modal-body {
		overflow-y: auto;
		padding: 1.25rem;
	}

	.modal-footer {
		justify-content: flex-end;
		border-top: 1px solid var(--border);
		border-bottom: 0;
	}

	.icon-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--text-secondary);
		cursor: pointer;
		flex: 0 0 auto;
	}

	.icon-btn:hover {
		background: var(--bg-subtle);
		color: var(--text-primary);
	}

	.icon-btn.copied {
		border-color: var(--success);
		color: var(--success);
	}

	.modal-alert {
		border: 1px solid rgba(59, 130, 246, 0.28);
		border-radius: var(--radius-md);
		background: rgba(59, 130, 246, 0.08);
		color: var(--text-secondary);
		font-size: 0.8125rem;
		padding: 0.75rem;
	}

	.modal-alert.error {
		border-color: rgba(239, 68, 68, 0.28);
		background: rgba(239, 68, 68, 0.08);
		color: var(--danger);
	}

	.certificate-info-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 0.75rem;
	}

	.certificate-info-grid div,
	.fingerprint-grid div {
		min-width: 0;
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		background: var(--bg-subtle);
		padding: 0.75rem;
	}

	.certificate-info-grid span,
	.fingerprint-grid span {
		display: block;
		margin-bottom: 0.25rem;
		color: var(--text-secondary);
		font-size: 0.75rem;
		font-weight: 700;
	}

	.certificate-info-grid strong,
	.fingerprint-grid code {
		color: var(--text-primary);
		font-size: 0.8125rem;
		overflow-wrap: anywhere;
	}

	.fingerprint-grid {
		display: grid;
		gap: 0.75rem;
		margin-top: 0.75rem;
	}

	.certificate-warnings {
		display: grid;
		gap: 0.5rem;
		margin-top: 0.75rem;
	}

	.certificate-warnings span {
		display: flex;
		align-items: flex-start;
		gap: 0.375rem;
		color: var(--warning);
		font-size: 0.8125rem;
	}

	.certificate-pem {
		margin-top: 1rem;
	}

	.certificate-pem summary {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		color: var(--text-primary);
		cursor: pointer;
		font-size: 0.875rem;
		font-weight: 700;
	}

	.field-copy-row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: 0.5rem;
		align-items: start;
		margin-top: 0.625rem;
	}

	.certificate-textarea {
		width: 100%;
		min-height: 180px;
		padding: 0.75rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		background: var(--bg-input);
		color: var(--text-primary);
		font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
		font-size: 0.75rem;
		resize: vertical;
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

		.certificate-export-header,
		.certificate-info-grid {
			display: grid;
			grid-template-columns: 1fr;
		}
	}
</style>
