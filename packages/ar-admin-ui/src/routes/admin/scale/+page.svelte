<script lang="ts">
	/**
	 * Scale Configuration Page
	 *
	 * NOTE:
	 * Scale UI is intentionally opinionated.
	 * Direct shard editing should remain Advanced-only.
	 * See docs/architecture/sharding.md for design decisions.
	 *
	 * This page provides an intuitive interface for scaling Authrim
	 * without requiring deep knowledge of Durable Objects sharding.
	 */
	import { onMount } from 'svelte';
	import {
		adminInfrastructureAPI,
		type ShardConfig,
		type RegionShardConfig,
		type RefreshTokenShardConfig
	} from '$lib/api/admin-infrastructure';

	// =========================================================================
	// Types
	// =========================================================================
	type ClientBasedCoefficient = 0.25 | 0.5 | 1.0;

	interface ScaleState {
		unifiedScale: number;
		clientBasedCoeff: ClientBasedCoefficient;
	}

	interface RegionDistribution {
		[region: string]: number;
	}

	interface ShardConfigState {
		codeShards: ShardConfig | null;
		refreshTokenShards: RefreshTokenShardConfig | null;
		revocationShards: ShardConfig | null;
		sessionShards: ShardConfig | null;
		challengeShards: ShardConfig | null;
		flowStateShards: ShardConfig | null;
		regionShards: RegionShardConfig | null;
	}

	interface DiffItem {
		label: string;
		oldValue: number;
		newValue: number;
	}

	// =========================================================================
	// Constants
	// =========================================================================
	const ALL_REGIONS = [
		{ key: 'apac', label: 'APAC (Asia Pacific)' },
		{ key: 'enam', label: 'ENAM (Eastern North America)' },
		{ key: 'weur', label: 'WEUR (Western Europe)' },
		{ key: 'wnam', label: 'WNAM (Western North America)' },
		{ key: 'oc', label: 'OC (Oceania)' },
		{ key: 'afr', label: 'AFR (Africa)' },
		{ key: 'me', label: 'ME (Middle East)' }
	];

	const DEFAULT_REGIONS = ['apac', 'enam', 'weur'];

	// Future: Scale profile presets for quick configuration
	// type ScaleProfile = 'dev' | 'prod' | 'enterprise';
	const _SCALE_PRESETS = [
		{ value: 4, label: '4', lps: 50, useCase: 'Dev/Test' },
		{ value: 8, label: '8', lps: 100, useCase: 'Small Prod' },
		{ value: 16, label: '16', lps: 200, useCase: 'Medium Prod' },
		{ value: 32, label: '32', lps: 400, useCase: 'Large Prod' },
		{ value: 64, label: '64', lps: 800, useCase: 'Enterprise' }
	];

	// =========================================================================
	// State
	// =========================================================================
	let loading = $state(true);
	let saving = $state(false);
	let error = $state('');
	let successMessage = $state('');
	let advancedOpen = $state(false);
	let showDiffDialog = $state(false);

	// Current configuration from API
	let currentConfig = $state<ShardConfigState>({
		codeShards: null,
		refreshTokenShards: null,
		revocationShards: null,
		sessionShards: null,
		challengeShards: null,
		flowStateShards: null,
		regionShards: null
	});

	// Edit state
	let selectedRegions = $state<string[]>([...DEFAULT_REGIONS]);
	let regionDistribution = $state<RegionDistribution>({ apac: 33, enam: 34, weur: 33 });

	let scaleState = $state<ScaleState>({
		unifiedScale: 8,
		clientBasedCoeff: 0.5
	});

	// Initial values for diff comparison
	let initialScaleState = $state<ScaleState>({
		unifiedScale: 8,
		clientBasedCoeff: 0.5
	});

	// =========================================================================
	// Derived Values
	// =========================================================================

	// LPS estimation for full login flow (based on load test: 32 shards ≈ 150 LPS)
	// See: load-testing/reports/Dec2025/full-login-otp.md
	function estimateLPS(shards: number): number {
		return Math.round(shards * 4.7);
	}

	// RPS estimation for individual components (based on endpoint load tests)
	// Refresh Token: 48 shards = 3,000 RPS (62.5/shard)
	// Token Exchange: 8 shards = 2,500 RPS (312/shard)
	// Using conservative estimate: ~28 RPS/shard (6x login flow)
	function estimateComponentRPS(shards: number): number {
		return Math.round(shards * 28);
	}

	// Total LPS (all shards use same scale now)
	let estimatedTotalLPS = $derived(estimateLPS(scaleState.unifiedScale));

	// Active region count
	let activeRegionCount = $derived(selectedRegions.length);

	// Calculate individual shard counts from unified scale
	function calculateShardCounts(scale: ScaleState) {
		const clientBased = Math.max(4, Math.floor(scale.unifiedScale * scale.clientBasedCoeff));
		return {
			// All core shards use unified scale
			authCode: scale.unifiedScale,
			refreshToken: scale.unifiedScale, // Must match authCode
			revocation: scale.unifiedScale,
			session: scale.unifiedScale,
			challenge: scale.unifiedScale,
			flowState: scale.unifiedScale,
			// Client-based (coefficient applied)
			par: clientBased,
			deviceCode: clientBased,
			ciba: clientBased,
			dpop: clientBased
		};
	}

	let calculatedShards = $derived(calculateShardCounts(scaleState));

	// Check if there are changes to save
	let hasChanges = $derived(
		scaleState.unifiedScale !== initialScaleState.unifiedScale ||
			scaleState.clientBasedCoeff !== initialScaleState.clientBasedCoeff
	);

	// Build diff items for dialog
	let diffItems = $derived(() => {
		const items: DiffItem[] = [];
		if (scaleState.unifiedScale !== initialScaleState.unifiedScale) {
			items.push({
				label: 'Scale',
				oldValue: initialScaleState.unifiedScale,
				newValue: scaleState.unifiedScale
			});
		}
		return items;
	});

	// =========================================================================
	// Load Functions
	// =========================================================================
	onMount(async () => {
		await loadAllConfigs();
	});

	async function loadAllConfigs() {
		loading = true;
		error = '';
		try {
			const [code, revocation, session, challenge, flowState, region, refreshToken] =
				await Promise.all([
					adminInfrastructureAPI.getCodeShards(),
					adminInfrastructureAPI.getRevocationShards(),
					adminInfrastructureAPI.getSessionShards(),
					adminInfrastructureAPI.getChallengeShards(),
					adminInfrastructureAPI.getFlowStateShards(),
					adminInfrastructureAPI.getRegionShards().catch(() => null),
					adminInfrastructureAPI.getRefreshTokenSharding().catch(() => null)
				]);

			currentConfig = {
				codeShards: code,
				revocationShards: revocation,
				sessionShards: session,
				challengeShards: challenge,
				flowStateShards: flowState,
				regionShards: region,
				refreshTokenShards: refreshToken?.config || null
			};

			// Initialize scale state from current config
			// Use max of all core shards as the unified scale
			const maxScale = Math.max(
				code.current,
				session.current,
				revocation.current,
				challenge.current
			);

			scaleState = {
				unifiedScale: maxScale,
				clientBasedCoeff: 0.5
			};

			initialScaleState = { ...scaleState };

			// Initialize region distribution from config
			if (region && region.currentRegions) {
				const regions = Object.keys(region.currentRegions);
				if (regions.length > 0) {
					selectedRegions = regions;
					const total = region.currentTotalShards;
					const dist: RegionDistribution = {};
					for (const [key, data] of Object.entries(region.currentRegions)) {
						dist[key] = Math.round((data.count / total) * 100);
					}
					regionDistribution = dist;
				}
			}
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to load configuration';
		} finally {
			loading = false;
		}
	}

	// =========================================================================
	// Region Functions
	// =========================================================================
	function toggleRegion(regionKey: string) {
		if (selectedRegions.includes(regionKey)) {
			if (selectedRegions.length > 1) {
				selectedRegions = selectedRegions.filter((r) => r !== regionKey);
				delete regionDistribution[regionKey];
				rebalanceDistribution();
			}
		} else {
			selectedRegions = [...selectedRegions, regionKey];
			rebalanceDistribution();
		}
	}

	function rebalanceDistribution() {
		const count = selectedRegions.length;
		if (count === 0) return;

		const basePercent = Math.floor(100 / count);
		const remainder = 100 - basePercent * count;

		const newDist: RegionDistribution = {};
		selectedRegions.forEach((region, i) => {
			newDist[region] = basePercent + (i < remainder ? 1 : 0);
		});
		regionDistribution = newDist;
	}

	function adjustDistribution(changedRegion: string, newValue: number) {
		const others = selectedRegions.filter((r) => r !== changedRegion);
		const remainingPercent = 100 - newValue;

		// If only one region, it must be 100%
		if (others.length === 0) {
			regionDistribution = { [changedRegion]: 100 };
			return;
		}

		const currentOthersTotal = others.reduce((sum, k) => sum + (regionDistribution[k] || 0), 0);

		const result: RegionDistribution = { ...regionDistribution, [changedRegion]: newValue };

		if (currentOthersTotal === 0 || remainingPercent <= 0) {
			// Distribute remaining equally
			const perOther = Math.max(0, Math.floor(remainingPercent / others.length));
			let allocated = 0;
			others.forEach((k, i) => {
				if (i === others.length - 1) {
					result[k] = Math.max(0, remainingPercent - allocated);
				} else {
					result[k] = perOther;
					allocated += perOther;
				}
			});
		} else {
			const scale = remainingPercent / currentOthersTotal;
			let allocated = 0;
			others.forEach((k, i) => {
				if (i === others.length - 1) {
					result[k] = Math.max(0, remainingPercent - allocated);
				} else {
					result[k] = Math.round((regionDistribution[k] || 0) * scale);
					allocated += result[k];
				}
			});
		}

		regionDistribution = result;
	}

	// =========================================================================
	// Save Functions
	// =========================================================================
	function handleSaveClick() {
		if (advancedOpen && hasChanges) {
			showDiffDialog = true;
		} else {
			saveAllChanges();
		}
	}

	async function saveAllChanges() {
		showDiffDialog = false;
		saving = true;
		error = '';

		try {
			const shards = calculateShardCounts(scaleState);

			// Save all shard configurations (all use unified scale now)
			await Promise.all([
				adminInfrastructureAPI.updateCodeShards(shards.authCode),
				adminInfrastructureAPI.updateRevocationShards(shards.revocation),
				adminInfrastructureAPI.updateSessionShards(shards.session),
				adminInfrastructureAPI.updateChallengeShards(shards.challenge),
				adminInfrastructureAPI.updateFlowStateShards(shards.flowState),
				adminInfrastructureAPI.updateRefreshTokenSharding(shards.refreshToken)
			]);

			// Update region distribution if changed
			if (selectedRegions.length > 0) {
				await adminInfrastructureAPI.updateRegionShards(
					scaleState.unifiedScale,
					regionDistribution
				);
			}

			showSuccess('Scale configuration saved. Changes affect new sessions only.');
			initialScaleState = { ...scaleState };
			await loadAllConfigs();
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to save configuration';
		} finally {
			saving = false;
		}
	}

	// =========================================================================
	// Helpers
	// =========================================================================
	function showSuccess(message: string) {
		successMessage = message;
		setTimeout(() => {
			successMessage = '';
		}, 5000);
	}
