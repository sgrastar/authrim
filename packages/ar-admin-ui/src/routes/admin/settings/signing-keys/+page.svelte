<script lang="ts">
	import { onMount } from 'svelte';
	import {
		adminSigningKeysAPI,
		type SigningKeysStatus,
		type KeyStatus
	} from '$lib/api/admin-signing-keys';
	import { Modal } from '$lib/components';
	import {
		AdminDataTable,
		AdminPageHeader,
		AdminPageShell,
		AdminSection
	} from '$lib/components/admin';
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
			await adminSigningKeysAPI.rotate();
			successMessage = $LL.admin_signing_keys_rotated();
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
			await adminSigningKeysAPI.emergencyRotate(emergencyReason);
			successMessage = $LL.admin_signing_keys_emergency_rotated();
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
				return 'status-pill status-pill--active';
			case 'overlap':
				return 'status-pill status-pill--overlap';
			case 'revoked':
				return 'status-pill status-pill--revoked';
			default:
				return 'status-pill';
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

<AdminPageShell>
	<a href="/admin/settings" class="back-link">
		<i class="i-ph-arrow-left"></i>
		{$LL.admin_signing_keys_back()}
	</a>
	<AdminPageHeader
		title={$LL.admin_signing_keys_title()}
		description={$LL.admin_signing_keys_description()}
	/>

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
			<i class="i-ph-spinner loading-spinner"></i>
			<p>{$LL.admin_signing_keys_loading()}</p>
		</div>
	{:else if keysStatus}
		{@const activeKey = keysStatus.keys.find((k) => k.kid === keysStatus!.activeKeyId)}
		<!-- Current Active Key -->
		<AdminSection title={$LL.admin_signing_keys_current_active()}>
			{#if activeKey}
				<div class="key-info-card">
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
				<div class="empty-state">{$LL.admin_signing_keys_no_active()}</div>
			{/if}
		</AdminSection>

		<!-- Key Rotation -->
		<AdminSection title={$LL.admin_signing_keys_rotation()}>
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
					<h3>
						<i class="i-ph-warning-circle"></i>
						{$LL.admin_signing_keys_emergency_rotation()}
					</h3>
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
		</AdminSection>

		<!-- Key History -->
		<AdminSection title={$LL.admin_signing_keys_history()}>
			{#if keysStatus.keys.length > 0}
				<AdminDataTable>
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
				</AdminDataTable>
			{:else}
				<div class="empty-state">{$LL.admin_signing_keys_no_history()}</div>
			{/if}
		</AdminSection>
	{/if}
</AdminPageShell>

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
	<div class="admin-field rotation-reason-field">
		<label for="emergency-reason" class="admin-field__label rotation-reason-label">
			{$LL.admin_signing_keys_reason_label()}
		</label>
		<textarea
			id="emergency-reason"
			bind:value={emergencyReason}
			placeholder={$LL.admin_signing_keys_reason_placeholder()}
			class="admin-input rotation-reason-textarea"
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

<style>
	.back-link {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		width: fit-content;
		margin-bottom: 1rem;
		color: var(--color-text-muted);
		font-size: 0.85rem;
		font-weight: 700;
		text-decoration: none;
	}

	.back-link:hover,
	.back-link:focus-visible {
		color: var(--color-accent);
	}

	.back-link :global(i) {
		width: 1rem;
		height: 1rem;
	}

	.alert {
		margin-bottom: 1rem;
		padding: 0.85rem 1rem;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-panel, var(--radius-md));
		background: var(--color-surface);
		color: var(--color-text);
		box-shadow: var(--shadow-sm);
	}

	.alert-error {
		border-color: color-mix(in srgb, var(--color-danger) 30%, var(--color-border));
		background: color-mix(in srgb, var(--color-danger) 9%, var(--color-surface));
		color: var(--color-danger);
	}

	.alert-success {
		border-color: color-mix(in srgb, var(--color-success) 30%, var(--color-border));
		background: color-mix(in srgb, var(--color-success) 10%, var(--color-surface));
		color: var(--color-success);
	}

	.loading-state,
	.empty-state {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.65rem;
		min-height: 8rem;
		padding: 1.5rem;
		border: 1px dashed var(--color-border);
		border-radius: var(--radius-panel, var(--radius-md));
		background: var(--color-surface);
		color: var(--color-text-muted);
	}

	.loading-state p {
		margin: 0;
	}

	.loading-spinner {
		width: 1.2rem;
		height: 1.2rem;
		animation: spin 0.8s linear infinite;
	}

	.key-info-card {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
		gap: 1rem;
		padding: 1rem;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-panel, var(--radius-md));
		background: var(--color-surface);
		box-shadow: var(--shadow-sm);
	}

	.key-info-item {
		min-width: 0;
	}

	.key-info-label {
		margin: 0 0 0.3rem;
		color: var(--color-text-muted);
		font-family: var(--font-meta, var(--font-body));
		font-size: 0.7rem;
		font-weight: 700;
		text-transform: uppercase;
	}

	.key-info-value {
		margin: 0;
		color: var(--color-text);
		font-size: 0.9rem;
		font-weight: 700;
		word-break: break-word;
	}

	.mono {
		font-family: var(--font-mono);
	}

	.status-pill {
		display: inline-flex;
		align-items: center;
		width: fit-content;
		padding: 0.15rem 0.5rem;
		border-radius: 999px;
		background: var(--color-surface-raised);
		color: var(--color-text-muted);
		font-size: 0.74rem;
		font-weight: 800;
	}

	.status-pill--active {
		background: color-mix(in srgb, var(--color-success) 14%, transparent);
		color: var(--color-success);
	}

	.status-pill--overlap {
		background: color-mix(in srgb, var(--color-warning) 14%, transparent);
		color: var(--color-warning);
	}

	.status-pill--revoked {
		background: color-mix(in srgb, var(--color-danger) 14%, transparent);
		color: var(--color-danger);
	}

	.rotation-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
		gap: 1rem;
	}

	.rotation-card {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.85rem;
		padding: 1rem;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-panel, var(--radius-md));
		background: var(--color-surface);
		box-shadow: var(--shadow-sm);
	}

	.rotation-card h3 {
		display: inline-flex;
		align-items: center;
		gap: 0.45rem;
		margin: 0;
		color: var(--color-text);
		font-size: 0.95rem;
	}

	.rotation-card h3 :global(i) {
		width: 1rem;
		height: 1rem;
	}

	.rotation-card p {
		margin: 0;
		color: var(--color-text-muted);
		font-size: 0.85rem;
		line-height: 1.65;
	}

	.rotation-card.emergency {
		border-color: color-mix(in srgb, var(--color-danger) 34%, var(--color-border));
		background: color-mix(in srgb, var(--color-danger) 7%, var(--color-surface));
	}

	.rotation-card.emergency h3 {
		color: var(--color-danger);
	}

	.rotation-dialog-warning {
		margin-bottom: 1rem;
		padding: 0.9rem 1rem;
		border: 1px solid color-mix(in srgb, var(--color-warning) 32%, var(--color-border));
		border-radius: var(--radius-panel, var(--radius-md));
		background: color-mix(in srgb, var(--color-warning) 9%, var(--color-surface));
		color: var(--color-text);
	}

	.rotation-dialog-warning p,
	.rotation-char-count {
		margin: 0;
	}

	.rotation-reason-field {
		margin-bottom: 1rem;
	}

	.rotation-reason-textarea {
		min-height: 7rem;
		resize: vertical;
	}

	.rotation-char-count {
		margin-top: 0.35rem;
		color: var(--color-text-muted);
		font-size: 0.78rem;
	}

	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
</style>
