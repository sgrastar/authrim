<script lang="ts">
	import { onMount } from 'svelte';
	import {
		adminSigningKeysAPI,
		type SigningKeysStatus,
		type KeyStatus
	} from '$lib/api/admin-signing-keys';

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
			error = err instanceof Error ? err.message : 'Failed to load signing keys status';
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
			error = err instanceof Error ? err.message : 'Failed to rotate signing keys';
		} finally {
			rotating = false;
		}
	}

	// Emergency rotation
	async function performEmergencyRotation() {
		if (emergencyReason.trim().length < 10) {
			emergencyError = 'Reason must be at least 10 characters';
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
			emergencyError = err instanceof Error ? err.message : 'Failed to perform emergency rotation';
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
				return 'Active';
			case 'overlap':
				return 'Overlap';
			case 'revoked':
				return 'Revoked';
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

<div class="signing-keys-page">
	<!-- Back link and header -->
	<div class="settings-detail-header">
		<a href="/admin/settings" class="back-link">← Back to Settings</a>
		<h1 class="page-title">Signing Keys</h1>
		<p class="page-description">Manage JWT signing keys for token issuance and rotation</p>
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
			<p class="text-secondary">Loading signing keys status...</p>
		</div>
	{:else if keysStatus}
		{@const activeKey = keysStatus.keys.find((k) => k.kid === keysStatus!.activeKeyId)}
		<!-- Current Active Key -->
		<div class="key-info-card">
			<h2>Current Active Key</h2>
			{#if activeKey}
				<div class="key-info-grid">
					<div class="key-info-item">
						<p class="key-info-label">Key ID</p>
						<p class="key-info-value mono">{activeKey.kid}</p>
					</div>
					<div class="key-info-item">
						<p class="key-info-label">Algorithm</p>
						<p class="key-info-value">{activeKey.algorithm}</p>
					</div>
					<div class="key-info-item">
						<p class="key-info-label">Created</p>
						<p class="key-info-value">{formatDate(activeKey.createdAt)}</p>
					</div>
					<div class="key-info-item">
						<p class="key-info-label">Status</p>
						<span class={getStatusBadgeClass(activeKey.status)}>
							● {getStatusBadgeText(activeKey.status)}
						</span>
					</div>
				</div>
			{:else}
				<p class="text-secondary">No active key found</p>
			{/if}
		</div>

		<!-- Key Rotation -->
		<div class="rotation-section">
			<h2>Key Rotation</h2>

			<div class="rotation-grid">
				<!-- Normal Rotation -->
				<div class="rotation-card">
					<h3>Normal Rotation</h3>
					<p>
						Creates a new signing key. The old key remains valid for 24 hours to allow existing
						tokens to be verified.
					</p>
					<button
						onclick={() => (showNormalRotationDialog = true)}
						disabled={rotating}
						class="btn btn-primary"
					>
						Rotate Key
					</button>
				</div>

				<!-- Emergency Rotation -->
				<div class="rotation-card emergency">
					<h3>⚠️ Emergency Rotation</h3>
					<p>
						Immediately revokes the current key. All existing tokens will become invalid. Use only
						in case of key compromise.
					</p>
					<button
						onclick={() => (showEmergencyDialog = true)}
						disabled={rotating}
						class="btn btn-danger"
					>
						Emergency Rotate
					</button>
				</div>
			</div>
		</div>

		<!-- Key History -->
		<div class="key-history-section">
			<h2>Key History</h2>
			{#if keysStatus.keys.length > 0}
				<div class="table-container">
					<table class="key-history-table">
						<thead>
							<tr>
								<th>Key ID</th>
								<th>Algorithm</th>
								<th>Status</th>
								<th>Created</th>
								<th>Revoked</th>
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
				<p class="text-secondary">No key history available</p>
			{/if}
		</div>
	{/if}
</div>

<!-- Normal Rotation Confirmation Dialog -->
{#if showNormalRotationDialog}
	<div
		class="modal-overlay"
		onclick={() => (showNormalRotationDialog = false)}
		onkeydown={(e) => e.key === 'Escape' && (showNormalRotationDialog = false)}
		role="button"
		tabindex="0"
	>
		<div
			class="modal-content modal-sm"
			onclick={(e) => e.stopPropagation()}
			onkeydown={(e) => e.stopPropagation()}
			role="dialog"
			aria-modal="true"
		>
			<div class="modal-header">
				<h2 class="modal-title">Confirm Key Rotation</h2>
			</div>
			<div class="modal-body">
				<p class="text-secondary">
					This will create a new signing key. The current key will remain valid for 24 hours to
					allow existing tokens to be verified.
				</p>
			</div>
			<div class="modal-footer">
				<button
					onclick={() => (showNormalRotationDialog = false)}
					disabled={rotating}
					class="btn btn-secondary"
				>
					Cancel
				</button>
				<button onclick={performNormalRotation} disabled={rotating} class="btn btn-primary">
					{rotating ? 'Rotating...' : 'Confirm Rotation'}
				</button>
			</div>
		</div>
	</div>
{/if}

<!-- Emergency Rotation Dialog -->
{#if showEmergencyDialog}
	<div
		class="modal-overlay"
		onclick={() => {
			showEmergencyDialog = false;
			emergencyReason = '';
			emergencyError = '';
		}}
		onkeydown={(e) => e.key === 'Escape' && (showEmergencyDialog = false)}
		role="button"
		tabindex="0"
	>
		<div
			class="modal-content"
			onclick={(e) => e.stopPropagation()}
			onkeydown={(e) => e.stopPropagation()}
			role="dialog"
			aria-modal="true"
		>
			<div class="modal-header">
				<h2 class="modal-title text-danger">⚠️ Emergency Key Rotation</h2>
			</div>
			<div class="modal-body">
				<div class="rotation-dialog-warning">
					<p>
						<strong>Warning:</strong> This will immediately revoke the current signing key. All existing
						tokens will become invalid. JWKS cache on edge nodes may take up to 60 seconds to refresh.
					</p>
				</div>
				<div class="form-group">
					<label for="emergency-reason" class="rotation-reason-label">
						Reason for emergency rotation (required)
					</label>
					<textarea
						id="emergency-reason"
						bind:value={emergencyReason}
						placeholder="Describe the reason for emergency rotation (min 10 characters)..."
						class="rotation-reason-textarea"
					></textarea>
					<p class="rotation-char-count">
						{emergencyReason.trim().length}/10 characters minimum
					</p>
				</div>
				{#if emergencyError}
					<div class="alert alert-error">{emergencyError}</div>
				{/if}
			</div>
			<div class="modal-footer">
				<button
					onclick={() => {
						showEmergencyDialog = false;
						emergencyReason = '';
						emergencyError = '';
					}}
					disabled={rotating}
					class="btn btn-secondary"
				>
					Cancel
				</button>
				<button
					onclick={performEmergencyRotation}
					disabled={rotating || emergencyReason.trim().length < 10}
					class="btn btn-danger"
				>
					{rotating ? 'Rotating...' : 'Emergency Rotate'}
				</button>
			</div>
		</div>
	</div>
{/if}
