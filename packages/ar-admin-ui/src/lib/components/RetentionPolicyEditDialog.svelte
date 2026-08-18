<script lang="ts">
	import Modal from './Modal.svelte';
	import { adminDataRetentionAPI, type CleanupEstimate } from '$lib/api/admin-data-retention';
	import { LL } from '$i18n/i18n-svelte';

	interface Props {
		open: boolean;
		category: string | null;
		currentRetentionDays: number;
		onClose: () => void;
		onSave: (
			category: string,
			retentionDays: number,
			confirmShortening: boolean,
			expectedCurrentRetentionDays: number
		) => Promise<void>;
	}

	let { open, category, currentRetentionDays, onClose, onSave }: Props = $props();

	// Form state - initialized in effect when dialog opens
	let retentionDays = $state(0);
	let loading = $state(false);
	let estimateLoading = $state(false);
	let error = $state<string | null>(null);
	let estimate = $state<CleanupEstimate | null>(null);
	let shorteningConfirmed = $state(false);
	let minimumRetentionDays = $derived(category === 'lookup_directory' ? 30 : 1);
	let isShortening = $derived(retentionDays < currentRetentionDays);

	// Reset state when dialog opens
	$effect(() => {
		if (open && category) {
			retentionDays = currentRetentionDays;
			error = null;
			estimate = null;
			shorteningConfirmed = false;
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
		if (
			!category ||
			retentionDays < minimumRetentionDays ||
			retentionDays > 3650 ||
			(isShortening && !shorteningConfirmed)
		) {
			error =
				isShortening && !shorteningConfirmed
					? $LL.admin_compliance_retention_shortening_confirmation_required()
					: category === 'lookup_directory'
						? $LL.admin_compliance_lookup_retention_days_invalid()
						: $LL.admin_compliance_retention_days_invalid();
			return;
		}

		loading = true;
		error = null;

		try {
			await onSave(category, retentionDays, shorteningConfirmed, currentRetentionDays);
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
			case 'lookup_directory':
				return $LL.admin_compliance_category_lookup_directory();
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
			case 'lookup_directory':
				return $LL.admin_compliance_category_lookup_directory_desc();
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
					min={minimumRetentionDays}
					max="3650"
					disabled={loading}
				/>
			</div>
			<p class="help-text">
				{category === 'lookup_directory'
					? $LL.admin_compliance_lookup_retention_help()
					: $LL.admin_compliance_retention_help()}
			</p>
		</div>

		<!-- Presets -->
		<div class="presets">
			<span class="presets-label">{$LL.admin_compliance_quick_select()}</span>
			<div class="presets-buttons">
				{#each presets.filter((preset) => preset.value >= minimumRetentionDays) as preset (preset.value)}
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

		{#if isShortening}
			<label class="shortening-confirmation">
				<input type="checkbox" bind:checked={shorteningConfirmed} disabled={loading} />
				<span>
					{$LL.admin_compliance_retention_shortening_confirm({
						current: currentRetentionDays,
						requested: retentionDays
					})}
				</span>
			</label>
		{/if}

		{#snippet footer()}
			<button class="btn btn-secondary" onclick={onClose} disabled={loading}>
				{$LL.admin_compliance_cancel()}
			</button>
			<button
				class="btn btn-primary"
				onclick={handleSave}
				disabled={loading ||
					retentionDays < minimumRetentionDays ||
					retentionDays > 3650 ||
					(isShortening && !shorteningConfirmed)}
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
		border-bottom: 1px solid var(--color-border);
	}

	.category-info h3 {
		margin: 0 0 4px 0;
		font-size: 16px;
		font-weight: var(--font-weight-semibold, 600);
		color: var(--color-heading, var(--color-text));
	}

	.category-info p {
		margin: 0;
		font-size: 14px;
		color: var(--color-text-muted);
	}

	.error-message {
		background: color-mix(in srgb, var(--color-danger) 12%, var(--color-surface));
		border: 1px solid color-mix(in srgb, var(--color-danger) 42%, var(--color-border));
		color: var(--color-danger);
		padding: 12px;
		border-radius: var(--radius-control, 6px);
		margin-bottom: 16px;
		font-size: 14px;
	}

	.form-group {
		margin-bottom: 20px;
	}

	.form-group label {
		display: block;
		font-size: 14px;
		font-weight: var(--form-label-weight, 500);
		color: var(--form-label-color, var(--color-text));
		margin-bottom: 8px;
	}

	.input-row {
		display: flex;
		gap: 12px;
	}

	.input-row input {
		flex: 1;
		min-height: var(--control-height, 40px);
		padding: var(--control-padding, 10px 12px);
		border: var(--control-border, 1px solid var(--color-border));
		border-radius: var(--radius-control, 6px);
		background: var(--control-bg, var(--color-surface));
		color: var(--color-text);
		box-shadow: var(--control-shadow, none);
		font-size: 14px;
	}

	.input-row input:focus {
		outline: none;
		border-color: var(--control-focus-border, var(--color-accent));
		box-shadow: var(--control-focus-shadow, 0 0 0 3px var(--color-accent-muted));
	}

	.help-text {
		margin: 8px 0 0 0;
		font-size: 12px;
		color: var(--color-text-muted);
	}

	.presets {
		margin-bottom: 20px;
	}

	.presets-label {
		display: block;
		font-size: 12px;
		color: var(--color-text-muted);
		margin-bottom: 8px;
	}

	.presets-buttons {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}

	.preset-btn {
		padding: 6px 12px;
		background: var(--color-surface-muted);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-control, 6px);
		font-size: 12px;
		color: var(--color-text);
		cursor: pointer;
		transition:
			background 0.15s ease,
			border-color 0.15s ease,
			color 0.15s ease,
			box-shadow 0.15s ease;
	}

	.preset-btn:hover:not(:disabled) {
		border-color: var(--color-border-strong);
		background: var(--color-surface);
	}

	.preset-btn.active {
		background: color-mix(in srgb, var(--color-accent) 14%, var(--color-surface));
		border-color: var(--color-accent);
		color: var(--color-accent);
		box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--color-accent) 16%, transparent);
	}

	.preset-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.estimate-section {
		background: var(--color-surface-muted);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-panel, 8px);
		padding: 16px;
		margin-bottom: 16px;
	}

	.estimate-section h4 {
		margin: 0 0 12px 0;
		font-size: 14px;
		font-weight: var(--font-weight-semibold, 600);
		color: var(--color-heading, var(--color-text));
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
		color: var(--color-text-muted);
	}

	.estimate-item .value {
		font-weight: var(--font-weight-semibold, 600);
		color: var(--color-text);
	}

	.loading-text,
	.no-estimate {
		font-size: 14px;
		color: var(--color-text-muted);
		margin: 0;
	}

	.warning-message {
		background: color-mix(in srgb, var(--color-warning) 16%, var(--color-surface));
		border: 1px solid color-mix(in srgb, var(--color-warning) 48%, var(--color-border));
		color: var(--color-warning);
		padding: 12px;
		border-radius: var(--radius-control, 6px);
		font-size: 14px;
	}

	.shortening-confirmation {
		display: flex;
		align-items: flex-start;
		gap: 10px;
		margin: 16px 0;
		font-size: 14px;
		color: var(--color-text);
	}

	.btn {
		padding: 10px 20px;
		border-radius: var(--radius-control, 6px);
		font-size: 14px;
		font-weight: var(--font-weight-semibold, 600);
		cursor: pointer;
		transition:
			background 0.15s ease,
			border-color 0.15s ease,
			color 0.15s ease,
			box-shadow 0.15s ease;
	}

	.btn-secondary {
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		color: var(--color-text);
	}

	.btn-secondary:hover:not(:disabled) {
		border-color: var(--color-border-strong);
		background: var(--color-surface-muted);
	}

	.btn-primary {
		background: var(--color-accent);
		border: 1px solid var(--color-accent);
		color: var(--color-accent-contrast);
	}

	.btn-primary:hover:not(:disabled) {
		background: var(--color-accent-hover, var(--color-accent));
		border-color: var(--color-accent-hover, var(--color-accent));
	}

	.btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
</style>
