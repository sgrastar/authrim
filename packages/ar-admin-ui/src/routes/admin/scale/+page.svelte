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
	import {
		adminControlPlaneAPI,
		type ControlCapacityProfile,
		type ControlCapacityProvisioningOperation,
		type ControlCapacityProvisioningPreview,
		type ControlCapacityScope
	} from '$lib/api/admin-control-plane';
	import {
		adminReadReplicationAPI,
		ReadReplicationApiError,
		type ReadReplicationStatus
	} from '$lib/api/admin-read-replication';
	import WorldMap from '$lib/components/WorldMap.svelte';
	import { Modal, ToggleSwitch } from '$lib/components';
	import AdminPageHeader from '$lib/components/admin/AdminPageHeader.svelte';
	import AdminPageShell from '$lib/components/admin/AdminPageShell.svelte';
	import { tenantStore } from '$lib/stores/tenants.svelte';
	import { LL } from '$i18n/i18n-svelte';

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
		{ key: 'eeur', label: 'EEUR (Eastern Europe)' },
		{ key: 'wnam', label: 'WNAM (Western North America)' },
		{ key: 'oc', label: 'OC (Oceania)' },
		{ key: 'afr', label: 'AFR (Africa)' },
		{ key: 'me', label: 'ME (Middle East)' }
	];

	const DEFAULT_REGIONS = ['apac', 'enam', 'weur', 'wnam'];

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
	let readReplicationStatus = $state<ReadReplicationStatus | null>(null);
	let readReplicationVisible = $state(false);
	let readReplicationLoading = $state(false);
	let readReplicationError = $state('');
	let readReplicationTimer: ReturnType<typeof setTimeout> | undefined;
	let capacityProfile = $state<ControlCapacityProfile>('recommended');
	let capacityScope = $state<ControlCapacityScope>('shared_pool');
	let capacityTenantId = $state('');
	let capacityPreview = $state<ControlCapacityProvisioningPreview | null>(null);
	let capacityOperations = $state<ControlCapacityProvisioningOperation[]>([]);
	let capacityPreviewing = $state(false);
	let capacityRequesting = $state(false);
	let capacityError = $state('');
	let capacitySuccess = $state('');

	// Current configuration from API
	let _currentConfig = $state<ShardConfigState>({
		codeShards: null,
		refreshTokenShards: null,
		revocationShards: null,
		sessionShards: null,
		challengeShards: null,
		regionShards: null
	});

	// Edit state
	let selectedRegions = $state<string[]>([...DEFAULT_REGIONS]);
	let regionDistribution = $state<RegionDistribution>({ apac: 25, enam: 25, weur: 25, wnam: 25 });
	let initialSelectedRegions = $state<string[]>([...DEFAULT_REGIONS]);
	let initialRegionDistribution = $state<RegionDistribution>({
		apac: 25,
		enam: 25,
		weur: 25,
		wnam: 25
	});

	let scaleState = $state<ScaleState>({
		unifiedScale: 4,
		clientBasedCoeff: 0.5
	});

	// Initial values for diff comparison
	let initialScaleState = $state<ScaleState>({
		unifiedScale: 4,
		clientBasedCoeff: 0.5
	});

	// =========================================================================
	// Derived Values
	// =========================================================================

	// LPS estimation for the full login flow, based on historical DO shard measurements.
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
			// Client-based (coefficient applied)
			par: clientBased,
			deviceCode: clientBased,
			ciba: clientBased,
			dpop: clientBased
		};
	}

	let calculatedShards = $derived(calculateShardCounts(scaleState));

	// Check if there are changes to save
	let scaleChanged = $derived(
		scaleState.unifiedScale !== initialScaleState.unifiedScale ||
			scaleState.clientBasedCoeff !== initialScaleState.clientBasedCoeff
	);
	let regionChanged = $derived(
		JSON.stringify([...selectedRegions].sort()) !==
			JSON.stringify([...initialSelectedRegions].sort()) ||
			JSON.stringify(regionDistribution) !== JSON.stringify(initialRegionDistribution)
	);
	let hasChanges = $derived(scaleChanged || regionChanged);
	let allowedRegions = $derived(_currentConfig.regionShards?.residency.allowedRegions ?? []);

	// Build diff items for dialog
	let diffItems = $derived.by(() => {
		const items: DiffItem[] = [];
		if (scaleState.unifiedScale !== initialScaleState.unifiedScale) {
			items.push({
				label: $LL.admin_scale_diff_scale(),
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
	onMount(() => {
		void loadAllConfigs();
		void loadReadReplicationStatus();
		void loadCapacityTenants();
		return () => {
			if (readReplicationTimer) clearTimeout(readReplicationTimer);
		};
	});

	async function loadCapacityTenants() {
		if (!tenantStore.loaded) await tenantStore.load();
		if (!capacityTenantId) capacityTenantId = tenantStore.defaultTenantId;
	}

	function resetCapacityPreview() {
		capacityPreview = null;
		capacityOperations = [];
		capacityError = '';
		capacitySuccess = '';
	}

	function capacityRequest() {
		return {
			profile: capacityProfile,
			scope: capacityScope,
			tenantId: capacityScope === 'tenant_exclusive' ? capacityTenantId || null : null
		};
	}

	async function previewD1Capacity() {
		capacityPreviewing = true;
		capacityError = '';
		capacitySuccess = '';
		capacityOperations = [];
		try {
			capacityPreview = (await adminControlPlaneAPI.previewCapacity(capacityRequest())).preview;
		} catch (caught) {
			capacityPreview = null;
			capacityError =
				caught instanceof Error ? caught.message : $LL.admin_scale_d1_capacity_preview_failed();
		} finally {
			capacityPreviewing = false;
		}
	}

	async function requestD1Capacity() {
		capacityRequesting = true;
		capacityError = '';
		capacitySuccess = '';
		try {
			const response = await adminControlPlaneAPI.requestCapacity(capacityRequest());
			capacityPreview = response.result.preview;
			capacityOperations = response.result.operations;
			capacitySuccess = $LL.admin_scale_d1_capacity_requested();
		} catch (caught) {
			capacityError =
				caught instanceof Error ? caught.message : $LL.admin_scale_d1_capacity_request_failed();
		} finally {
			capacityRequesting = false;
		}
	}

	function scheduleReadReplicationPoll(status: ReadReplicationStatus) {
		if (readReplicationTimer) clearTimeout(readReplicationTimer);
		readReplicationTimer = undefined;
		if (status.aggregateStatus === 'updating') {
			readReplicationTimer = setTimeout(() => void loadReadReplicationStatus(), 3000);
		}
	}

	async function loadReadReplicationStatus() {
		if (readReplicationTimer) clearTimeout(readReplicationTimer);
		readReplicationTimer = undefined;
		try {
			const status = await adminReadReplicationAPI.get();
			readReplicationStatus = status;
			readReplicationVisible = true;
			readReplicationError = '';
			scheduleReadReplicationPoll(status);
		} catch (err) {
			if (err instanceof ReadReplicationApiError && err.status === 403) {
				readReplicationVisible = false;
				readReplicationStatus = null;
				return;
			}
			readReplicationVisible = true;
			readReplicationError = $LL.admin_scale_read_replication_load_failed();
		}
	}

	async function setReadReplication(enabled: boolean) {
		if (!readReplicationStatus || readReplicationLoading) return;
		readReplicationLoading = true;
		readReplicationError = '';
		try {
			const status = await adminReadReplicationAPI.setEnabled(enabled);
			readReplicationStatus = status;
			scheduleReadReplicationPoll(status);
		} catch {
			const updateError = $LL.admin_scale_read_replication_update_failed();
			await loadReadReplicationStatus();
			readReplicationError = updateError;
		} finally {
			readReplicationLoading = false;
		}
	}

	function readReplicationStatusLabel(status: ReadReplicationStatus): string {
		switch (status.aggregateStatus) {
			case 'on':
				return $LL.admin_scale_read_replication_on();
			case 'off':
				return $LL.admin_scale_read_replication_off();
			case 'updating':
				return $LL.admin_scale_read_replication_updating();
			case 'attention_required':
				return $LL.admin_scale_read_replication_attention();
		}
	}

	async function loadAllConfigs() {
		loading = true;
		error = '';
		try {
			const [code, revocation, session, challenge, region, refreshToken] = await Promise.all([
				adminInfrastructureAPI.getCodeShards(),
				adminInfrastructureAPI.getRevocationShards(),
				adminInfrastructureAPI.getSessionShards(),
				adminInfrastructureAPI.getChallengeShards(),
				adminInfrastructureAPI.getRegionShards(),
				adminInfrastructureAPI.getRefreshTokenSharding().catch(() => null)
			]);

			_currentConfig = {
				codeShards: code,
				revocationShards: revocation,
				sessionShards: session,
				challengeShards: challenge,
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
				const activeRegionEntries = Object.entries(region.currentRegions).filter(
					([, data]) => data.shardCount > 0
				);
				const regions = activeRegionEntries.map(([key]) => key);
				const total = region.currentTotalShards || 0;
				if (regions.length > 0 && total > 0) {
					selectedRegions = regions;
					const dist: RegionDistribution = {};
					let allocated = 0;
					for (const [index, [key, data]] of activeRegionEntries.entries()) {
						const percentage =
							index === activeRegionEntries.length - 1
								? 100 - allocated
								: Math.round((data.shardCount / total) * 100);
						dist[key] = percentage;
						allocated += percentage;
					}
					regionDistribution = dist;
					initialSelectedRegions = [...regions];
					initialRegionDistribution = { ...dist };
				}
			}
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_scale_load_failed();
		} finally {
			loading = false;
		}
	}

	// =========================================================================
	// Region Functions
	// =========================================================================
	function toggleRegion(regionKey: string) {
		if (!allowedRegions.includes(regionKey)) return;
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
		if (advancedOpen && scaleChanged) {
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
				adminInfrastructureAPI.updateRefreshTokenSharding(shards.refreshToken)
			]);

			// Update region distribution if changed
			if (selectedRegions.length > 0) {
				await adminInfrastructureAPI.updateRegionShards(
					scaleState.unifiedScale,
					regionDistribution
				);
			}

			showSuccess($LL.admin_scale_saved());
			initialScaleState = { ...scaleState };
			initialSelectedRegions = [...selectedRegions];
			initialRegionDistribution = { ...regionDistribution };
			await loadAllConfigs();
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_scale_save_failed();
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

<svelte:head>
	<title>{$LL.admin_scale_head_title()}</title>
</svelte:head>

<AdminPageShell>
	<div class="scale-page">
		<AdminPageHeader title={$LL.admin_scale_title()} description={$LL.admin_scale_description()} />

		<!-- Current Scale Summary - Shows saved server config, not live slider -->
		<div class="current-badge-wrapper">
			<div class="current-badge">
				<i class="i-ph-gauge current-badge-icon"></i>
				{#if loading}
					<span class="loading-text">{$LL.admin_scale_loading()}</span>
				{:else}
					<span class="current-badge-label">{$LL.admin_scale_current()}</span>
					<span class="current-badge-shards"
						>{$LL.admin_scale_shards_unit_title({
							count: initialScaleState.unifiedScale
						})}</span
					>
					<span class="current-badge-lps"
						>{$LL.admin_scale_login_per_sec({ count: initialLPS })}</span
					>
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
				<span>{$LL.admin_scale_load_configuration()}</span>
			</div>
		{:else}
			<section class="config-section d1-capacity-section">
				<div class="capacity-heading">
					<div>
						<h2 class="section-title">{$LL.admin_scale_d1_capacity()}</h2>
						<p class="section-description">{$LL.admin_scale_d1_capacity_status()}</p>
					</div>
					<i class="i-ph-database capacity-heading-icon"></i>
				</div>

				<div class="capacity-controls">
					<fieldset class="capacity-fieldset">
						<legend>{$LL.admin_scale_d1_scope()}</legend>
						<div class="segmented-control">
							<label class:active={capacityScope === 'shared_pool'}>
								<input
									type="radio"
									name="capacity-scope"
									value="shared_pool"
									bind:group={capacityScope}
									onchange={resetCapacityPreview}
								/>
								<span>{$LL.admin_scale_d1_scope_shared()}</span>
							</label>
							<label class:active={capacityScope === 'tenant_exclusive'}>
								<input
									type="radio"
									name="capacity-scope"
									value="tenant_exclusive"
									bind:group={capacityScope}
									onchange={resetCapacityPreview}
								/>
								<span>{$LL.admin_scale_d1_scope_tenant()}</span>
							</label>
						</div>
					</fieldset>

					{#if capacityScope === 'tenant_exclusive'}
						<label class="capacity-select-field">
							<span>{$LL.admin_scale_d1_tenant()}</span>
							<select bind:value={capacityTenantId} onchange={resetCapacityPreview}>
								{#each tenantStore.activeTenants as tenant (tenant.id)}
									<option value={tenant.id}>{tenant.name}</option>
								{/each}
							</select>
						</label>
					{/if}

					<fieldset class="capacity-fieldset capacity-profile-fieldset">
						<legend>{$LL.admin_scale_d1_profile()}</legend>
						<div class="capacity-profile-options">
							<label class:active={capacityProfile === 'minimum'}>
								<input
									type="radio"
									name="capacity-profile"
									value="minimum"
									bind:group={capacityProfile}
									onchange={resetCapacityPreview}
								/>
								<strong>{$LL.admin_scale_d1_profile_minimum()}</strong>
								<span>{$LL.admin_scale_d1_profile_minimum_detail()}</span>
							</label>
							<label class:active={capacityProfile === 'recommended'}>
								<input
									type="radio"
									name="capacity-profile"
									value="recommended"
									bind:group={capacityProfile}
									onchange={resetCapacityPreview}
								/>
								<strong>{$LL.admin_scale_d1_profile_recommended()}</strong>
								<span>{$LL.admin_scale_d1_profile_recommended_detail()}</span>
							</label>
							<label class:active={capacityProfile === 'extra_headroom'}>
								<input
									type="radio"
									name="capacity-profile"
									value="extra_headroom"
									bind:group={capacityProfile}
									onchange={resetCapacityPreview}
								/>
								<strong>{$LL.admin_scale_d1_profile_extra()}</strong>
								<span>{$LL.admin_scale_d1_profile_extra_detail()}</span>
							</label>
						</div>
					</fieldset>
				</div>

				<div class="capacity-actions">
					<button
						type="button"
						class="btn btn-secondary"
						disabled={capacityPreviewing ||
							capacityRequesting ||
							(capacityScope === 'tenant_exclusive' && !capacityTenantId)}
						onclick={previewD1Capacity}
					>
						<i class:animate-spin={capacityPreviewing} class="i-ph-magnifying-glass"></i>
						<span>{$LL.admin_scale_d1_preview()}</span>
					</button>
					<button
						type="button"
						class="btn btn-primary"
						disabled={!capacityPreview?.available ||
							capacityPreview.d1DatabasesAdded === 0 ||
							capacityPreviewing ||
							capacityRequesting}
						onclick={requestD1Capacity}
					>
						<i class:animate-spin={capacityRequesting} class="i-ph-plus-circle"></i>
						<span>{$LL.admin_scale_d1_request()}</span>
					</button>
				</div>

				{#if capacityError}
					<p class="capacity-message capacity-message-error" role="alert">{capacityError}</p>
				{/if}
				{#if capacitySuccess}
					<p class="capacity-message capacity-message-success" role="status">{capacitySuccess}</p>
				{/if}

				{#if capacityPreview}
					<div class="capacity-preview" aria-live="polite">
						<div class="capacity-summary">
							<div>
								<span>{$LL.admin_scale_d1_units()}</span>
								<strong>{capacityPreview.capacityUnitsAdded}</strong>
							</div>
							<div>
								<span>{$LL.admin_scale_d1_databases()}</span>
								<strong>{capacityPreview.d1DatabasesAdded}</strong>
							</div>
							<div>
								<span>{$LL.admin_scale_d1_projected_total()}</span>
								<strong>{capacityPreview.projectedEnvironmentD1Count}</strong>
							</div>
						</div>
						{#if !capacityPreview.available}
							<p class="capacity-message capacity-message-error">
								{$LL.admin_scale_d1_unavailable()}
							</p>
						{:else if capacityPreview.targets.length === 0}
							<p class="capacity-message">{$LL.admin_scale_d1_no_change()}</p>
						{:else}
							<div class="capacity-target-list">
								{#each capacityPreview.targets as target (target.operationId)}
									<div class="capacity-target-row">
										<div>
											<strong>{target.dataRole}</strong>
											<span>{target.residencyPartition} · {target.databaseName}</span>
										</div>
										<div class="capacity-target-bindings">
											<code>{target.bindingRef}</code>
											<span>{target.workerScripts.join(', ')}</span>
										</div>
									</div>
								{/each}
							</div>
						{/if}
						{#if capacityOperations.length > 0}
							<div class="capacity-operation-list">
								{#each capacityOperations as operation (operation.operationId)}
									<div>
										<span>{operation.operationId}</span>
										<strong>{operation.lastErrorCode ?? operation.status}</strong>
									</div>
								{/each}
							</div>
						{/if}
					</div>
				{/if}
			</section>

			<!-- Section 1: Scale Configuration (Compact Control Panel) -->
			<section class="scale-control-panel">
				<div class="scale-panel-header">
					<div class="scale-panel-title">
						<i class="i-ph-sliders-horizontal"></i>
						<span>{$LL.admin_scale_system_scale()}</span>
						<span class="help-tooltip scale-tooltip">
							<i class="i-ph-question help-icon-cyber"></i>
							<span class="tooltip-content tooltip-below">
								{$LL.admin_scale_system_scale_help()}
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
							<span class="shard-label">{$LL.admin_scale_shards_unit()}</span>
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
						<span class="rps-mini-value">{estimateComponentRPS(calculatedShards.refreshToken)}</span
						>
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
				</div>
			</section>

			<!-- Section 2: World Map Visualization -->
			<section class="map-section">
				<WorldMap {selectedRegions} {regionDistribution} onRegionClick={toggleRegion} />
			</section>

			<!-- Section 3: Region Distribution -->
			<section class="config-section">
				<h2 class="section-title">
					{$LL.admin_scale_region_distribution()}
					<span class="help-tooltip">
						<span class="help-icon-circle">
							<i class="i-ph-question help-icon-inner"></i>
						</span>
						<span class="tooltip-content">
							{$LL.admin_scale_region_distribution_help()}
						</span>
					</span>
				</h2>
				<p class="section-description">
					<i class="i-ph-info info-icon"></i>
					{$LL.admin_scale_region_distribution_description({
						ratio: $LL.admin_scale_request_routing_ratio()
					})}
				</p>

				<div class="region-distribution-list">
					{#each ALL_REGIONS as region (region.key)}
						{@const isSelected = selectedRegions.includes(region.key)}
						{@const isLastSelected = selectedRegions.length === 1 && isSelected}
						{@const isAllowed = allowedRegions.includes(region.key)}
						<div class="region-row" class:selected={isSelected} class:disabled={!isAllowed}>
							<label class="toggle-switch" class:disabled={isLastSelected || !isAllowed}>
								<input
									type="checkbox"
									checked={isSelected}
									onchange={() => toggleRegion(region.key)}
									disabled={isLastSelected || !isAllowed}
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
					<p class="slider-note">{$LL.admin_scale_slider_note()}</p>
				{/if}
			</section>

			{#if readReplicationVisible}
				<section class="config-section read-replication-section">
					<div class="read-replication-row">
						<div class="read-replication-heading">
							<h2 class="section-title">{$LL.admin_scale_read_replication()}</h2>
							{#if readReplicationStatus}
								<div class="read-replication-state">
									<span
										class="status-dot"
										class:status-on={readReplicationStatus.aggregateStatus === 'on'}
										class:status-updating={readReplicationStatus.aggregateStatus === 'updating'}
										class:status-attention={readReplicationStatus.aggregateStatus ===
											'attention_required'}
									></span>
									<span>{readReplicationStatusLabel(readReplicationStatus)}</span>
									{#if readReplicationStatus.targetCount > 0}
										<span class="read-replication-progress">
											{readReplicationStatus.convergedTargetCount} / {readReplicationStatus.targetCount}
										</span>
									{/if}
								</div>
							{/if}
						</div>
						<div class="read-replication-actions">
							{#if readReplicationStatus?.aggregateStatus === 'attention_required'}
								<button
									type="button"
									class="icon-button"
									title={$LL.admin_scale_read_replication_retry()}
									aria-label={$LL.admin_scale_read_replication_retry()}
									disabled={readReplicationLoading}
									onclick={() =>
										setReadReplication(readReplicationStatus?.desiredMode === 'enabled')}
								>
									<i class:animate-spin={readReplicationLoading} class="i-ph-arrow-clockwise"></i>
								</button>
							{/if}
							<ToggleSwitch
								checked={readReplicationStatus?.desiredMode === 'enabled'}
								disabled={!readReplicationStatus ||
									readReplicationLoading ||
									readReplicationStatus.aggregateStatus === 'updating'}
								ariaLabel={$LL.admin_scale_read_replication_toggle()}
								onchange={setReadReplication}
							/>
						</div>
					</div>
					{#if readReplicationError}
						<p class="read-replication-error" role="alert">{readReplicationError}</p>
					{/if}
				</section>
			{/if}

			<!-- Section 4: Advanced Settings -->
			<section class="config-section advanced-section">
				<button class="advanced-toggle" onclick={() => (advancedOpen = !advancedOpen)}>
					<i class={advancedOpen ? 'i-ph-caret-down' : 'i-ph-caret-right'}></i>
					<span>{$LL.admin_scale_advanced_settings()}</span>
				</button>

				{#if advancedOpen}
					<div class="advanced-content">
						<!-- Estimation Model -->
						<div class="advanced-group">
							<h4>{$LL.admin_scale_estimation_model()}</h4>
							<p class="advanced-description">
								{#each $LL
									.admin_scale_estimation_model_description()
									.split('\n') as line, index (index)}
									{#if index > 0}<br />{/if}{line}
								{/each}
							</p>
						</div>

						<!-- Client-based Coefficient -->
						<div class="advanced-group">
							<h4>{$LL.admin_scale_client_based_coefficient()}</h4>
							<p class="advanced-description">{$LL.admin_scale_client_based_applies_to()}</p>
							<select bind:value={scaleState.clientBasedCoeff} class="coeff-select">
								<option value={0.25}>{$LL.admin_scale_coeff_low()}</option>
								<option value={0.5}>{$LL.admin_scale_coeff_default()}</option>
								<option value={1.0}>{$LL.admin_scale_coeff_high()}</option>
							</select>
							<p class="coeff-result">
								{$LL.admin_scale_coeff_current({
									shards: Math.max(
										4,
										Math.floor(scaleState.unifiedScale * scaleState.clientBasedCoeff)
									),
									rps: estimateComponentRPS(
										Math.max(4, Math.floor(scaleState.unifiedScale * scaleState.clientBasedCoeff))
									)
								})}
							</p>
						</div>

						<!-- Individual Shard Settings -->
						<div class="advanced-group">
							<h4>{$LL.admin_scale_individual_shard_settings()}</h4>
							<p class="advanced-description warning">
								<i class="i-ph-warning"></i>
								{$LL.admin_scale_auth_refresh_sync_warning()}
							</p>
							<div class="shard-grid">
								<div class="shard-item">
									<span class="shard-label">AuthCode</span>
									<span class="shard-value">{calculatedShards.authCode}</span>
									<i
										class="i-ph-lock-simple lock-icon"
										title={$LL.admin_scale_synced_with_refresh_token()}
									></i>
								</div>
								<div class="shard-item">
									<span class="shard-label">RefreshToken</span>
									<span class="shard-value">{calculatedShards.refreshToken}</span>
									<i
										class="i-ph-lock-simple lock-icon"
										title={$LL.admin_scale_synced_with_auth_code()}
									></i>
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
				<button
					class="btn btn-primary"
					onclick={handleSaveClick}
					disabled={loading || saving || !hasChanges}
				>
					{#if saving}
						<i class="i-ph-circle-notch animate-spin"></i>
						<span>{$LL.admin_scale_saving()}</span>
					{:else}
						<i class="i-ph-floppy-disk"></i>
						<span>{$LL.admin_scale_save_changes()}</span>
					{/if}
				</button>
			</div>
		{/if}

		<!-- Diff Confirmation Dialog -->
		<Modal
			open={showDiffDialog}
			onClose={() => (showDiffDialog = false)}
			title={$LL.admin_scale_confirm_changes()}
			size="sm"
		>
			<p class="dialog-subtitle">{$LL.admin_scale_dialog_subtitle()}</p>

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
				{$LL.admin_scale_changes_new_sessions_only()}
			</p>

			{#snippet footer()}
				<button class="btn btn-secondary" onclick={() => (showDiffDialog = false)}
					>{$LL.admin_scale_cancel()}</button
				>
				<button class="btn btn-primary" onclick={saveAllChanges}
					>{$LL.admin_scale_save_changes()}</button
				>
			{/snippet}
		</Modal>
	</div>
</AdminPageShell>

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
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: 100px;
		font-size: 0.875rem;
	}

	.current-badge-icon {
		width: 16px;
		height: 16px;
		color: var(--color-text-muted);
	}

	.current-badge-label {
		font-weight: 500;
		color: var(--color-text-muted);
	}

	.current-badge-shards {
		font-weight: 700;
		color: var(--color-text);
	}

	.current-badge-lps {
		font-size: 0.8125rem;
		color: var(--color-text-muted);
	}

	.loading-text {
		color: var(--color-text-muted);
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
		background: color-mix(in srgb, var(--color-success) 14%, transparent);
		color: var(--color-success);
		border: 1px solid var(--color-success);
	}

	.alert-error {
		background: color-mix(in srgb, var(--color-danger) 12%, transparent);
		color: var(--color-danger);
		border: 1px solid var(--color-danger);
	}

	.loading-state {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 12px;
		padding: 48px;
		color: var(--color-text-muted);
	}

	/* Sections */
	.config-section {
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-lg);
		padding: 24px;
		margin-bottom: 24px;
	}

	.d1-capacity-section {
		padding: 20px;
	}

	.capacity-heading {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 16px;
	}

	.capacity-heading .section-description {
		margin-bottom: 18px;
	}

	.capacity-heading-icon {
		width: 24px;
		height: 24px;
		color: var(--color-accent);
		flex-shrink: 0;
	}

	.capacity-controls {
		display: grid;
		grid-template-columns: minmax(220px, 0.8fr) minmax(320px, 1.2fr);
		gap: 16px;
	}

	.capacity-fieldset {
		min-width: 0;
		margin: 0;
		padding: 0;
		border: 0;
	}

	.capacity-fieldset legend,
	.capacity-select-field > span {
		display: block;
		margin-bottom: 7px;
		font-size: 0.75rem;
		font-weight: 600;
		color: var(--color-text-muted);
	}

	.segmented-control {
		display: grid;
		grid-template-columns: 1fr 1fr;
		border: 1px solid var(--color-border);
		border-radius: 6px;
		overflow: hidden;
	}

	.segmented-control label {
		position: relative;
		padding: 9px 12px;
		font-size: 0.8125rem;
		text-align: center;
		color: var(--color-text-muted);
		background: var(--color-surface-muted);
		cursor: pointer;
	}

	.segmented-control label + label {
		border-left: 1px solid var(--color-border);
	}

	.segmented-control label.active {
		color: var(--color-text);
		background: var(--color-accent-muted);
	}

	.segmented-control input,
	.capacity-profile-options input {
		position: absolute;
		opacity: 0;
		pointer-events: none;
	}

	.capacity-select-field {
		grid-column: 1;
	}

	.capacity-select-field select {
		width: 100%;
		min-height: 38px;
		padding: 8px 10px;
		border: 1px solid var(--color-border);
		border-radius: 6px;
		background: var(--color-surface);
		color: var(--color-text);
	}

	.capacity-profile-fieldset {
		grid-column: 2;
		grid-row: 1 / span 2;
	}

	.capacity-profile-options {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 8px;
	}

	.capacity-profile-options label {
		position: relative;
		display: flex;
		min-width: 0;
		min-height: 72px;
		flex-direction: column;
		gap: 5px;
		padding: 11px;
		border: 1px solid var(--color-border);
		border-radius: 6px;
		background: var(--color-surface-muted);
		cursor: pointer;
	}

	.capacity-profile-options label.active {
		border-color: var(--color-accent);
		background: var(--color-accent-muted);
	}

	.capacity-profile-options strong {
		font-size: 0.8125rem;
		color: var(--color-text);
	}

	.capacity-profile-options span {
		font-size: 0.6875rem;
		line-height: 1.35;
		color: var(--color-text-muted);
	}

	.capacity-actions {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
		margin-top: 16px;
	}

	.capacity-message {
		margin: 12px 0 0;
		font-size: 0.8125rem;
		color: var(--color-text-muted);
	}

	.capacity-message-error {
		color: var(--color-danger);
	}

	.capacity-message-success {
		color: var(--color-success);
	}

	.capacity-preview {
		margin-top: 16px;
		padding-top: 16px;
		border-top: 1px solid var(--color-border);
	}

	.capacity-summary {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 1px;
		background: var(--color-border);
		border: 1px solid var(--color-border);
		border-radius: 6px;
		overflow: hidden;
	}

	.capacity-summary > div {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		padding: 10px 12px;
		background: var(--color-surface-muted);
	}

	.capacity-summary span {
		font-size: 0.75rem;
		color: var(--color-text-muted);
	}

	.capacity-summary strong {
		font-size: 1rem;
		font-variant-numeric: tabular-nums;
		color: var(--color-text);
	}

	.capacity-target-list,
	.capacity-operation-list {
		display: flex;
		flex-direction: column;
		gap: 1px;
		margin-top: 12px;
		background: var(--color-border);
		border: 1px solid var(--color-border);
		border-radius: 6px;
		overflow: hidden;
	}

	.capacity-target-row,
	.capacity-operation-list > div {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		padding: 10px 12px;
		background: var(--color-surface);
	}

	.capacity-target-row > div,
	.capacity-target-bindings {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 3px;
	}

	.capacity-target-row strong,
	.capacity-operation-list strong {
		font-size: 0.8125rem;
		color: var(--color-text);
	}

	.capacity-target-row span,
	.capacity-operation-list span {
		overflow-wrap: anywhere;
		font-size: 0.75rem;
		color: var(--color-text-muted);
	}

	.capacity-target-bindings {
		align-items: flex-end;
		text-align: right;
	}

	.capacity-target-bindings code {
		font-size: 0.6875rem;
		color: var(--color-accent);
	}

	@media (max-width: 720px) {
		.capacity-controls {
			grid-template-columns: 1fr;
		}

		.capacity-profile-fieldset,
		.capacity-select-field {
			grid-column: 1;
			grid-row: auto;
		}

		.capacity-profile-options {
			grid-template-columns: 1fr;
		}

		.capacity-profile-options label {
			min-height: 0;
		}

		.capacity-target-row {
			align-items: flex-start;
			flex-direction: column;
		}

		.capacity-target-bindings {
			align-items: flex-start;
			text-align: left;
		}
	}

	.read-replication-section {
		padding-block: 18px;
	}

	.read-replication-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 20px;
	}

	.read-replication-heading {
		min-width: 0;
	}

	.read-replication-heading .section-title {
		margin-bottom: 6px;
	}

	.read-replication-state {
		display: flex;
		align-items: center;
		gap: 7px;
		font-size: 0.8125rem;
		color: var(--color-text-muted);
	}

	.status-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--color-text-muted);
	}

	.status-dot.status-on {
		background: var(--color-success);
	}

	.status-dot.status-updating {
		background: var(--color-warning);
	}

	.status-dot.status-attention {
		background: var(--color-error);
	}

	.read-replication-progress {
		font-variant-numeric: tabular-nums;
	}

	.read-replication-actions {
		display: flex;
		align-items: center;
		gap: 10px;
		flex-shrink: 0;
	}

	.icon-button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 32px;
		height: 32px;
		padding: 0;
		border: 1px solid var(--color-border);
		border-radius: 6px;
		background: var(--color-surface);
		color: var(--color-text);
		cursor: pointer;
	}

	.icon-button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.read-replication-error {
		margin: 10px 0 0;
		font-size: 0.8125rem;
		color: var(--color-error);
	}

	@media (max-width: 560px) {
		.read-replication-row {
			align-items: flex-start;
		}

		.read-replication-state {
			flex-wrap: wrap;
		}
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
		color: var(--color-text);
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
		background: var(--color-surface-muted);
		border: 1px solid var(--color-border);
		border-radius: 50%;
		transition: all 0.2s ease;
	}

	.help-icon-inner {
		width: 12px;
		height: 12px;
		color: var(--color-text-muted);
		transition: color 0.2s ease;
	}

	.help-tooltip:hover .help-icon-circle {
		border-color: var(--color-accent);
		background: var(--color-accent-muted);
	}

	.help-tooltip:hover .help-icon-inner {
		color: var(--color-accent);
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
		color: var(--color-text-muted);
		font-size: 0.875rem;
		margin: 0 0 20px 0;
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.info-icon {
		color: var(--color-accent);
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
		background: var(--color-surface-muted);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		transition: all var(--transition-fast);
	}

	.region-row:hover {
		border-color: var(--color-border);
	}

	.region-row.selected {
		background: var(--color-accent-muted);
		border-color: var(--color-accent);
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
		background-color: var(--color-surface-muted);
		border: 1px solid var(--color-border);
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
		background-color: var(--color-text-muted);
		transition: 0.3s;
		border-radius: 50%;
	}

	.toggle-switch input:checked + .toggle-slider {
		background-color: var(--color-accent);
		border-color: var(--color-accent);
	}

	.toggle-switch input:checked + .toggle-slider::before {
		background-color: white;
		transform: translateX(20px);
	}

	.toggle-switch input:focus + .toggle-slider {
		box-shadow: 0 0 0 2px var(--color-accent-muted);
	}

	.toggle-switch.disabled .toggle-slider {
		cursor: not-allowed;
	}

	.region-label {
		width: 220px;
		font-size: 0.875rem;
		color: var(--color-text);
		font-weight: 500;
	}

	.region-slider {
		flex: 1;
		height: 6px;
		accent-color: var(--color-accent);
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
		color: var(--color-text);
	}

	.region-percent.inactive {
		color: var(--color-text-muted);
		font-weight: 400;
	}

	.slider-note {
		font-size: 0.75rem;
		color: var(--color-text-muted);
		margin: 12px 0 0;
		font-style: italic;
	}

	/* Advanced Section */
	.advanced-section {
		background: var(--color-surface-muted);
	}

	.advanced-toggle {
		display: flex;
		align-items: center;
		gap: 8px;
		background: none;
		border: none;
		color: var(--color-text);
		font-size: 0.9375rem;
		font-weight: 600;
		cursor: pointer;
		padding: 0;
	}

	.advanced-toggle:hover {
		color: var(--color-accent);
	}

	.advanced-content {
		margin-top: 20px;
		padding-top: 20px;
		border-top: 1px solid var(--color-border);
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
		color: var(--color-text);
		margin: 0 0 8px 0;
	}

	.advanced-description {
		font-size: 0.8125rem;
		color: var(--color-text-muted);
		margin: 0 0 12px 0;
		line-height: 1.6;
	}

	.advanced-description.warning {
		display: flex;
		align-items: center;
		gap: 6px;
		color: var(--color-warning);
		background: color-mix(in srgb, var(--color-warning) 14%, transparent);
		padding: 8px 12px;
		border-radius: var(--radius-sm);
	}

	.coeff-select {
		padding: 8px 12px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		background: var(--color-surface);
		color: var(--color-text);
		font-size: 0.875rem;
	}

	.coeff-result {
		font-size: 0.8125rem;
		color: var(--color-text-muted);
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
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
	}

	.shard-item.client-based {
		opacity: 0.8;
		border-style: dashed;
	}

	.shard-label {
		font-size: 0.8125rem;
		color: var(--color-text-muted);
	}

	.shard-value {
		font-size: 0.9375rem;
		font-weight: 600;
		color: var(--color-text);
	}

	.lock-icon {
		color: var(--color-warning);
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
		background: var(--color-accent);
		color: white;
	}

	.btn-primary:hover:not(:disabled) {
		background: var(--color-accent);
	}

	.btn-secondary {
		background: var(--color-surface-muted);
		color: var(--color-text);
		border: 1px solid var(--color-border);
	}

	.btn-secondary:hover:not(:disabled) {
		background: var(--color-surface-muted);
	}

	.btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	/* Dialog */
	.dialog-subtitle {
		font-size: 0.875rem;
		color: var(--color-text-muted);
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
		border-bottom: 1px solid var(--color-border);
	}

	.diff-list li:last-child {
		border-bottom: none;
	}

	.diff-label {
		color: var(--color-text-muted);
	}

	.diff-old {
		color: var(--color-danger);
		text-decoration: line-through;
	}

	.diff-arrow {
		color: var(--color-text-muted);
	}

	.diff-new {
		color: var(--color-success);
		font-weight: 600;
	}

	.dialog-warning {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 0.8125rem;
		color: var(--color-warning);
		background: color-mix(in srgb, var(--color-warning) 14%, transparent);
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
