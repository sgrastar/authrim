<script lang="ts">
	import { onMount } from 'svelte';
	import {
		adminSigningKeysAPI,
		type SigningKeysStatus,
		type KeyStatus
	} from '$lib/api/admin-signing-keys';
	import { Modal } from '$lib/components';
	import { LL } from '$i18n/i18n-svelte';

	// State
	let keysStatus = $state<SigningKeysStatus | null>(null);
	let loading = $state(true);
	let error = $state('');
	let successMessage = $state('');

	// Rotation state
	let rotating = $state(false);
	let showEmergencyDialog = $state(false);
	let emergencyReason = $state('');
	let emergencyError = $state('');

	// Confirmation dialog for normal rotation
	let showNormalRotationDialog = $state(false);

	// Load data on mount
	onMount(async () => {
		await loadData();
	});

	async function loadData() {
		loading = true;
		error = '';

		try {
			keysStatus = await adminSigningKeysAPI.getStatus();
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_signing_keys_error_load();
		} finally {
			loading = false;
		}
	}

	// Normal rotation
	async function performNormalRotation() {
		rotating = true;
		error = '';
		successMessage = '';

		try {
			const result = await adminSigningKeysAPI.rotate();
			successMessage = result.message;
			showNormalRotationDialog = false;

			// Reload data
			await loadData();

			// Clear success message after 5 seconds
			setTimeout(() => {
				successMessage = '';
			}, 5000);
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_signing_keys_error_rotate();
		} finally {
			rotating = false;
		}
	}

	// Emergency rotation
	async function performEmergencyRotation() {
		if (emergencyReason.trim().length < 10) {
			emergencyError = $LL.admin_signing_keys_reason_min_error();
			return;
		}

		rotating = true;
		emergencyError = '';
		error = '';
		successMessage = '';

		try {
			const result = await adminSigningKeysAPI.emergencyRotate(emergencyReason);
			successMessage = result.message;
			showEmergencyDialog = false;
			emergencyReason = '';

			// Reload data
			await loadData();

			// Clear success message after 5 seconds
			setTimeout(() => {
				successMessage = '';
			}, 5000);
		} catch (err) {
			emergencyError =
				err instanceof Error ? err.message : $LL.admin_signing_keys_error_emergency();
		} finally {
			rotating = false;
		}
	}

	// Get status badge class
	function getStatusBadgeClass(status: KeyStatus): string {
		switch (status) {
			case 'active':
				return 'key-status-badge active';
			case 'overlap':
				return 'key-status-badge overlap';
			case 'revoked':
				return 'key-status-badge revoked';
			default:
				return 'key-status-badge default';
		}
	}

	// Get status badge text
	function getStatusBadgeText(status: KeyStatus): string {
		switch (status) {
			case 'active':
				return $LL.admin_signing_keys_status_active();
			case 'overlap':
				return $LL.admin_signing_keys_status_overlap();
			case 'revoked':
				return $LL.admin_signing_keys_status_revoked();
			default:
				return status;
		}
	}

	// Format date
	function formatDate(dateString: string): string {
		const date = new Date(dateString);
		return date.toLocaleString();
	}
</script>

<svelte:head>
	<title>{$LL.admin_signing_keys_page_title()}</title>
</svelte:head>

