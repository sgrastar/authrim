<script lang="ts">
	import Modal from './Modal.svelte';
	import { adminDataRetentionAPI, type CleanupEstimate } from '$lib/api/admin-data-retention';
	import { LL } from '$i18n/i18n-svelte';

	interface Props {
		open: boolean;
		category: string | null;
		currentRetentionDays: number;
		onClose: () => void;
		onSave: (category: string, retentionDays: number) => Promise<void>;
	}

	let { open, category, currentRetentionDays, onClose, onSave }: Props = $props();

	// Form state - initialized in effect when dialog opens
	let retentionDays = $state(0);
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
			error = $LL.admin_compliance_retention_days_invalid();
			return;
		}

		loading = true;
		error = null;

		try {
			await onSave(category, retentionDays);
			onClose();
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_compliance_save_failed();
		} finally {
			loading = false;
		}
	}

	// Preset values
	const presets = [
		{ getLabel: () => $LL.admin_compliance_preset_7_days(), value: 7 },
		{ getLabel: () => $LL.admin_compliance_preset_30_days(), value: 30 },
		{ getLabel: () => $LL.admin_compliance_preset_90_days(), value: 90 },
		{ getLabel: () => $LL.admin_compliance_preset_1_year(), value: 365 },
		{ getLabel: () => $LL.admin_compliance_preset_2_years(), value: 730 },
		{ getLabel: () => $LL.admin_compliance_preset_5_years(), value: 1825 }
	];

	function getCategoryDisplayName(category: string): string {
		switch (category) {
			case 'audit_logs':
				return $LL.admin_compliance_category_audit_logs();
			case 'session_data':
				return $LL.admin_compliance_category_session_data();
			case 'tombstones':
				return $LL.admin_compliance_category_tombstones();
			case 'auth_codes':
				return $LL.admin_compliance_category_auth_codes();
			case 'refresh_tokens':
				return $LL.admin_compliance_category_refresh_tokens();
			case 'access_tokens':
				return $LL.admin_compliance_category_access_tokens();
			default:
				return category.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase());
		}
	}

	function getCategoryDescription(category: string): string {
		switch (category) {
			case 'audit_logs':
				return $LL.admin_compliance_category_audit_logs_desc();
			case 'session_data':
				return $LL.admin_compliance_category_session_data_desc();
			case 'tombstones':
				return $LL.admin_compliance_category_tombstones_desc();
			case 'auth_codes':
				return $LL.admin_compliance_category_auth_codes_desc();
			case 'refresh_tokens':
				return $LL.admin_compliance_category_refresh_tokens_desc();
			case 'access_tokens':
				return $LL.admin_compliance_category_access_tokens_desc();
			default:
				return $LL.admin_compliance_category_unknown_desc();
		}
	}
</script>

{#if category}
	<Modal
		open={open && !!category}
		{onClose}
		title={$LL.admin_compliance_edit_retention_title()}
		size="md"
	>
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
			<label for="retention-days">{$LL.admin_compliance_retention_period_days()}</label>
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
				{$LL.admin_compliance_retention_help()}
			</p>
		</div>

		<!-- Presets -->
		<div class="presets">
			<span class="presets-label">{$LL.admin_compliance_quick_select()}</span>
			<div class="presets-buttons">
				{#each presets as preset (preset.value)}
					<button
						class="preset-btn"
						class:active={retentionDays === preset.value}
						onclick={() => (retentionDays = preset.value)}
						disabled={loading}
					>
						{preset.getLabel()}
					</button>
				{/each}
			</div>
		</div>

		<!-- Estimate -->
		<div class="estimate-section">
			<h4>{$LL.admin_compliance_impact_estimate()}</h4>
			{#if estimateLoading}
				<p class="loading-text">{$LL.admin_compliance_loading_estimate()}</p>
			{:else if estimate}
				<div class="estimate-grid">
					<div class="estimate-item">
						<span class="label">{$LL.admin_compliance_records_to_delete()}</span>
						<span class="value">{estimate.records_to_delete.toLocaleString()}</span>
					</div>
					{#if estimate.oldest_record_date}
						<div class="estimate-item">
							<span class="label">{$LL.admin_compliance_oldest_record_label()}</span>
							<span class="value">
								{new Date(estimate.oldest_record_date).toLocaleDateString()}
							</span>
						</div>
					{/if}
				</div>
			{:else}
				<p class="no-estimate">{$LL.admin_compliance_no_estimate()}</p>
			{/if}
		</div>

		<!-- Warning for short retention -->
		{#if retentionDays < 30}
			<div class="warning-message">
				<strong>{$LL.admin_compliance_short_retention_warning_title()}</strong>
				{$LL.admin_compliance_short_retention_warning()}
			</div>
		{/if}

		{#snippet footer()}
			<button class="btn btn-secondary" onclick={onClose} disabled={loading}>
				{$LL.admin_compliance_cancel()}
			</button>
			<button
				class="btn btn-primary"
				onclick={handleSave}
				disabled={loading || retentionDays < 1 || retentionDays > 3650}
			>
				{loading ? $LL.admin_compliance_saving() : $LL.admin_compliance_save_changes()}
			</button>
		{/snippet}
	</Modal>
{/if}

<style>
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
