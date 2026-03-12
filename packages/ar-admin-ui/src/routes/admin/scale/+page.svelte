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
	import WorldMap from '$lib/components/WorldMap.svelte';
	import { Modal } from '$lib/components';

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
		{ key: 'oc', label: 'OC (Oceania)' }
		// AFR and ME are not DO-capable, commented out for future use
		// { key: 'afr', label: 'AFR (Africa)' },
		// { key: 'me', label: 'ME (Middle East)' }
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
	let _currentConfig = $state<ShardConfigState>({
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
	let _estimatedTotalLPS = $derived(estimateLPS(scaleState.unifiedScale));

	// Initial LPS (for "Current" display - doesn't change with slider)
	let initialLPS = $derived(estimateLPS(initialScaleState.unifiedScale));

	// Active region count
	let _activeRegionCount = $derived(selectedRegions.length);

	// Minimum shard count = 4 (practical minimum for any meaningful load)
	const minShardCount = 4;
	const maxShardCount = 128;
	const shardStep = 4;

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
	let diffItems = $derived.by(() => {
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

	// Enforce min/max bounds (no divisibility constraint needed - backend handles percentage-based allocation)
	$effect(() => {
		if (scaleState.unifiedScale < minShardCount) {
			scaleState.unifiedScale = minShardCount;
		}
		if (scaleState.unifiedScale > maxShardCount) {
			scaleState.unifiedScale = maxShardCount;
		}
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

			_currentConfig = {
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
				const total = region.currentTotalShards || 0;
				if (regions.length > 0 && total > 0) {
					selectedRegions = regions;
					const dist: RegionDistribution = {};
					for (const [key, data] of Object.entries(region.currentRegions)) {
						dist[key] = Math.round((data.count / total) * 100);
					}
					regionDistribution = dist;
				}
				// If no valid region config from server, keep initial default values
			}
			// Else: keep initial default values (selectedRegions = DEFAULT_REGIONS, regionDistribution = { apac: 33, enam: 34, weur: 33 })
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

	<!-- Current Scale Summary - Shows saved server config, not live slider -->
	<div class="current-badge-wrapper">
		<div class="current-badge">
			<i class="i-ph-gauge current-badge-icon"></i>
			{#if loading}
				<span class="loading-text">Loading...</span>
			{:else}
				<span class="current-badge-label">Current:</span>
				<span class="current-badge-shards">{initialScaleState.unifiedScale} Shards</span>
				<span class="current-badge-lps">(~{initialLPS} Login/sec)</span>
			{/if}
		</div>
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
		<!-- Section 1: Scale Configuration (Compact Control Panel) -->
		<section class="scale-control-panel">
			<div class="scale-panel-header">
				<div class="scale-panel-title">
					<i class="i-ph-sliders-horizontal"></i>
					<span>System Scale</span>
					<span class="help-tooltip scale-tooltip">
						<i class="i-ph-question help-icon-cyber"></i>
						<span class="tooltip-content tooltip-below">
							Set shards based on your service's maximum expected load. Too few may cause errors
							under high traffic; too many may increase response latency.
						</span>
					</span>
				</div>
				<div class="scale-panel-main">
					<input
						type="range"
						min={minShardCount}
						max={maxShardCount}
						step={shardStep}
						bind:value={scaleState.unifiedScale}
						class="cyber-slider"
					/>
					<div class="scale-readout">
						<span class="shard-count">{scaleState.unifiedScale}</span>
						<span class="shard-label">shards</span>
					</div>
				</div>
				<div class="scale-lps-badge">
					<span class="lps-value">~{estimateLPS(scaleState.unifiedScale)}</span>
					<span class="lps-unit">LPS</span>
				</div>
			</div>
			<div class="rps-mini-grid">
				<div class="rps-mini-item">
					<span class="rps-mini-label">Auth</span>
					<span class="rps-mini-value">{estimateComponentRPS(calculatedShards.authCode)}</span>
				</div>
				<div class="rps-mini-item">
					<span class="rps-mini-label">Token</span>
					<span class="rps-mini-value">{estimateComponentRPS(calculatedShards.refreshToken)}</span>
				</div>
				<div class="rps-mini-item">
					<span class="rps-mini-label">Session</span>
					<span class="rps-mini-value">{estimateComponentRPS(calculatedShards.session)}</span>
				</div>
				<div class="rps-mini-item">
					<span class="rps-mini-label">Challenge</span>
					<span class="rps-mini-value">{estimateComponentRPS(calculatedShards.challenge)}</span>
				</div>
				<div class="rps-mini-item">
					<span class="rps-mini-label">Revoke</span>
					<span class="rps-mini-value">{estimateComponentRPS(calculatedShards.revocation)}</span>
				</div>
				<div class="rps-mini-item">
					<span class="rps-mini-label">Flow</span>
					<span class="rps-mini-value">{estimateComponentRPS(calculatedShards.flowState)}</span>
				</div>
			</div>
		</section>

		<!-- Section 2: World Map Visualization -->
		<section class="map-section">
			<WorldMap {selectedRegions} {regionDistribution} onRegionClick={toggleRegion} />
		</section>

		<!-- Section 3: Region Distribution -->
		<section class="config-section">
			<h2 class="section-title">
				Region Distribution
				<span class="help-tooltip">
					<span class="help-icon-circle">
						<i class="i-ph-question help-icon-inner"></i>
					</span>
					<span class="tooltip-content">
						Configure where authentication data (sessions, tokens) is stored. Set percentages based
						on your users' geographic distribution. Example: If 50% of users are in Asia, set APAC
						to ~50%.
					</span>
				</span>
			</h2>
			<p class="section-description">
				<i class="i-ph-info info-icon"></i>
				Select regions and configure <strong>request routing ratio</strong>.
			</p>

			<div class="region-distribution-list">
				{#each ALL_REGIONS as region (region.key)}
					{@const isSelected = selectedRegions.includes(region.key)}
					{@const isLastSelected = selectedRegions.length === 1 && isSelected}
					<div class="region-row" class:selected={isSelected}>
						<label class="toggle-switch" class:disabled={isLastSelected}>
							<input
								type="checkbox"
								checked={isSelected}
								onchange={() => toggleRegion(region.key)}
								disabled={isLastSelected}
							/>
							<span class="toggle-slider"></span>
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
	<Modal
		open={showDiffDialog}
		onClose={() => (showDiffDialog = false)}
		title="Confirm Changes"
		size="sm"
	>
		<p class="dialog-subtitle">You are about to change:</p>

		<ul class="diff-list">
			{#each diffItems as item (item.label)}
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

		{#snippet footer()}
			<button class="btn btn-secondary" onclick={() => (showDiffDialog = false)}>Cancel</button>
			<button class="btn btn-primary" onclick={saveAllChanges}>Save Changes</button>
		{/snippet}
	</Modal>
</div>

<style>
	.scale-page {
		max-width: 900px;
	}

	/* World Map Section */
	.map-section {
		margin-bottom: 24px;
	}

	/* Current Scale Badge */
	.current-badge-wrapper {
		display: flex;
		justify-content: center;
		margin-bottom: 20px;
	}

	.current-badge {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		padding: 10px 20px;
		background: var(--bg-card);
		border: 1px solid var(--border-secondary);
		border-radius: 100px;
		font-size: 0.875rem;
	}

	.current-badge-icon {
		width: 16px;
		height: 16px;
		color: var(--text-muted);
	}

	.current-badge-label {
		font-weight: 500;
		color: var(--text-secondary);
	}

	.current-badge-shards {
		font-weight: 700;
		color: var(--text-primary);
	}

	.current-badge-lps {
		font-size: 0.8125rem;
		color: var(--text-muted);
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

	/* Scale Control Panel - Cyberpunk Style */
	.scale-control-panel {
		background: linear-gradient(135deg, rgba(15, 23, 42, 0.95), rgba(30, 41, 59, 0.9));
		border: 1px solid rgba(0, 255, 213, 0.2);
		border-radius: var(--radius-lg);
		padding: 16px 20px;
		margin-bottom: 16px;
		position: relative;
		overflow: visible;
	}

	.scale-control-panel::before {
		content: '';
		position: absolute;
		top: 0;
		left: 0;
		right: 0;
		height: 1px;
		background: linear-gradient(90deg, transparent, rgba(0, 255, 213, 0.5), transparent);
	}

	.scale-panel-header {
		display: flex;
		align-items: center;
		gap: 16px;
		flex-wrap: wrap;
	}

	.scale-panel-title {
		display: flex;
		align-items: center;
		gap: 8px;
		color: rgba(0, 255, 213, 0.9);
		font-size: 0.8125rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		min-width: 110px;
	}

	.scale-panel-title i {
		width: 16px;
		height: 16px;
	}

	.scale-panel-main {
		display: flex;
		align-items: center;
		gap: 12px;
		flex: 1;
		min-width: 200px;
	}

	/* Custom Cyber Slider */
	.cyber-slider {
		flex: 1;
		height: 6px;
		-webkit-appearance: none;
		appearance: none;
		background: linear-gradient(90deg, rgba(0, 255, 213, 0.15), rgba(59, 130, 246, 0.15));
		border-radius: 3px;
		outline: none;
		max-width: 280px;
	}

	.cyber-slider::-webkit-slider-thumb {
		-webkit-appearance: none;
		appearance: none;
		width: 18px;
		height: 18px;
		background: linear-gradient(135deg, #00ffd5, #3b82f6);
		border-radius: 50%;
		cursor: pointer;
		box-shadow: 0 0 12px rgba(0, 255, 213, 0.5);
		transition: box-shadow 0.2s ease;
	}

	.cyber-slider::-webkit-slider-thumb:hover {
		box-shadow: 0 0 20px rgba(0, 255, 213, 0.8);
	}

	.cyber-slider::-moz-range-thumb {
		width: 18px;
		height: 18px;
		background: linear-gradient(135deg, #00ffd5, #3b82f6);
		border-radius: 50%;
		cursor: pointer;
		border: none;
		box-shadow: 0 0 12px rgba(0, 255, 213, 0.5);
	}

	.scale-readout {
		display: flex;
		align-items: baseline;
		gap: 4px;
		min-width: 85px;
	}

	.shard-count {
		font-size: 1.5rem;
		font-weight: 700;
		color: #fff;
		font-variant-numeric: tabular-nums;
		text-shadow: 0 0 10px rgba(0, 255, 213, 0.3);
	}

	.shard-label {
		font-size: 0.75rem;
		color: rgba(255, 255, 255, 0.5);
		text-transform: uppercase;
		letter-spacing: 0.03em;
	}

	.scale-lps-badge {
		display: flex;
		align-items: baseline;
		gap: 4px;
		padding: 6px 14px;
		background: linear-gradient(135deg, rgba(0, 255, 213, 0.15), rgba(59, 130, 246, 0.1));
		border: 1px solid rgba(0, 255, 213, 0.3);
		border-radius: 20px;
	}

	.lps-value {
		font-size: 1.125rem;
		font-weight: 700;
		color: #00ffd5;
		font-variant-numeric: tabular-nums;
	}

	.lps-unit {
		font-size: 0.6875rem;
		color: rgba(0, 255, 213, 0.7);
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}

	/* RPS Mini Grid */
	.rps-mini-grid {
		display: grid;
		grid-template-columns: repeat(6, 1fr);
		gap: 8px;
		margin-top: 12px;
		padding-top: 12px;
		border-top: 1px solid rgba(255, 255, 255, 0.06);
	}

	.rps-mini-item {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 2px;
		padding: 6px 4px;
		background: rgba(255, 255, 255, 0.02);
		border-radius: var(--radius-sm);
		transition: background 0.2s ease;
	}

	.rps-mini-item:hover {
		background: rgba(0, 255, 213, 0.08);
	}

	.rps-mini-label {
		font-size: 0.625rem;
		color: rgba(255, 255, 255, 0.4);
		text-transform: uppercase;
		letter-spacing: 0.03em;
	}

	.rps-mini-value {
		font-size: 1rem;
		font-weight: 700;
		color: rgba(59, 130, 246, 0.95);
		font-variant-numeric: tabular-nums;
	}

	.rps-mini-value::after {
		content: ' rps';
		font-size: 0.625rem;
		font-weight: 500;
		color: rgba(255, 255, 255, 0.35);
		text-transform: uppercase;
	}

	/* Light theme adjustments for scale panel */
	:global([data-theme='light']) .scale-control-panel {
		background: linear-gradient(135deg, #f8fafc, #f1f5f9);
		border-color: rgba(14, 165, 233, 0.3);
	}

	:global([data-theme='light']) .scale-control-panel::before {
		background: linear-gradient(90deg, transparent, rgba(14, 165, 233, 0.5), transparent);
	}

	:global([data-theme='light']) .scale-panel-title {
		color: #0ea5e9;
	}

	:global([data-theme='light']) .shard-count {
		color: #0f172a;
		text-shadow: none;
	}

	:global([data-theme='light']) .shard-label {
		color: #64748b;
	}

	:global([data-theme='light']) .scale-lps-badge {
		background: linear-gradient(135deg, rgba(14, 165, 233, 0.1), rgba(59, 130, 246, 0.08));
		border-color: rgba(14, 165, 233, 0.3);
	}

	:global([data-theme='light']) .lps-value {
		color: #0ea5e9;
	}

	:global([data-theme='light']) .lps-unit {
		color: rgba(14, 165, 233, 0.7);
	}

	:global([data-theme='light']) .rps-mini-grid {
		border-top-color: rgba(0, 0, 0, 0.06);
	}

	:global([data-theme='light']) .rps-mini-item {
		background: rgba(0, 0, 0, 0.02);
	}

	:global([data-theme='light']) .rps-mini-item:hover {
		background: rgba(14, 165, 233, 0.08);
	}

	:global([data-theme='light']) .rps-mini-label {
		color: #64748b;
	}

	:global([data-theme='light']) .rps-mini-value {
		color: #2563eb;
		font-weight: 700;
	}

	:global([data-theme='light']) .rps-mini-value::after {
		color: #64748b;
	}

	:global([data-theme='light']) .cyber-slider {
		background: linear-gradient(90deg, rgba(14, 165, 233, 0.15), rgba(59, 130, 246, 0.15));
	}

	:global([data-theme='light']) .cyber-slider::-webkit-slider-thumb {
		background: linear-gradient(135deg, #0ea5e9, #3b82f6);
		box-shadow: 0 0 8px rgba(14, 165, 233, 0.4);
	}

	/* Responsive for RPS grid */
	@media (max-width: 640px) {
		.rps-mini-grid {
			grid-template-columns: repeat(3, 1fr);
		}

		.scale-panel-header {
			gap: 12px;
		}

		.scale-panel-main {
			order: 3;
			width: 100%;
			min-width: unset;
		}

		.cyber-slider {
			max-width: none;
		}
	}

	.section-title {
		font-size: 1.125rem;
		font-weight: 600;
		color: var(--text-primary);
		margin: 0 0 8px 0;
		display: flex;
		align-items: center;
		gap: 8px;
	}

	/* Help Tooltip */
	.help-tooltip {
		position: relative;
		display: inline-flex;
		cursor: help;
	}

	.help-icon-circle {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 20px;
		height: 20px;
		background: var(--bg-tertiary);
		border: 1px solid var(--border-secondary);
		border-radius: 50%;
		transition: all 0.2s ease;
	}

	.help-icon-inner {
		width: 12px;
		height: 12px;
		color: var(--text-muted);
		transition: color 0.2s ease;
	}

	.help-tooltip:hover .help-icon-circle {
		border-color: var(--primary);
		background: var(--primary-bg);
	}

	.help-tooltip:hover .help-icon-inner {
		color: var(--primary);
	}

	.tooltip-content {
		position: absolute;
		left: 50%;
		bottom: calc(100% + 8px);
		transform: translateX(-50%);
		width: 280px;
		padding: 12px;
		background: #1e293b;
		border: 1px solid #334155;
		border-radius: 8px;
		font-size: 0.8125rem;
		font-weight: 400;
		line-height: 1.6;
		color: #cbd5e1;
		text-transform: none;
		letter-spacing: normal;
		box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);
		opacity: 0;
		visibility: hidden;
		transition:
			opacity 0.2s ease,
			visibility 0.2s ease;
		z-index: 200;
	}

	:global([data-theme='light']) .tooltip-content {
		background: #ffffff;
		border: 1px solid #e2e8f0;
		color: #475569;
		box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
	}

	.tooltip-content::after {
		content: '';
		position: absolute;
		top: 100%;
		left: 50%;
		transform: translateX(-50%);
		border: 6px solid transparent;
		border-top-color: #1e293b;
	}

	:global([data-theme='light']) .tooltip-content::after {
		border-top-color: #ffffff;
	}

	.help-tooltip:hover .tooltip-content {
		opacity: 1;
		visibility: visible;
	}

	/* Cyber panel tooltip styles */
	.scale-tooltip {
		margin-left: 4px;
	}

	.help-icon-cyber {
		width: 14px;
		height: 14px;
		color: rgba(0, 255, 213, 0.5);
		transition: color 0.2s ease;
	}

	.help-tooltip:hover .help-icon-cyber {
		color: rgba(0, 255, 213, 0.9);
	}

	.tooltip-below {
		left: 50%;
		bottom: auto;
		top: calc(100% + 10px);
		transform: translateX(-50%);
	}

	.tooltip-below::after {
		top: -12px;
		left: 50%;
		transform: translateX(-50%);
		border: 6px solid transparent;
		border-bottom-color: #1e293b;
		border-top-color: transparent;
	}

	:global([data-theme='light']) .tooltip-below::after {
		border-bottom-color: #ffffff;
	}

	:global([data-theme='light']) .help-icon-cyber {
		color: rgba(14, 165, 233, 0.5);
	}

	:global([data-theme='light']) .help-tooltip:hover .help-icon-cyber {
		color: rgba(14, 165, 233, 0.9);
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

	/* Toggle Switch */
	.toggle-switch {
		position: relative;
		display: inline-block;
		width: 44px;
		height: 24px;
		flex-shrink: 0;
		cursor: pointer;
	}

	.toggle-switch.disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.toggle-switch input {
		opacity: 0;
		width: 0;
		height: 0;
	}

	.toggle-slider {
		position: absolute;
		cursor: pointer;
		top: 0;
		left: 0;
		right: 0;
		bottom: 0;
		background-color: var(--bg-tertiary);
		border: 1px solid var(--border-secondary);
		transition: 0.3s;
		border-radius: 24px;
	}

	.toggle-slider::before {
		position: absolute;
		content: '';
		height: 18px;
		width: 18px;
		left: 2px;
		bottom: 2px;
		background-color: var(--text-muted);
		transition: 0.3s;
		border-radius: 50%;
	}

	.toggle-switch input:checked + .toggle-slider {
		background-color: var(--primary);
		border-color: var(--primary);
	}

	.toggle-switch input:checked + .toggle-slider::before {
		background-color: white;
		transform: translateX(20px);
	}

	.toggle-switch input:focus + .toggle-slider {
		box-shadow: 0 0 0 2px var(--primary-bg);
	}

	.toggle-switch.disabled .toggle-slider {
		cursor: not-allowed;
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

	/* Responsive */
	@media (max-width: 768px) {
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
	}
</style>