</script>

<div class="scale-page">
	<!-- Header -->
	<div class="page-header">
		<h1 class="page-title">Scale Configuration</h1>
		<p class="page-description">
			Configure system capacity and geographic distribution. Changes affect new sessions only.
		</p>
	</div>

	<!-- Current Scale Summary (Compact) -->
	<div class="summary-inline">
		<span class="summary-label">Current:</span>
		{#if loading}
			<span class="loading-text">Loading...</span>
		{:else}
			<span class="lps-value">~{estimatedTotalLPS} Login/sec</span>
			<span class="lps-qualifier">(Est.)</span>
			<span class="summary-divider">·</span>
			<span class="region-info">{activeRegionCount} region{activeRegionCount !== 1 ? 's' : ''}</span>
		{/if}
	</div>

	<!-- Success/Error Messages -->
	{#if successMessage}
		<div class="alert alert-success">
			<i class="i-ph-check-circle"></i>
			<span>{successMessage}</span>
		</div>
	{/if}
	{#if error}
		<div class="alert alert-error">
			<i class="i-ph-warning-circle"></i>
			<span>{error}</span>
		</div>
	{/if}

	{#if loading}
		<div class="loading-state">
			<i class="i-ph-circle-notch animate-spin"></i>
			<span>Loading configuration...</span>
		</div>
	{:else}
		<!-- Section 1: Region Distribution -->
		<section class="config-section">
			<h2 class="section-title">Region Distribution</h2>
			<p class="section-description">
				<i class="i-ph-info info-icon"></i>
				Select regions and configure <strong>request routing ratio</strong>.
			</p>

			<div class="region-distribution-list">
				{#each ALL_REGIONS as region (region.key)}
					{@const isSelected = selectedRegions.includes(region.key)}
					{@const isLastSelected = selectedRegions.length === 1 && isSelected}
					<div class="region-row" class:selected={isSelected}>
						<label class="region-checkbox-inline">
							<input
								type="checkbox"
								checked={isSelected}
								onchange={() => toggleRegion(region.key)}
								disabled={isLastSelected}
							/>
						</label>
						<span class="region-label">{region.label}</span>
						{#if isSelected && selectedRegions.length > 1}
							<input
								type="range"
								min="0"
								max="100"
								value={regionDistribution[region.key] || 0}
								oninput={(e) =>
									adjustDistribution(region.key, parseInt((e.target as HTMLInputElement).value))}
								class="region-slider"
							/>
							<span class="region-percent">{regionDistribution[region.key] || 0}%</span>
						{:else if isSelected}
							<span class="region-slider-placeholder"></span>
							<span class="region-percent">100%</span>
						{:else}
							<span class="region-slider-placeholder"></span>
							<span class="region-percent inactive">-</span>
						{/if}
					</div>
				{/each}
			</div>
			{#if selectedRegions.length > 1}
				<p class="slider-note">Note: Adjusting one slider will auto-balance others.</p>
			{/if}
		</section>

		<!-- Section 3: Scale Configuration (Unified) -->
		<section class="config-section">
			<h2 class="section-title">Scale Configuration</h2>
			<p class="section-description">
				<i class="i-ph-info info-icon"></i>
				Shard scale controls <strong>capacity per region</strong>.
			</p>

			<div class="scale-sliders">
				<div class="scale-group">
					<div class="scale-header">
						<h3>System Scale</h3>
					</div>
					<div class="slider-container">
						<input
							type="range"
							min="4"
							max="128"
							step="4"
							bind:value={scaleState.unifiedScale}
							class="scale-slider"
						/>
						<span class="scale-value">{scaleState.unifiedScale} shards</span>
					</div>
					<div class="scale-info">
						<span class="lps-estimate"
							>Estimated ~{estimateLPS(scaleState.unifiedScale)} Login/sec</span
						>
					</div>
					{#if scaleState.unifiedScale >= 32}
						<div class="scale-warning">
							<i class="i-ph-info"></i>
							<span>
								Optimal shard count varies by environment. Please conduct load testing based on your actual usage patterns.
							</span>
						</div>
					{/if}
				</div>
			</div>

			<!-- Per-type RPS breakdown -->
			<div class="rps-breakdown">
				<h4>Estimated RPS by Component</h4>
				<div class="rps-grid">
					<div class="rps-item">
						<span class="rps-label">AuthCode</span>
						<span class="rps-value">~{estimateComponentRPS(calculatedShards.authCode)} RPS</span>
					</div>
					<div class="rps-item">
						<span class="rps-label">RefreshToken</span>
						<span class="rps-value">~{estimateComponentRPS(calculatedShards.refreshToken)} RPS</span>
					</div>
					<div class="rps-item">
						<span class="rps-label">Session</span>
						<span class="rps-value">~{estimateComponentRPS(calculatedShards.session)} RPS</span>
					</div>
					<div class="rps-item">
						<span class="rps-label">Challenge</span>
						<span class="rps-value">~{estimateComponentRPS(calculatedShards.challenge)} RPS</span>
					</div>
					<div class="rps-item">
						<span class="rps-label">Revocation</span>
						<span class="rps-value">~{estimateComponentRPS(calculatedShards.revocation)} RPS</span>
					</div>
					<div class="rps-item">
						<span class="rps-label">FlowState</span>
						<span class="rps-value">~{estimateComponentRPS(calculatedShards.flowState)} RPS</span>
					</div>
				</div>
			</div>

			<!-- Disclaimer -->
			<div class="disclaimer">
				<i class="i-ph-warning"></i>
				<span>
					Estimates based on internal load tests. Actual capacity varies by flow type, region, and
					token TTL.
				</span>
			</div>
		</section>

		<!-- Section 4: Advanced Settings -->
		<section class="config-section advanced-section">
			<button class="advanced-toggle" onclick={() => (advancedOpen = !advancedOpen)}>
				<i class={advancedOpen ? 'i-ph-caret-down' : 'i-ph-caret-right'}></i>
				<span>Advanced Settings</span>
			</button>

			{#if advancedOpen}
				<div class="advanced-content">
					<!-- Estimation Model -->
					<div class="advanced-group">
						<h4>Estimation Model</h4>
						<p class="advanced-description">
							Based on load tests (Dec 2025).<br />
							Login/sec: shards × 4.7 (Full Login Flow)<br />
							Component RPS: shards × 28 (individual endpoints)<br />
							Reference: 32 shards ≈ 150 LPS, ~900 RPS per component<br />
							Actual results vary by authentication flow, token TTL, and usage patterns.
						</p>
					</div>

					<!-- Client-based Coefficient -->
					<div class="advanced-group">
						<h4>Client-based Coefficient</h4>
						<p class="advanced-description">Applies to: PAR, DeviceCode, CIBA, DPoP</p>
						<select bind:value={scaleState.clientBasedCoeff} class="coeff-select">
							<option value={0.25}>0.25 (Low traffic)</option>
							<option value={0.5}>0.5 (Default)</option>
							<option value={1.0}>1.0 (High traffic)</option>
						</select>
						<p class="coeff-result">
							Current: {Math.max(
								4,
								Math.floor(scaleState.unifiedScale * scaleState.clientBasedCoeff)
							)} shards (~{estimateComponentRPS(
								Math.max(4, Math.floor(scaleState.unifiedScale * scaleState.clientBasedCoeff))
							)} RPS)
						</p>
					</div>

					<!-- Individual Shard Settings -->
					<div class="advanced-group">
						<h4>Individual Shard Settings (Calculated)</h4>
						<p class="advanced-description warning">
							<i class="i-ph-warning"></i>
							AuthCode and RefreshToken MUST have identical values.
						</p>
						<div class="shard-grid">
							<div class="shard-item">
								<span class="shard-label">AuthCode</span>
								<span class="shard-value">{calculatedShards.authCode}</span>
								<i class="i-ph-lock-simple lock-icon" title="Synced with RefreshToken"></i>
							</div>
							<div class="shard-item">
								<span class="shard-label">RefreshToken</span>
								<span class="shard-value">{calculatedShards.refreshToken}</span>
								<i class="i-ph-lock-simple lock-icon" title="Synced with AuthCode"></i>
							</div>
							<div class="shard-item">
								<span class="shard-label">Revocation</span>
								<span class="shard-value">{calculatedShards.revocation}</span>
							</div>
							<div class="shard-item">
								<span class="shard-label">Session</span>
								<span class="shard-value">{calculatedShards.session}</span>
							</div>
							<div class="shard-item">
								<span class="shard-label">Challenge</span>
								<span class="shard-value">{calculatedShards.challenge}</span>
							</div>
							<div class="shard-item">
								<span class="shard-label">FlowState</span>
								<span class="shard-value">{calculatedShards.flowState}</span>
							</div>
							<div class="shard-item client-based">
								<span class="shard-label">PAR</span>
								<span class="shard-value">{calculatedShards.par}</span>
							</div>
							<div class="shard-item client-based">
								<span class="shard-label">DeviceCode</span>
								<span class="shard-value">{calculatedShards.deviceCode}</span>
							</div>
							<div class="shard-item client-based">
								<span class="shard-label">CIBA</span>
								<span class="shard-value">{calculatedShards.ciba}</span>
							</div>
							<div class="shard-item client-based">
								<span class="shard-label">DPoP</span>
								<span class="shard-value">{calculatedShards.dpop}</span>
							</div>
						</div>
					</div>
				</div>
			{/if}
		</section>

		<!-- Save Button -->
		<div class="actions">
			<button class="btn btn-primary" onclick={handleSaveClick} disabled={saving || !hasChanges}>
				{#if saving}
					<i class="i-ph-circle-notch animate-spin"></i>
					<span>Saving...</span>
				{:else}
					<i class="i-ph-floppy-disk"></i>
					<span>Save Changes</span>
				{/if}
			</button>
		</div>
	{/if}

	<!-- Diff Confirmation Dialog -->
	{#if showDiffDialog}
		<div class="dialog-overlay" onclick={() => (showDiffDialog = false)}>
			<div class="dialog" onclick={(e) => e.stopPropagation()}>
				<h3>Confirm Changes</h3>
				<p class="dialog-subtitle">You are about to change:</p>

				<ul class="diff-list">
					{#each diffItems() as item (item.label)}
						<li>
							<span class="diff-label">{item.label}:</span>
							<span class="diff-old">{item.oldValue}</span>
							<span class="diff-arrow">→</span>
							<span class="diff-new">{item.newValue}</span>
						</li>
					{/each}
				</ul>

				<p class="dialog-warning">
					<i class="i-ph-warning"></i>
					Changes affect new sessions only.
				</p>

				<div class="dialog-actions">
					<button class="btn btn-secondary" onclick={() => (showDiffDialog = false)}>Cancel</button>
					<button class="btn btn-primary" onclick={saveAllChanges}>Save Changes</button>
				</div>
			</div>
		</div>
	{/if}
</div>

<style>
	.scale-page {
		max-width: 900px;
	}

	/* Current Scale Summary (Compact Inline) */
	.summary-inline {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 12px 16px;
		background: var(--bg-tertiary);
		border-radius: var(--radius-md);
		margin-bottom: 24px;
		font-size: 0.9375rem;
	}

	.summary-label {
		font-weight: 600;
		color: var(--text-secondary);
	}

	.lps-value {
		font-weight: 700;
		color: var(--primary);
	}

	.lps-qualifier {
		font-size: 0.8125rem;
		color: var(--text-muted);
	}

	.summary-divider {
		color: var(--text-muted);
	}

	.region-info {
		font-size: 0.875rem;
		color: var(--text-secondary);
	}

	.loading-text {
		color: var(--text-muted);
	}

	/* Page Header */
	.page-header {
		margin-bottom: 32px;
	}

	.page-title {
		font-size: 1.75rem;
		font-weight: 700;
		color: var(--text-primary);
		margin: 0 0 8px 0;
	}

	.page-description {
		color: var(--text-secondary);
		font-size: 0.9375rem;
		margin: 0;
	}

	/* Alerts */
	.alert {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 12px 16px;
		border-radius: var(--radius-md);
		margin-bottom: 20px;
		font-size: 0.875rem;
	}

	.alert-success {
		background: var(--success-bg);
		color: var(--success);
		border: 1px solid var(--success);
	}

	.alert-error {
		background: var(--error-bg);
		color: var(--error);
		border: 1px solid var(--error);
	}

	.loading-state {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 12px;
		padding: 48px;
		color: var(--text-secondary);
	}

	/* Sections */
	.config-section {
		background: var(--bg-card);
		border: 1px solid var(--border-secondary);
		border-radius: var(--radius-lg);
		padding: 24px;
		margin-bottom: 24px;
	}

	.section-title {
		font-size: 1.125rem;
		font-weight: 600;
		color: var(--text-primary);
		margin: 0 0 8px 0;
	}

	.section-description {
		color: var(--text-secondary);
		font-size: 0.875rem;
		margin: 0 0 20px 0;
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.info-icon {
		color: var(--info);
	}

	/* Region Distribution List (Combined Checkbox + Slider) */
	.region-distribution-list {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.region-row {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 10px 14px;
		background: var(--bg-tertiary);
		border: 1px solid var(--border-secondary);
		border-radius: var(--radius-md);
		transition: all var(--transition-fast);
	}

	.region-row:hover {
		border-color: var(--border-primary);
	}

	.region-row.selected {
		background: var(--primary-bg);
		border-color: var(--primary);
	}

	.region-checkbox-inline {
		display: flex;
		align-items: center;
		cursor: pointer;
	}

	.region-checkbox-inline input {
		accent-color: var(--primary);
		width: 18px;
		height: 18px;
		cursor: pointer;
	}

	.region-label {
		width: 220px;
		font-size: 0.875rem;
		color: var(--text-primary);
		font-weight: 500;
	}

	.region-slider {
		flex: 1;
		height: 6px;
		accent-color: var(--primary);
		min-width: 100px;
	}

	.region-slider-placeholder {
		flex: 1;
		min-width: 100px;
	}

	.region-percent {
		width: 48px;
		text-align: right;
		font-size: 0.875rem;
		font-weight: 600;
		color: var(--text-primary);
	}

	.region-percent.inactive {
		color: var(--text-muted);
		font-weight: 400;
	}

	.slider-note {
		font-size: 0.75rem;
		color: var(--text-muted);
		margin: 12px 0 0;
		font-style: italic;
	}

	/* Scale Sliders */
	.scale-sliders {
		display: flex;
		flex-direction: column;
		gap: 24px;
	}

	.scale-group {
		background: var(--bg-tertiary);
		border-radius: var(--radius-md);
		padding: 20px;
	}

	.scale-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 12px;
	}

	.scale-header h3 {
		font-size: 0.9375rem;
		font-weight: 600;
		color: var(--text-primary);
		margin: 0;
	}

	.slider-container {
		display: flex;
		align-items: center;
		gap: 16px;
	}

	.scale-slider {
		flex: 1;
		height: 8px;
		accent-color: var(--primary);
	}

	.scale-value {
		font-size: 1rem;
		font-weight: 700;
		color: var(--primary);
		min-width: 90px;
		text-align: right;
	}

	.scale-info {
		display: flex;
		flex-direction: column;
		gap: 4px;
		margin-top: 12px;
	}

	.lps-estimate {
		font-size: 0.9375rem;
		font-weight: 600;
		color: var(--success);
	}

	.scale-warning {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		padding: 10px 12px;
		background: var(--info-bg, rgba(59, 130, 246, 0.1));
		border-radius: var(--radius-sm);
		margin-top: 12px;
		font-size: 0.8125rem;
		color: var(--info, #3b82f6);
	}

	/* RPS Breakdown */
	.rps-breakdown {
		margin-top: 24px;
		padding: 16px;
		background: var(--bg-tertiary);
		border-radius: var(--radius-md);
	}

	.rps-breakdown h4 {
		font-size: 0.8125rem;
		font-weight: 600;
		color: var(--text-secondary);
		text-transform: uppercase;
		margin: 0 0 12px 0;
	}

	.rps-grid {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: 8px;
	}

	.rps-item {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 8px 12px;
		background: var(--bg-card);
		border-radius: var(--radius-sm);
	}

	.rps-label {
		font-size: 0.8125rem;
		color: var(--text-secondary);
	}

	.rps-value {
		font-size: 0.8125rem;
		font-weight: 600;
		color: var(--text-primary);
	}

	/* Disclaimer */
	.disclaimer {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		padding: 12px;
		background: var(--warning-bg);
		border-radius: var(--radius-sm);
		margin-top: 16px;
		font-size: 0.8125rem;
		color: var(--warning);
	}

	/* Advanced Section */
	.advanced-section {
		background: var(--bg-secondary);
	}

	.advanced-toggle {
		display: flex;
		align-items: center;
		gap: 8px;
		background: none;
		border: none;
		color: var(--text-primary);
		font-size: 0.9375rem;
		font-weight: 600;
		cursor: pointer;
		padding: 0;
	}

	.advanced-toggle:hover {
		color: var(--primary);
	}

	.advanced-content {
		margin-top: 20px;
		padding-top: 20px;
		border-top: 1px solid var(--border-secondary);
	}

	.advanced-group {
		margin-bottom: 24px;
	}

	.advanced-group:last-child {
		margin-bottom: 0;
	}

	.advanced-group h4 {
		font-size: 0.875rem;
		font-weight: 600;
		color: var(--text-primary);
		margin: 0 0 8px 0;
	}

	.advanced-description {
		font-size: 0.8125rem;
		color: var(--text-secondary);
		margin: 0 0 12px 0;
		line-height: 1.6;
	}

	.advanced-description.warning {
		display: flex;
		align-items: center;
		gap: 6px;
		color: var(--warning);
		background: var(--warning-bg);
		padding: 8px 12px;
		border-radius: var(--radius-sm);
	}

	.coeff-select {
		padding: 8px 12px;
		border: 1px solid var(--border-primary);
		border-radius: var(--radius-md);
		background: var(--bg-input);
		color: var(--text-primary);
		font-size: 0.875rem;
	}

	.coeff-result {
		font-size: 0.8125rem;
		color: var(--text-muted);
		margin: 8px 0 0;
	}

	/* Shard Grid */
	.shard-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
		gap: 12px;
	}

	.shard-item {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		padding: 10px 14px;
		background: var(--bg-card);
		border: 1px solid var(--border-secondary);
		border-radius: var(--radius-md);
	}

	.shard-item.client-based {
		opacity: 0.8;
		border-style: dashed;
	}

	.shard-label {
		font-size: 0.8125rem;
		color: var(--text-secondary);
	}

	.shard-value {
		font-size: 0.9375rem;
		font-weight: 600;
		color: var(--text-primary);
	}

	.lock-icon {
		color: var(--warning);
		font-size: 0.75rem;
	}

	/* Actions */
	.actions {
		display: flex;
		justify-content: flex-end;
		margin-top: 24px;
	}

	.btn {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 12px 24px;
		border-radius: var(--radius-md);
		font-size: 0.9375rem;
		font-weight: 600;
		cursor: pointer;
		border: none;
		transition: all var(--transition-fast);
	}

	.btn-primary {
		background: var(--primary);
		color: white;
	}

	.btn-primary:hover:not(:disabled) {
		background: var(--primary-dark);
	}

	.btn-secondary {
		background: var(--bg-tertiary);
		color: var(--text-primary);
		border: 1px solid var(--border-primary);
	}

	.btn-secondary:hover:not(:disabled) {
		background: var(--bg-secondary);
	}

	.btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	/* Dialog */
	.dialog-overlay {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.5);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 1000;
	}

	.dialog {
		background: var(--bg-card);
		border-radius: var(--radius-lg);
		padding: 24px;
		max-width: 480px;
		width: 90%;
		box-shadow: var(--shadow-lg);
	}

	.dialog h3 {
		font-size: 1.125rem;
		font-weight: 600;
		color: var(--text-primary);
		margin: 0 0 8px 0;
	}

	.dialog-subtitle {
		font-size: 0.875rem;
		color: var(--text-secondary);
		margin: 0 0 16px 0;
	}

	.diff-list {
		list-style: none;
		padding: 0;
		margin: 0 0 16px 0;
	}

	.diff-list li {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 8px 0;
		font-size: 0.875rem;
		border-bottom: 1px solid var(--border-secondary);
	}

	.diff-list li:last-child {
		border-bottom: none;
	}

	.diff-label {
		color: var(--text-secondary);
	}

	.diff-old {
		color: var(--error);
		text-decoration: line-through;
	}

	.diff-arrow {
		color: var(--text-muted);
	}

	.diff-new {
		color: var(--success);
		font-weight: 600;
	}

	.dialog-warning {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 0.8125rem;
		color: var(--warning);
		background: var(--warning-bg);
		padding: 10px 12px;
		border-radius: var(--radius-sm);
		margin: 0 0 20px 0;
	}

	.dialog-actions {
		display: flex;
		justify-content: flex-end;
		gap: 12px;
	}

	/* Responsive */
	@media (max-width: 768px) {
		.summary-value {
			font-size: 1.25rem;
		}

		.lps-value {
			font-size: 1.5rem;
		}

		.region-row {
			flex-wrap: wrap;
		}

		.region-label {
			width: auto;
			flex: 1;
		}

		.region-slider {
			order: 3;
			width: 100%;
			margin-top: 8px;
		}

		.region-slider-placeholder {
			display: none;
		}

		.region-percent {
			order: 2;
		}

		.shard-grid {
			grid-template-columns: repeat(2, 1fr);
		}

		.rps-grid {
			grid-template-columns: repeat(2, 1fr);
		}
	}
</style>
