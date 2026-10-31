<script lang="ts">
	import { onMount } from 'svelte';
	import Alert from '$lib/components/Alert.svelte';
	import {
		AdminDataTable,
		AdminPageHeader,
		AdminPageShell,
		AdminSection
	} from '$lib/components/admin';
	import { adminSettingsAPI, type CategorySettings } from '$lib/api/admin-settings';
	import {
		adminStorageDestinationsAPI,
		type StorageDestination
	} from '$lib/api/admin-storage-destinations';
	import {
		adminTenantBackupsAPI,
		saveTenantBackupResponse,
		type TenantBackupAdminMappings,
		type TenantBackupOperation,
		type TenantBackupOperationSummary,
		type TenantBackupSelection
	} from '$lib/api/admin-tenant-backups';
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
	let tenantBackupPassphrase = $state('');
	let tenantBackupPassphraseConfirm = $state('');
	let tenantBackupImportPassphrase = $state('');
	let tenantBackupAction = $state('');
	let tenantBackupProgress = $state('');
	let tenantBackupFileInput = $state<HTMLInputElement | null>(null);
	let tenantBackupOperations = $state<TenantBackupOperationSummary[]>([]);
	let selectedTenantBackup = $state<TenantBackupOperation | null>(null);
	let tenantBackupAdminMappings = $state<TenantBackupAdminMappings | null>(null);
	let tenantBackupSelection = $state<TenantBackupSelection>({
		settings: true,
		users: false,
		admin: false,
		artifacts: false,
		logs: { audit: false, other: false, sensitive: false, period: 'all' }
	});
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
	const canExportTenantBackup = $derived(
		canEdit &&
			!tenantBackupAction &&
			hasTenantBackupSelection() &&
			tenantBackupPassphrase.length >= 16 &&
			tenantBackupPassphrase === tenantBackupPassphraseConfirm
	);
	const canImportTenantBackup = $derived(
		canEdit &&
			!tenantBackupAction &&
			hasTenantBackupSelection() &&
			tenantBackupImportPassphrase.length >= 16
	);
	const exportCertificateRows = $derived(buildExportCertificateRows(samlSettings));
	const formatBackupBytes = (bytes: number) =>
		bytes < 1024
			? `${bytes} B`
			: bytes < 1024 * 1024
				? `${(bytes / 1024).toFixed(1)} KiB`
				: `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;

	onMount(() => {
		void (async () => {
			await settingsContext.initialize();
			tenantId = settingsContext.tenantId;
			await Promise.all([
				loadSettings(),
				loadStorageDestinations(),
				loadSAMLSettings(),
				loadTenantBackupOperations()
			]);
		})();
		const timer = globalThis.setInterval(() => void loadTenantBackupOperations(true), 5000);
		return () => globalThis.clearInterval(timer);
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
		loadTenantBackupOperations();
	});

	async function loadTenantBackupOperations(quiet = false) {
		try {
			const response = await adminTenantBackupsAPI.list();
			tenantBackupOperations = response.operations;
			if (selectedTenantBackup) {
				const current = response.operations.find((item) => item.id === selectedTenantBackup?.id);
				if (current) await openTenantBackup(current.id);
			}
		} catch (err) {
			if (!quiet) {
				error = err instanceof Error ? err.message : $LL.admin_dr_backup_tenant_error_load();
			}
		}
	}

	async function startTenantSettingsExport() {
		if (!canExportTenantBackup) return;
		tenantBackupAction = 'export';
		error = '';
		success = '';
		try {
			await adminTenantBackupsAPI.createExport(
				currentTenantBackupSelection(),
				tenantBackupPassphrase
			);
			tenantBackupPassphrase = '';
			tenantBackupPassphraseConfirm = '';
			success = $LL.admin_dr_backup_tenant_export_started();
			await loadTenantBackupOperations();
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_dr_backup_tenant_error_export();
		} finally {
			tenantBackupAction = '';
		}
	}

	async function importTenantSettingsBackup(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		if (!file || !canImportTenantBackup) return;
		tenantBackupAction = 'import';
		tenantBackupProgress = $LL.admin_dr_backup_tenant_uploading();
		error = '';
		success = '';
		try {
			const upload = await adminTenantBackupsAPI.upload(file, (uploaded, total) => {
				tenantBackupProgress = $LL.admin_dr_backup_tenant_upload_progress({
					percent: Math.floor((uploaded / total) * 100)
				});
			});
			tenantBackupProgress = $LL.admin_dr_backup_tenant_verifying();
			await adminTenantBackupsAPI.waitForUpload(upload.id);
			await adminTenantBackupsAPI.createImport(
				file,
				upload.id,
				currentTenantBackupSelection(),
				tenantBackupImportPassphrase
			);
			tenantBackupImportPassphrase = '';
			success = $LL.admin_dr_backup_tenant_import_started();
			await loadTenantBackupOperations();
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_dr_backup_tenant_error_import();
		} finally {
			tenantBackupAction = '';
			tenantBackupProgress = '';
			input.value = '';
		}
	}

	async function openTenantBackup(operationId: string) {
		try {
			selectedTenantBackup = await adminTenantBackupsAPI.get(operationId);
			tenantBackupAdminMappings =
				selectedTenantBackup.preview && selectedTenantBackup.selection.admin
					? await adminTenantBackupsAPI.adminMappings(operationId)
					: null;
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_dr_backup_tenant_error_load();
		}
	}

	async function mapTenantBackupAdmin(sourceAdminId: string, targetAdminId: string) {
		if (!selectedTenantBackup || !targetAdminId || tenantBackupAction) return;
		tenantBackupAction = 'admin-mapping';
		error = '';
		try {
			await adminTenantBackupsAPI.mapAdmin(selectedTenantBackup.id, sourceAdminId, targetAdminId);
			await openTenantBackup(selectedTenantBackup.id);
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_dr_backup_tenant_admin_mapping_error();
		} finally {
			tenantBackupAction = '';
		}
	}

	function hasTenantBackupSelection(): boolean {
		return (
			tenantBackupSelection.settings ||
			tenantBackupSelection.users ||
			tenantBackupSelection.admin ||
			tenantBackupSelection.artifacts ||
			tenantBackupSelection.logs.audit ||
			tenantBackupSelection.logs.other
		);
	}

	function currentTenantBackupSelection(): TenantBackupSelection {
		return {
			settings: tenantBackupSelection.settings,
			users: tenantBackupSelection.users,
			admin: tenantBackupSelection.admin,
			artifacts: tenantBackupSelection.artifacts,
			logs: {
				audit: tenantBackupSelection.logs.audit,
				other: tenantBackupSelection.logs.other,
				sensitive: tenantBackupSelection.logs.sensitive,
				period: tenantBackupSelection.logs.period
			}
		};
	}

	function setTenantBackupLogPeriod(value: string) {
		tenantBackupSelection.logs.period = value === 'all' ? 'all' : (Number(value) as 7 | 30 | 90);
	}

	function targetAdminAlreadyMapped(targetAdminId: string, sourceAdminId: string): boolean {
		return Boolean(
			tenantBackupAdminMappings?.sources.some(
				(source) => source.sourceAdminId !== sourceAdminId && source.targetAdminId === targetAdminId
			)
		);
	}

	async function approveTenantRestore() {
		if (!selectedTenantBackup?.preview?.canApprove || tenantBackupAction) return;
		tenantBackupAction = 'approve';
		try {
			await adminTenantBackupsAPI.approve(selectedTenantBackup);
			success = $LL.admin_dr_backup_tenant_restore_approved();
			selectedTenantBackup = await adminTenantBackupsAPI.get(selectedTenantBackup.id);
			await loadTenantBackupOperations(true);
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_dr_backup_tenant_error_approve();
		} finally {
			tenantBackupAction = '';
		}
	}

	async function cancelTenantBackup(operationId: string) {
		if (tenantBackupAction) return;
		tenantBackupAction = 'cancel';
		try {
			await adminTenantBackupsAPI.cancel(operationId);
			await loadTenantBackupOperations();
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_dr_backup_tenant_error_cancel();
		} finally {
			tenantBackupAction = '';
		}
	}

	async function downloadTenantBackup(operationId: string) {
		if (tenantBackupAction) return;
		tenantBackupAction = 'download';
		try {
			const response = await adminTenantBackupsAPI.download(operationId, tenantId);
			if (!response.ok) throw new Error($LL.admin_dr_backup_tenant_error_download());
			await saveTenantBackupResponse(response, `authrim-${operationId}.authrim`);
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_dr_backup_tenant_error_download();
		} finally {
			tenantBackupAction = '';
		}
	}

	function restoreBlockerLabel(blocker: { code: string; subjectId: string | null }): string {
		if (blocker.code === 'external_prerequisite_unresolved') {
			return $LL.admin_dr_backup_tenant_blocker_external({ id: blocker.subjectId ?? '-' });
		}
		return $LL.admin_dr_backup_tenant_blocker_delivery();
	}

	function tenantBackupSelectionLabels(selection: TenantBackupSelection): string[] {
		const labels: string[] = [];
		if (selection.settings) labels.push($LL.admin_dr_backup_tenant_selection_settings());
		if (selection.users) labels.push($LL.admin_dr_backup_tenant_selection_users());
		if (selection.admin) labels.push($LL.admin_dr_backup_tenant_selection_admin());
		if (selection.artifacts) labels.push($LL.admin_dr_backup_tenant_selection_artifacts());
		const period =
			selection.logs.period === 'all'
				? $LL.admin_dr_backup_tenant_period_all()
				: $LL.admin_dr_backup_tenant_period_days({ days: selection.logs.period });
		if (selection.logs.audit) {
			labels.push($LL.admin_dr_backup_tenant_selection_audit_logs({ period }));
		}
		if (selection.logs.other) {
			labels.push($LL.admin_dr_backup_tenant_selection_other_logs({ period }));
		}
		if ((selection.logs.audit || selection.logs.other) && selection.logs.sensitive) {
			labels.push($LL.admin_dr_backup_tenant_selection_sensitive());
		}
		return labels;
	}

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

<AdminPageShell>
	<AdminPageHeader
		title={$LL.admin_dr_backup_title()}
		description={$LL.admin_dr_backup_description()}
	/>

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

	<AdminSection
		title={$LL.admin_dr_backup_tenant_title()}
		description={$LL.admin_dr_backup_tenant_desc()}
	>
		<div class="dr-panel tenant-backup-panel">
			<div class="tenant-backup-scope">
				<div>
					<strong>{$LL.admin_dr_backup_tenant_selection_title()}</strong>
					<p>{$LL.admin_dr_backup_tenant_selection_desc()}</p>
				</div>
			</div>
			<div class="tenant-backup-selection-grid">
				<label
					><input type="checkbox" bind:checked={tenantBackupSelection.settings} />
					{$LL.admin_dr_backup_tenant_selection_settings()}</label
				>
				<label
					><input type="checkbox" bind:checked={tenantBackupSelection.users} />
					{$LL.admin_dr_backup_tenant_selection_users()}</label
				>
				<label
					><input type="checkbox" bind:checked={tenantBackupSelection.admin} />
					{$LL.admin_dr_backup_tenant_selection_admin()}</label
				>
				<label
					><input type="checkbox" bind:checked={tenantBackupSelection.artifacts} />
					{$LL.admin_dr_backup_tenant_selection_artifacts()}</label
				>
				<label
					><input type="checkbox" bind:checked={tenantBackupSelection.logs.audit} />
					{$LL.admin_dr_backup_tenant_selection_audit_logs_plain()}</label
				>
				<label
					><input type="checkbox" bind:checked={tenantBackupSelection.logs.other} />
					{$LL.admin_dr_backup_tenant_selection_other_logs_plain()}</label
				>
				<label>
					<input
						type="checkbox"
						bind:checked={tenantBackupSelection.logs.sensitive}
						disabled={!tenantBackupSelection.logs.audit && !tenantBackupSelection.logs.other}
					/>
					{$LL.admin_dr_backup_tenant_selection_sensitive()}
				</label>
				<label class="tenant-backup-period">
					<span>{$LL.admin_dr_backup_tenant_log_period()}</span>
					<select
						class="admin-input"
						value={tenantBackupSelection.logs.period}
						disabled={!tenantBackupSelection.logs.audit && !tenantBackupSelection.logs.other}
						onchange={(event) => setTenantBackupLogPeriod(event.currentTarget.value)}
					>
						<option value="7">{$LL.admin_dr_backup_tenant_period_days({ days: 7 })}</option>
						<option value="30">{$LL.admin_dr_backup_tenant_period_days({ days: 30 })}</option>
						<option value="90">{$LL.admin_dr_backup_tenant_period_days({ days: 90 })}</option>
						<option value="all">{$LL.admin_dr_backup_tenant_period_all()}</option>
					</select>
				</label>
			</div>
			{#if !hasTenantBackupSelection()}
				<p class="scope-note">{$LL.admin_dr_backup_tenant_selection_required()}</p>
			{/if}

			<div class="tenant-backup-actions-grid">
				<div class="tenant-backup-action-card">
					<h3>{$LL.admin_dr_backup_tenant_export_title()}</h3>
					<p>{$LL.admin_dr_backup_tenant_export_desc()}</p>
					<label>
						<span>{$LL.admin_dr_backup_passphrase()}</span>
						<input
							class="admin-input"
							type="password"
							autocomplete="new-password"
							bind:value={tenantBackupPassphrase}
							disabled={!!tenantBackupAction || !canEdit}
						/>
					</label>
					<label>
						<span>{$LL.admin_dr_backup_confirm_passphrase()}</span>
						<input
							class="admin-input"
							type="password"
							autocomplete="new-password"
							bind:value={tenantBackupPassphraseConfirm}
							disabled={!!tenantBackupAction || !canEdit}
						/>
					</label>
					<button
						class="btn btn-primary"
						type="button"
						onclick={startTenantSettingsExport}
						disabled={!canExportTenantBackup}
					>
						<i class="i-ph-download-simple"></i>
						{$LL.admin_dr_backup_tenant_export_start()}
					</button>
				</div>

				<div class="tenant-backup-action-card">
					<h3>{$LL.admin_dr_backup_tenant_import_title()}</h3>
					<p>{$LL.admin_dr_backup_tenant_import_desc()}</p>
					<label>
						<span>{$LL.admin_dr_backup_passphrase()}</span>
						<input
							class="admin-input"
							type="password"
							autocomplete="current-password"
							bind:value={tenantBackupImportPassphrase}
							disabled={!!tenantBackupAction || !canEdit}
						/>
					</label>
					<button
						class="btn btn-secondary"
						type="button"
						onclick={() => tenantBackupFileInput?.click()}
						disabled={!canImportTenantBackup}
					>
						<i class="i-ph-upload-simple"></i>
						{$LL.admin_dr_backup_tenant_import_select()}
					</button>
					<input
						bind:this={tenantBackupFileInput}
						class="hidden-file-input"
						type="file"
						accept=".authrim,application/octet-stream"
						onchange={importTenantSettingsBackup}
					/>
					{#if tenantBackupProgress}<p class="operation-progress">{tenantBackupProgress}</p>{/if}
				</div>
			</div>

			<div class="tenant-backup-history-header">
				<div>
					<h3>{$LL.admin_dr_backup_tenant_history_title()}</h3>
					<p>{$LL.admin_dr_backup_tenant_history_desc()}</p>
				</div>
				<button
					class="btn btn-secondary btn-sm"
					type="button"
					onclick={() => loadTenantBackupOperations()}
				>
					<i class="i-ph-arrows-clockwise"></i>
					{$LL.admin_dr_backup_refresh_certificates()}
				</button>
			</div>
			{#if tenantBackupOperations.length === 0}
				<p class="empty-certificate-state">{$LL.admin_dr_backup_tenant_history_empty()}</p>
			{:else}
				<AdminDataTable compact>
					<thead>
						<tr>
							<th>{$LL.admin_dr_backup_tenant_kind()}</th>
							<th>{$LL.admin_dr_backup_tenant_status()}</th>
							<th>{$LL.admin_dr_backup_tenant_updated()}</th>
							<th>{$LL.admin_dr_backup_certificate_actions()}</th>
						</tr>
					</thead>
					<tbody>
						{#each tenantBackupOperations as operation (operation.id)}
							<tr>
								<td
									>{operation.kind === 'export'
										? $LL.admin_dr_backup_tenant_export()
										: $LL.admin_dr_backup_tenant_import()}</td
								>
								<td><span class="operation-state">{operation.state}</span></td>
								<td>{formatDateTime(operation.updatedAt)}</td>
								<td class="operation-actions">
									<button
										class="btn btn-secondary btn-xs"
										type="button"
										onclick={() => openTenantBackup(operation.id)}
									>
										{$LL.admin_dr_backup_tenant_view()}
									</button>
									{#if operation.kind === 'export' && ['ready', 'completed'].includes(operation.state)}
										<button
											class="btn btn-secondary btn-xs"
											type="button"
											onclick={() => downloadTenantBackup(operation.id)}
										>
											{$LL.admin_dr_backup_tenant_download()}
										</button>
									{/if}
									{#if ['queued', 'running', 'waiting', 'ready'].includes(operation.state)}
										<button
											class="btn btn-danger btn-xs"
											type="button"
											onclick={() => cancelTenantBackup(operation.id)}
										>
											{$LL.admin_dr_backup_tenant_cancel()}
										</button>
									{/if}
								</td>
							</tr>
						{/each}
					</tbody>
				</AdminDataTable>
			{/if}

			{#if selectedTenantBackup}
				<div class="tenant-backup-detail">
					<div class="tenant-backup-history-header">
						<div>
							<h3>{$LL.admin_dr_backup_tenant_detail_title()}</h3>
							<p>{selectedTenantBackup.id}</p>
						</div>
						<button
							class="icon-btn"
							type="button"
							onclick={() => (selectedTenantBackup = null)}
							aria-label={$LL.dialog_close()}
						>
							<i class="i-ph-x"></i>
						</button>
					</div>
					<div class="operation-selection">
						<strong>{$LL.admin_dr_backup_tenant_selection_title()}</strong>
						<ul>
							{#each tenantBackupSelectionLabels(selectedTenantBackup.selection) as label (label)}
								<li>{label}</li>
							{/each}
						</ul>
					</div>
					{#if selectedTenantBackup.progress}
						<p class="operation-progress" data-testid="tenant-backup-execution-progress">
							registered {selectedTenantBackup.progress.registered} / materialized {selectedTenantBackup
								.progress.materialized} / nonEmpty {selectedTenantBackup.progress.nonEmpty} / executionBatches
							{selectedTenantBackup.progress.executionBatches} / rows {selectedTenantBackup.progress
								.rows} / bytes {formatBackupBytes(selectedTenantBackup.progress.bytes)}
						</p>
					{/if}
					{#if selectedTenantBackup.preview}
						<div class="restore-preview-summary">
							<strong
								>{$LL.admin_dr_backup_tenant_preview_summary({
									datasets: selectedTenantBackup.preview.datasetCount,
									records: selectedTenantBackup.preview.recordCount
								})}</strong
							>
							<details class="restore-preview-datasets">
								<summary>{$LL.admin_dr_backup_tenant_preview_datasets()}</summary>
								<ul>
									{#each selectedTenantBackup.preview.datasets as dataset (dataset.datasetId)}
										<li><code>{dataset.datasetId}</code>: {dataset.recordCount}</li>
									{/each}
								</ul>
							</details>
							{#if selectedTenantBackup.preview.blockers.length > 0}
								<div class="warning-box">
									<i class="i-ph-warning-circle"></i>
									<div>
										<span>{$LL.admin_dr_backup_tenant_preview_blocked()}</span>
										<ul>
											{#each selectedTenantBackup.preview.blockers as blocker (`${blocker.code}:${blocker.subjectId ?? ''}`)}
												<li>{restoreBlockerLabel(blocker)}</li>
											{/each}
										</ul>
									</div>
								</div>
							{/if}
							{#if selectedTenantBackup.selection.admin && selectedTenantBackup.adminMapping}
								<div class="tenant-backup-admin-mapping">
									<strong>{$LL.admin_dr_backup_tenant_admin_mapping_title()}</strong>
									<p>
										{$LL.admin_dr_backup_tenant_admin_mapping_progress({
											mapped: selectedTenantBackup.adminMapping.mappedCount,
											total: selectedTenantBackup.adminMapping.sourceCount
										})}
									</p>
									{#if tenantBackupAdminMappings}
										{#if tenantBackupAdminMappings.targets.length === 0 && tenantBackupAdminMappings.sources.length > 0}
											<p class="scope-note">
												{$LL.admin_dr_backup_tenant_admin_mapping_no_targets()}
											</p>
										{:else}
											<AdminDataTable compact>
												<thead>
													<tr>
														<th>{$LL.admin_dr_backup_tenant_admin_mapping_source()}</th>
														<th>{$LL.admin_dr_backup_tenant_admin_mapping_target()}</th>
													</tr>
												</thead>
												<tbody>
													{#each tenantBackupAdminMappings.sources as source (source.sourceAdminId)}
														<tr>
															<td><code>{source.sourceAdminId}</code></td>
															<td>
																<select
																	class="admin-input"
																	value={source.targetAdminId ?? ''}
																	disabled={tenantBackupAction === 'admin-mapping'}
																	onchange={(event) =>
																		mapTenantBackupAdmin(
																			source.sourceAdminId,
																			event.currentTarget.value
																		)}
																>
																	<option value=""
																		>{$LL.admin_dr_backup_tenant_admin_mapping_unassigned()}</option
																	>
																	{#each tenantBackupAdminMappings.targets as target (target.id)}
																		<option
																			value={target.id}
																			disabled={targetAdminAlreadyMapped(
																				target.id,
																				source.sourceAdminId
																			)}
																		>
																			{target.name ? `${target.name} — ` : ''}{target.email}
																		</option>
																	{/each}
																</select>
															</td>
														</tr>
													{/each}
												</tbody>
											</AdminDataTable>
										{/if}
									{/if}
								</div>
							{/if}
							<div class="warning-box">
								<i class="i-ph-warning-circle"></i>
								<span>{$LL.admin_dr_backup_tenant_blocker_delivery()}</span>
							</div>
							<button
								class="btn btn-primary"
								type="button"
								onclick={approveTenantRestore}
								disabled={!selectedTenantBackup.preview.canApprove || !!tenantBackupAction}
							>
								{$LL.admin_dr_backup_tenant_approve_restore()}
							</button>
						</div>
					{:else}
						<p>
							{$LL.admin_dr_backup_tenant_detail_status({ status: selectedTenantBackup.state })}
						</p>
					{/if}
					{#if selectedTenantBackup.heldRecords.length > 0}
						<div class="warning-box">
							<i class="i-ph-pause-circle"></i>
							<div>
								<strong>
									{$LL.admin_dr_backup_tenant_held_records({
										count: selectedTenantBackup.heldRecords.reduce(
											(total, item) => total + item.count,
											0
										)
									})}
								</strong>
								<details>
									<summary>{$LL.admin_dr_backup_tenant_held_records_details()}</summary>
									<ul>
										{#each selectedTenantBackup.heldRecords as item (`${item.datasetId}:${item.reason}`)}
											<li><code>{item.datasetId}</code>: {item.count} ({item.reason})</li>
										{/each}
									</ul>
								</details>
							</div>
						</div>
					{/if}
					{#if selectedTenantBackup.publication}
						<p>
							{$LL.admin_dr_backup_tenant_download_expires({
								time: formatDateTime(selectedTenantBackup.publication.expiresAt)
							})}
						</p>
					{/if}
				</div>
			{/if}
		</div>
	</AdminSection>

	<AdminSection title={$LL.admin_dr_backup_destination_title()}>
		<div class="dr-panel">
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
						class="admin-select"
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
	</AdminSection>

	<AdminSection
		title={$LL.admin_dr_backup_saml_bundle_title()}
		description={$LL.admin_dr_backup_saml_bundle_desc()}
	>
		{#snippet actions()}
			<span class="sensitive-badge">{$LL.admin_dr_backup_sensitive()}</span>
		{/snippet}

		<div class="dr-panel">
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
					<AdminDataTable compact>
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
									<td class="certificate-slot-cell">
										<strong>{row.label}</strong>
										<span>{row.description}</span>
									</td>
									<td>{certificateStatus(row)}</td>
									<td>
										{#if row.reference.kid || row.reference.keyRef}
											<code class="certificate-key-ref"
												>{row.reference.kid ?? row.reference.keyRef}</code
											>
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
					</AdminDataTable>
				{/if}
			</div>

			<div class="dr-bundle-fields">
				<label>
					<span>{$LL.admin_dr_backup_passphrase()}</span>
					<input
						class="admin-input"
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
						class="admin-input"
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
	</AdminSection>
</AdminPageShell>

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
	.dr-panel,
	.certificate-export-preview,
	.certificate-detail-modal,
	.modal-header,
	.modal-body,
	.modal-footer,
	.certificate-info-grid,
	.fingerprint-grid,
	.field-copy-row,
	.selected-destination,
	.certificate-textarea {
		box-sizing: border-box;
		min-width: 0;
	}

	.dr-panel {
		background: var(--settings-panel-bg, var(--color-surface));
		border: var(--settings-panel-border, 1px solid var(--color-border));
		border-radius: var(--settings-panel-radius, var(--radius-panel));
		padding: var(--settings-panel-padding, 1.5rem);
		color: var(--color-text);
		box-shadow: var(--settings-panel-shadow, var(--card-shadow, none));
	}

	.tenant-backup-panel,
	.tenant-backup-action-card,
	.tenant-backup-detail,
	.restore-preview-summary {
		display: grid;
		gap: 1rem;
	}

	.tenant-backup-scope,
	.tenant-backup-history-header,
	.operation-actions {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
	}

	.tenant-backup-scope p,
	.tenant-backup-history-header p,
	.tenant-backup-action-card p,
	.scope-note,
	.operation-progress {
		margin: 0.25rem 0 0;
		color: var(--color-text-secondary);
	}

	.operation-state {
		display: inline-flex;
		border-radius: 999px;
		padding: 0.25rem 0.65rem;
		background: var(
			--color-primary-soft,
			color-mix(in srgb, var(--color-primary) 12%, transparent)
		);
		color: var(--color-primary);
		font-size: 0.8rem;
		font-weight: 650;
		white-space: nowrap;
	}

	.tenant-backup-actions-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 1rem;
	}

	.tenant-backup-selection-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 0.75rem 1rem;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md, 0.75rem);
		padding: 1rem;
	}

	.tenant-backup-selection-grid label {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.tenant-backup-selection-grid .tenant-backup-period {
		display: grid;
		grid-template-columns: auto minmax(8rem, 1fr);
	}

	.tenant-backup-admin-mapping {
		display: grid;
		gap: 0.75rem;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md, 0.75rem);
		padding: 1rem;
	}

	.tenant-backup-admin-mapping p {
		margin: 0;
		color: var(--color-text-secondary);
	}

	.tenant-backup-admin-mapping code {
		word-break: break-all;
	}

	.tenant-backup-action-card,
	.tenant-backup-detail {
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md, 0.75rem);
		padding: 1rem;
	}

	.operation-selection,
	.restore-preview-datasets {
		color: var(--color-text-muted);
		font-size: 0.8125rem;
	}

	.operation-selection ul,
	.restore-preview-datasets ul {
		margin: 0.5rem 0 0;
		padding-left: 1.25rem;
	}

	.restore-preview-datasets summary {
		cursor: pointer;
		font-weight: 600;
	}

	.restore-preview-datasets ul {
		max-height: 14rem;
		overflow-y: auto;
	}

	.tenant-backup-action-card h3,
	.tenant-backup-history-header h3 {
		margin: 0;
	}

	.tenant-backup-action-card label {
		display: grid;
		gap: 0.4rem;
	}

	.operation-actions {
		justify-content: flex-start;
		flex-wrap: wrap;
	}

	@media (max-width: 760px) {
		.tenant-backup-actions-grid,
		.tenant-backup-selection-grid {
			grid-template-columns: 1fr;
		}

		.tenant-backup-scope,
		.tenant-backup-history-header {
			align-items: flex-start;
			flex-direction: column;
		}
	}

	.sensitive-badge {
		border: var(--settings-badge-border, 1px solid transparent);
		border-radius: var(--settings-badge-radius, 999px);
		background: color-mix(in srgb, var(--color-warning) 14%, transparent);
		color: var(--color-warning);
		font-size: var(--settings-badge-size, 0.75rem);
		font-weight: 700;
		letter-spacing: var(--settings-badge-letter-spacing, 0);
		padding: var(--settings-badge-padding, 0.25rem 0.625rem);
		white-space: nowrap;
	}

	.form-group {
		margin-bottom: 1rem;
	}

	.form-label {
		display: block;
		font-size: 0.875rem;
		font-weight: 500;
		color: var(--color-text);
		margin-bottom: 0.5rem;
	}

	.form-error {
		color: var(--color-danger);
		font-size: 0.8125rem;
		margin-top: 0.5rem;
	}

	.warning-box {
		display: flex;
		align-items: flex-start;
		gap: 0.5rem;
		border: 1px solid color-mix(in srgb, var(--color-warning) 32%, var(--color-border));
		border-radius: var(--radius-control);
		background: color-mix(in srgb, var(--color-warning) 10%, var(--color-surface));
		color: var(--color-text-muted);
		font-size: 0.8125rem;
		line-height: 1.45;
		padding: 0.75rem;
	}

	.warning-box i {
		color: var(--color-warning);
		flex: 0 0 auto;
		margin-top: 0.125rem;
	}

	.certificate-export-preview {
		margin-top: 1rem;
		border: var(--settings-card-border, 1px solid var(--color-border));
		border-radius: var(--settings-card-radius, var(--radius-panel));
		background: var(--settings-card-bg, var(--color-surface-muted));
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
		color: var(--color-text);
		font-size: 0.9375rem;
		font-weight: 700;
	}

	.certificate-export-header p,
	.empty-certificate-state {
		margin: 0;
		color: var(--color-text-muted);
		font-size: 0.8125rem;
		line-height: 1.45;
	}

	.certificate-slot-cell strong,
	.certificate-slot-cell span {
		display: block;
	}

	.certificate-slot-cell strong {
		color: var(--color-text);
	}

	.certificate-key-ref {
		display: inline-block;
		max-width: 220px;
		overflow: hidden;
		color: var(--color-text);
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
		color: var(--color-text);
		font-size: 0.875rem;
		font-weight: 600;
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
		background: var(--color-overlay-scrim);
	}

	.certificate-detail-modal {
		width: min(920px, 100%);
		max-height: min(92vh, 820px);
		display: grid;
		grid-template-rows: auto minmax(0, 1fr) auto;
		overflow: hidden;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-panel);
		background: var(--color-surface);
		box-shadow: var(--modal-shadow, var(--shadow-panel));
	}

	.modal-header,
	.modal-footer {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 1rem;
		padding: 1rem 1.25rem;
		border-bottom: 1px solid var(--color-border);
	}

	.modal-header h2 {
		margin: 0 0 0.25rem;
		color: var(--color-text);
		font-size: 1rem;
	}

	.modal-header p {
		margin: 0;
		color: var(--color-text-muted);
		font-size: 0.8125rem;
	}

	.modal-body {
		overflow-y: auto;
		padding: 1.25rem;
	}

	.modal-footer {
		justify-content: flex-end;
		border-top: 1px solid var(--color-border);
		border-bottom: 0;
	}

	.icon-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-control);
		background: transparent;
		color: var(--color-text-muted);
		cursor: pointer;
		flex: 0 0 auto;
	}

	.icon-btn:hover {
		background: var(--color-surface-muted);
		color: var(--color-text);
	}

	.icon-btn.copied {
		border-color: var(--color-success);
		color: var(--color-success);
	}

	.modal-alert {
		border: 1px solid color-mix(in srgb, var(--color-accent) 32%, var(--color-border));
		border-radius: var(--radius-control);
		background: color-mix(in srgb, var(--color-accent) 10%, var(--color-surface));
		color: var(--color-text-muted);
		font-size: 0.8125rem;
		padding: 0.75rem;
	}

	.modal-alert.error {
		border-color: color-mix(in srgb, var(--color-danger) 32%, var(--color-border));
		background: color-mix(in srgb, var(--color-danger) 10%, var(--color-surface));
		color: var(--color-danger);
	}

	.certificate-info-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 0.75rem;
	}

	.certificate-info-grid div,
	.fingerprint-grid div {
		min-width: 0;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-control);
		background: var(--color-surface-muted);
		padding: 0.75rem;
	}

	.certificate-info-grid span,
	.fingerprint-grid span {
		display: block;
		margin-bottom: 0.25rem;
		color: var(--color-text-muted);
		font-size: 0.75rem;
		font-weight: 700;
	}

	.certificate-info-grid strong,
	.fingerprint-grid code {
		color: var(--color-text);
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
		color: var(--color-warning);
		font-size: 0.8125rem;
	}

	.certificate-pem {
		margin-top: 1rem;
	}

	.certificate-pem summary {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		color: var(--color-text);
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
		border: 1px solid var(--color-border);
		border-radius: var(--radius-control);
		background: var(--color-surface);
		color: var(--color-text);
		font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
		font-size: 0.75rem;
		resize: vertical;
	}

	.hidden-file-input {
		display: none;
	}

	.selected-destination {
		border: var(--settings-card-border, 1px solid var(--color-border));
		border-radius: var(--settings-card-radius, var(--radius-control));
		padding: 0.75rem;
		background: var(--settings-card-bg, var(--color-surface-muted));
	}

	.destination-name {
		font-weight: 600;
		color: var(--color-text);
	}

	.destination-meta {
		font-size: 0.8125rem;
		color: var(--color-text-muted);
		margin-top: 0.25rem;
	}

	@media (max-width: 720px) {
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
