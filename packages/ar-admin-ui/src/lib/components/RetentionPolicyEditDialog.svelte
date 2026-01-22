<script lang="ts">
	import {
		adminDataRetentionAPI,
		getCategoryDisplayName,
		getCategoryDescription,
		type CleanupEstimate
	} from '$lib/api/admin-data-retention';

	interface Props {
		open: boolean;
		category: string | null;
		currentRetentionDays: number;
		onClose: () => void;
		onSave: (category: string, retentionDays: number) => Promise<void>;
	}

	let { open, category, currentRetentionDays, onClose, onSave }: Props = $props();

	// Form state
	let retentionDays = $state(currentRetentionDays);
	let loading = $state(false);
	let estimateLoading = $state(false);
	let error = $state<string | null>(null);
	let estimate = $state<CleanupEstimate | null>(null);

	// Reset state when dialog opens
	$effect(() => {
		if (open && category) {
			retentionDays = currentRetentionDays;
			error = null;
			estimate = null;
			loadEstimate();
		}
	});

	async function loadEstimate() {
		if (!category) return;

		estimateLoading = true;
		try {
			const result = await adminDataRetentionAPI.getEstimate(category);
			estimate = result.estimates.find((e) => e.category === category) || null;
		} catch {
			// Silent fail for estimate
		} finally {
			estimateLoading = false;
		}
	}

	async function handleSave() {
		if (!category || retentionDays < 1 || retentionDays > 3650) {
			error = 'Retention days must be between 1 and 3650 (10 years)';
			return;
		}

		loading = true;
		error = null;

		try {
			await onSave(category, retentionDays);
			onClose();
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to save retention policy';
		} finally {
			loading = false;
		}
	}

	function handleKeyDown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			onClose();
		}
	}

	// Preset values
	const presets = [
		{ label: '7 days', value: 7 },
		{ label: '30 days', value: 30 },
		{ label: '90 days', value: 90 },
		{ label: '1 year', value: 365 },
		{ label: '2 years', value: 730 },
		{ label: '5 years', value: 1825 }
	];
</script>