<div class="signing-keys-page">
	<!-- Back link and header -->
	<div class="settings-detail-header">
		<a href="/admin/settings" class="back-link">← {$LL.admin_signing_keys_back()}</a>
		<h1 class="page-title">{$LL.admin_signing_keys_title()}</h1>
		<p class="page-description">{$LL.admin_signing_keys_description()}</p>
	</div>

	<!-- Error message -->
	{#if error}
		<div class="alert alert-error">{error}</div>
	{/if}

	<!-- Success message -->
	{#if successMessage}
		<div class="alert alert-success">{successMessage}</div>
	{/if}

	{#if loading}
		<div class="loading-state">
			<p class="text-secondary">{$LL.admin_signing_keys_loading()}</p>
		</div>
	{:else if keysStatus}
		{@const activeKey = keysStatus.keys.find((k) => k.kid === keysStatus!.activeKeyId)}
		<!-- Current Active Key -->
		<div class="key-info-card">
			<h2>{$LL.admin_signing_keys_current_active()}</h2>
			{#if activeKey}
				<div class="key-info-grid">
					<div class="key-info-item">
						<p class="key-info-label">{$LL.admin_signing_keys_key_id()}</p>
						<p class="key-info-value mono">{activeKey.kid}</p>
					</div>
					<div class="key-info-item">
						<p class="key-info-label">{$LL.admin_signing_keys_algorithm()}</p>
						<p class="key-info-value">{activeKey.algorithm}</p>
					</div>
					<div class="key-info-item">
						<p class="key-info-label">{$LL.admin_signing_keys_created()}</p>
						<p class="key-info-value">{formatDate(activeKey.createdAt)}</p>
					</div>
					<div class="key-info-item">
						<p class="key-info-label">{$LL.admin_signing_keys_status()}</p>
						<span class={getStatusBadgeClass(activeKey.status)}>
							● {getStatusBadgeText(activeKey.status)}
						</span>
					</div>
				</div>
			{:else}
				<p class="text-secondary">{$LL.admin_signing_keys_no_active()}</p>
			{/if}
		</div>

		<!-- Key Rotation -->
		<div class="rotation-section">
			<h2>{$LL.admin_signing_keys_rotation()}</h2>

			<div class="rotation-grid">
				<!-- Normal Rotation -->
				<div class="rotation-card">
					<h3>{$LL.admin_signing_keys_normal_rotation()}</h3>
					<p>
						{$LL.admin_signing_keys_normal_desc()}
					</p>
					<button
						onclick={() => (showNormalRotationDialog = true)}
						disabled={rotating}
						class="btn btn-primary"
					>
						{$LL.admin_signing_keys_rotate()}
					</button>
				</div>

				<!-- Emergency Rotation -->
				<div class="rotation-card emergency">
					<h3>⚠️ {$LL.admin_signing_keys_emergency_rotation()}</h3>
					<p>
						{$LL.admin_signing_keys_emergency_desc()}
					</p>
					<button
						onclick={() => (showEmergencyDialog = true)}
						disabled={rotating}
						class="btn btn-danger"
					>
						{$LL.admin_signing_keys_emergency_rotate()}
					</button>
				</div>
			</div>
		</div>

		<!-- Key History -->
		<div class="key-history-section">
			<h2>{$LL.admin_signing_keys_history()}</h2>
			{#if keysStatus.keys.length > 0}
				<div class="table-container">
					<table class="key-history-table">
						<thead>
							<tr>
								<th>{$LL.admin_signing_keys_key_id()}</th>
								<th>{$LL.admin_signing_keys_algorithm()}</th>
								<th>{$LL.admin_signing_keys_status()}</th>
								<th>{$LL.admin_signing_keys_created()}</th>
								<th>{$LL.admin_signing_keys_revoked_at()}</th>
							</tr>
						</thead>
						<tbody>
							{#each keysStatus.keys as key (key.kid)}
								<tr>
									<td class="mono">
										{key.kid.length > 20 ? key.kid.slice(0, 20) + '...' : key.kid}
									</td>
									<td>{key.algorithm}</td>
									<td>
										<span class={getStatusBadgeClass(key.status)}>
											{getStatusBadgeText(key.status)}
										</span>
									</td>
									<td>{formatDate(key.createdAt)}</td>
									<td>{key.revokedAt ? formatDate(key.revokedAt) : '-'}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{:else}
				<p class="text-secondary">{$LL.admin_signing_keys_no_history()}</p>
			{/if}
		</div>
	{/if}
</div>

<!-- Normal Rotation Confirmation Dialog -->
<Modal
	open={showNormalRotationDialog}
	onClose={() => (showNormalRotationDialog = false)}
	title={$LL.admin_signing_keys_confirm_title()}
	size="sm"
>
	<p class="text-secondary">
		{$LL.admin_signing_keys_confirm_desc()}
	</p>

	{#snippet footer()}
		<button
			onclick={() => (showNormalRotationDialog = false)}
			disabled={rotating}
			class="btn btn-secondary"
		>
			{$LL.admin_signing_keys_cancel()}
		</button>
		<button onclick={performNormalRotation} disabled={rotating} class="btn btn-primary">
			{rotating ? $LL.admin_signing_keys_rotating() : $LL.admin_signing_keys_confirm_rotation()}
		</button>
	{/snippet}
</Modal>

<!-- Emergency Rotation Dialog -->
<Modal
	open={showEmergencyDialog}
	onClose={() => {
		showEmergencyDialog = false;
		emergencyReason = '';
		emergencyError = '';
	}}
	title={$LL.admin_signing_keys_emergency_dialog_title()}
	size="md"
>
	<div class="rotation-dialog-warning">
		<p>
			<strong>{$LL.admin_signing_keys_warning()}</strong>
			{$LL.admin_signing_keys_emergency_warning()}
		</p>
	</div>
	<div class="form-group">
		<label for="emergency-reason" class="rotation-reason-label">
			{$LL.admin_signing_keys_reason_label()}
		</label>
		<textarea
			id="emergency-reason"
			bind:value={emergencyReason}
			placeholder={$LL.admin_signing_keys_reason_placeholder()}
			class="rotation-reason-textarea"
		></textarea>
		<p class="rotation-char-count">
			{$LL.admin_signing_keys_reason_count({ count: emergencyReason.trim().length })}
		</p>
	</div>
	{#if emergencyError}
		<div class="alert alert-error">{emergencyError}</div>
	{/if}

	{#snippet footer()}
		<button
			onclick={() => {
				showEmergencyDialog = false;
				emergencyReason = '';
				emergencyError = '';
			}}
			disabled={rotating}
			class="btn btn-secondary"
		>
			{$LL.admin_signing_keys_cancel()}
		</button>
		<button
			onclick={performEmergencyRotation}
			disabled={rotating || emergencyReason.trim().length < 10}
			class="btn btn-danger"
		>
			{rotating ? $LL.admin_signing_keys_rotating() : $LL.admin_signing_keys_emergency_rotate()}
		</button>
	{/snippet}
</Modal>