{#if open && category}
	<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
	<div
		class="dialog-overlay"
		role="dialog"
		aria-modal="true"
		aria-labelledby="dialog-title"
		onkeydown={handleKeyDown}
	>
		<div
			class="dialog-content"
			onclick={(e) => e.stopPropagation()}
			onkeydown={(e) => e.stopPropagation()}
			role="document"
		>
			<div class="dialog-header">
				<h2 id="dialog-title">Edit Retention Policy</h2>
				<button class="close-btn" onclick={onClose} aria-label="Close">
					<span>×</span>
				</button>
			</div>

			<div class="dialog-body">
				<!-- Category Info -->
				<div class="category-info">
					<h3>{getCategoryDisplayName(category)}</h3>
					<p>{getCategoryDescription(category)}</p>
				</div>

				{#if error}
					<div class="error-message">
						{error}
					</div>
				{/if}

				<!-- Retention Days Input -->
				<div class="form-group">
					<label for="retention-days">Retention Period (days)</label>
					<div class="input-row">
						<input
							id="retention-days"
							type="number"
							bind:value={retentionDays}
							min="1"
							max="3650"
							disabled={loading}
						/>
					</div>
					<p class="help-text">
						Records older than this will be eligible for deletion. Range: 1-3650 days (10 years)
					</p>
				</div>

				<!-- Presets -->
				<div class="presets">
					<span class="presets-label">Quick select:</span>
					<div class="presets-buttons">
						{#each presets as preset (preset.value)}
							<button
								class="preset-btn"
								class:active={retentionDays === preset.value}
								onclick={() => (retentionDays = preset.value)}
								disabled={loading}
							>
								{preset.label}
							</button>
						{/each}
					</div>
				</div>

				<!-- Estimate -->
				<div class="estimate-section">
					<h4>Impact Estimate</h4>
					{#if estimateLoading}
						<p class="loading-text">Loading estimate...</p>
					{:else if estimate}
						<div class="estimate-grid">
							<div class="estimate-item">
								<span class="label">Records to delete:</span>
								<span class="value">{estimate.records_to_delete.toLocaleString()}</span>
							</div>
							{#if estimate.oldest_record_date}
								<div class="estimate-item">
									<span class="label">Oldest record:</span>
									<span class="value">
										{new Date(estimate.oldest_record_date).toLocaleDateString()}
									</span>
								</div>
							{/if}
						</div>
					{:else}
						<p class="no-estimate">No estimate available</p>
					{/if}
				</div>

				<!-- Warning for short retention -->
				{#if retentionDays < 30}
					<div class="warning-message">
						<strong>Warning:</strong> Short retention periods may impact compliance requirements. Ensure
						this meets your organization's data retention policies.
					</div>
				{/if}
			</div>

			<div class="dialog-footer">
				<button class="btn btn-secondary" onclick={onClose} disabled={loading}> Cancel </button>
				<button
					class="btn btn-primary"
					onclick={handleSave}
					disabled={loading || retentionDays < 1 || retentionDays > 3650}
				>
					{loading ? 'Saving...' : 'Save Changes'}
				</button>
			</div>
		</div>
	</div>
{/if}

<style>
	.dialog-overlay {
		position: fixed;
		inset: 0;
		background-color: rgba(0, 0, 0, 0.5);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 1000;
	}

	.dialog-content {
		background: white;
		border-radius: 8px;
		box-shadow:
			0 20px 25px -5px rgba(0, 0, 0, 0.1),
			0 10px 10px -5px rgba(0, 0, 0, 0.04);
		max-width: 480px;
		width: 90%;
		max-height: 85vh;
		display: flex;
		flex-direction: column;
	}

	.dialog-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 16px 20px;
		border-bottom: 1px solid #e5e7eb;
	}

	.dialog-header h2 {
		margin: 0;
		font-size: 18px;
		font-weight: 600;
		color: #111827;
	}

	.close-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 32px;
		height: 32px;
		background: none;
		border: none;
		border-radius: 6px;
		cursor: pointer;
		color: #6b7280;
		font-size: 24px;
		line-height: 1;
	}

	.close-btn:hover {
		background-color: #f3f4f6;
		color: #374151;
	}

	.dialog-body {
		flex: 1;
		overflow-y: auto;
		padding: 20px;
	}

	.category-info {
		margin-bottom: 20px;
		padding-bottom: 16px;
		border-bottom: 1px solid #e5e7eb;
	}

	.category-info h3 {
		margin: 0 0 4px 0;
		font-size: 16px;
		font-weight: 600;
		color: #1f2937;
	}

	.category-info p {
		margin: 0;
		font-size: 14px;
		color: #6b7280;
	}

	.error-message {
		background-color: #fee2e2;
		border: 1px solid #ef4444;
		color: #b91c1c;
		padding: 12px;
		border-radius: 6px;
		margin-bottom: 16px;
		font-size: 14px;
	}

	.form-group {
		margin-bottom: 20px;
	}

	.form-group label {
		display: block;
		font-size: 14px;
		font-weight: 500;
		color: #374151;
		margin-bottom: 8px;
	}

	.input-row {
		display: flex;
		gap: 12px;
	}

	.input-row input {
		flex: 1;
		padding: 10px 12px;
		border: 1px solid #d1d5db;
		border-radius: 6px;
		font-size: 14px;
	}

	.input-row input:focus {
		outline: none;
		border-color: #2563eb;
		box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.1);
	}

	.help-text {
		margin: 8px 0 0 0;
		font-size: 12px;
		color: #6b7280;
	}

	.presets {
		margin-bottom: 20px;
	}

	.presets-label {
		display: block;
		font-size: 12px;
		color: #6b7280;
		margin-bottom: 8px;
	}

	.presets-buttons {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}

	.preset-btn {
		padding: 6px 12px;
		background-color: #f3f4f6;
		border: 1px solid #e5e7eb;
		border-radius: 4px;
		font-size: 12px;
		color: #374151;
		cursor: pointer;
		transition: all 0.15s;
	}

	.preset-btn:hover:not(:disabled) {
		background-color: #e5e7eb;
	}

	.preset-btn.active {
		background-color: #dbeafe;
		border-color: #3b82f6;
		color: #1e40af;
	}

	.preset-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.estimate-section {
		background-color: #f9fafb;
		border-radius: 6px;
		padding: 16px;
		margin-bottom: 16px;
	}

	.estimate-section h4 {
		margin: 0 0 12px 0;
		font-size: 14px;
		font-weight: 500;
		color: #374151;
	}

	.estimate-grid {
		display: grid;
		gap: 8px;
	}

	.estimate-item {
		display: flex;
		justify-content: space-between;
		font-size: 14px;
	}

	.estimate-item .label {
		color: #6b7280;
	}

	.estimate-item .value {
		font-weight: 500;
		color: #1f2937;
	}

	.loading-text,
	.no-estimate {
		font-size: 14px;
		color: #6b7280;
		margin: 0;
	}

	.warning-message {
		background-color: #fef3c7;
		border: 1px solid #f59e0b;
		color: #92400e;
		padding: 12px;
		border-radius: 6px;
		font-size: 14px;
	}

	.dialog-footer {
		display: flex;
		justify-content: flex-end;
		gap: 12px;
		padding: 16px 20px;
		border-top: 1px solid #e5e7eb;
	}

	.btn {
		padding: 10px 20px;
		border-radius: 6px;
		font-size: 14px;
		font-weight: 500;
		cursor: pointer;
		transition: all 0.15s;
	}

	.btn-secondary {
		background-color: white;
		border: 1px solid #d1d5db;
		color: #374151;
	}

	.btn-secondary:hover:not(:disabled) {
		background-color: #f9fafb;
	}

	.btn-primary {
		background-color: #2563eb;
		border: 1px solid #2563eb;
		color: white;
	}

	.btn-primary:hover:not(:disabled) {
		background-color: #1d4ed8;
	}

	.btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
</style>
