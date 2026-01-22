<script lang="ts">
	import { onMount } from 'svelte';
	import { adminInfrastructureAPI, type ShardConfig } from '$lib/api/admin-infrastructure';

	// State for each shard type
	interface ShardState {
		config: ShardConfig | null;
		loading: boolean;
		saving: boolean;
		error: string;
		editValue: number | null;
	}

	let flowState = $state<ShardState>({
		config: null,
		loading: true,
		saving: false,
		error: '',
		editValue: null
	});

	let codeShards = $state<ShardState>({
		config: null,
		loading: true,
		saving: false,
		error: '',
		editValue: null
	});

	let revocationShards = $state<ShardState>({
		config: null,
		loading: true,
		saving: false,
		error: '',
		editValue: null
	});

	let successMessage = $state('');

	// Load all shard configurations
	onMount(async () => {
		await Promise.all([loadFlowStateShards(), loadCodeShards(), loadRevocationShards()]);
	});

	async function loadFlowStateShards() {
		flowState.loading = true;
		flowState.error = '';
		try {
			flowState.config = await adminInfrastructureAPI.getFlowStateShards();
			flowState.editValue = flowState.config.current;
		} catch (err) {
			flowState.error = err instanceof Error ? err.message : 'Failed to load';
		} finally {
			flowState.loading = false;
		}
	}

	async function loadCodeShards() {
		codeShards.loading = true;
		codeShards.error = '';
		try {
			codeShards.config = await adminInfrastructureAPI.getCodeShards();
			codeShards.editValue = codeShards.config.current;
		} catch (err) {
			codeShards.error = err instanceof Error ? err.message : 'Failed to load';
		} finally {
			codeShards.loading = false;
		}
	}

	async function loadRevocationShards() {
		revocationShards.loading = true;
		revocationShards.error = '';
		try {
			revocationShards.config = await adminInfrastructureAPI.getRevocationShards();
			revocationShards.editValue = revocationShards.config.current;
		} catch (err) {
			revocationShards.error = err instanceof Error ? err.message : 'Failed to load';
		} finally {
			revocationShards.loading = false;
		}
	}

	async function saveFlowStateShards() {
		if (flowState.editValue === null || flowState.editValue === flowState.config?.current) return;

		flowState.saving = true;
		flowState.error = '';
		try {
			await adminInfrastructureAPI.updateFlowStateShards(flowState.editValue);
			successMessage = 'Flow State Shards updated successfully';
			await loadFlowStateShards();
			setTimeout(() => {
				successMessage = '';
			}, 3000);
		} catch (err) {
			flowState.error = err instanceof Error ? err.message : 'Failed to save';
		} finally {
			flowState.saving = false;
		}
	}

	async function saveCodeShards() {
		if (codeShards.editValue === null || codeShards.editValue === codeShards.config?.current)
			return;

		codeShards.saving = true;
		codeShards.error = '';
		try {
			await adminInfrastructureAPI.updateCodeShards(codeShards.editValue);
			successMessage = 'Code Shards updated successfully';
			await loadCodeShards();
			setTimeout(() => {
				successMessage = '';
			}, 3000);
		} catch (err) {
			codeShards.error = err instanceof Error ? err.message : 'Failed to save';
		} finally {
			codeShards.saving = false;
		}
	}

	async function saveRevocationShards() {
		if (
			revocationShards.editValue === null ||
			revocationShards.editValue === revocationShards.config?.current
		)
			return;

		revocationShards.saving = true;
		revocationShards.error = '';
		try {
			await adminInfrastructureAPI.updateRevocationShards(revocationShards.editValue);
			successMessage = 'Revocation Shards updated successfully';
			await loadRevocationShards();
			setTimeout(() => {
				successMessage = '';
			}, 3000);
		} catch (err) {
			revocationShards.error = err instanceof Error ? err.message : 'Failed to save';
		} finally {
			revocationShards.saving = false;
		}
	}

	// Get source badge class
	function getSourceBadgeClass(source: string): string {
		switch (source) {
			case 'env':
				return 'source-badge env';
			case 'kv':
				return 'source-badge kv';
			default:
				return 'source-badge default';
		}
	}

	// Get source badge text
	function getSourceBadgeText(source: string): string {
		switch (source) {
			case 'env':
				return 'Environment';
			case 'kv':
				return 'KV Store';
			default:
				return 'Default';
		}
	}
</script>

<div class="sharding-page">
	<!-- Header -->
	<div class="settings-detail-header">
		<a href="/admin/settings" class="back-link">← Back to Settings</a>
		<h1 class="page-title">Sharding Configuration</h1>
		<p class="page-description">
			Configure shard counts for load distribution. Changes take effect for new sessions only.
		</p>
	</div>

	<!-- Success message -->
	{#if successMessage}
		<div class="alert alert-success">{successMessage}</div>
	{/if}

	<!-- Shard Configuration Cards -->
	<div class="shard-cards">
		<!-- Flow State Shards -->
		<div class="shard-config-card">
			<div class="shard-config-content">
				<div class="shard-config-info">
					<div class="shard-config-header">
						<h3>Flow State Shards</h3>
						{#if flowState.config}
							<span class={getSourceBadgeClass(flowState.config.source)}>
								{getSourceBadgeText(flowState.config.source)}
							</span>
						{/if}
					</div>
					<p class="shard-config-description">
						Controls Flow Engine session distribution. Used for login/consent flows.
						<span class="shard-config-range">(Default: 32, Range: 1-256)</span>
					</p>
					{#if flowState.error}
						<p class="shard-config-error">{flowState.error}</p>
					{/if}
				</div>
				<div class="shard-config-controls">
					{#if flowState.loading}
						<span class="text-secondary">Loading...</span>
					{:else}
						<input
							type="number"
							min="1"
							max="256"
							bind:value={flowState.editValue}
							disabled={flowState.saving || flowState.config?.source === 'env'}
							class="shard-input"
						/>
						<button
							onclick={saveFlowStateShards}
							disabled={flowState.saving ||
								flowState.editValue === flowState.config?.current ||
								flowState.config?.source === 'env'}
							class="btn btn-primary"
						>
							{flowState.saving ? 'Saving...' : 'Save'}
						</button>
					{/if}
				</div>
			</div>
			{#if flowState.config?.source === 'env'}
				<p class="env-lock-notice">
					Locked by environment variable. To change, update AUTHRIM_FLOW_STATE_SHARDS and redeploy.
				</p>
			{/if}
		</div>

		<!-- Code Shards -->
		<div class="shard-config-card">
			<div class="shard-config-content">
				<div class="shard-config-info">
					<div class="shard-config-header">
						<h3>Authorization Code Shards</h3>
						{#if codeShards.config}
							<span class={getSourceBadgeClass(codeShards.config.source)}>
								{getSourceBadgeText(codeShards.config.source)}
							</span>
						{/if}
					</div>
					<p class="shard-config-description">
						Controls authorization code distribution. Used during OAuth authorization flow.
						<span class="shard-config-range">(Default: 4, Range: 1-256)</span>
					</p>
					{#if codeShards.error}
						<p class="shard-config-error">{codeShards.error}</p>
					{/if}
				</div>
				<div class="shard-config-controls">
					{#if codeShards.loading}
						<span class="text-secondary">Loading...</span>
					{:else}
						<input
							type="number"
							min="1"
							max="256"
							bind:value={codeShards.editValue}
							disabled={codeShards.saving || codeShards.config?.source === 'env'}
							class="shard-input"
						/>
						<button
							onclick={saveCodeShards}
							disabled={codeShards.saving ||
								codeShards.editValue === codeShards.config?.current ||
								codeShards.config?.source === 'env'}
							class="btn btn-primary"
						>
							{codeShards.saving ? 'Saving...' : 'Save'}
						</button>
					{/if}
				</div>
			</div>
			{#if codeShards.config?.source === 'env'}
				<p class="env-lock-notice">
					Locked by environment variable. To change, update AUTHRIM_CODE_SHARDS and redeploy.
				</p>
			{/if}
		</div>

		<!-- Revocation Shards -->
		<div class="shard-config-card">
			<div class="shard-config-content">
				<div class="shard-config-info">
					<div class="shard-config-header">
						<h3>Token Revocation Shards</h3>
						{#if revocationShards.config}
							<span class={getSourceBadgeClass(revocationShards.config.source)}>
								{getSourceBadgeText(revocationShards.config.source)}
							</span>
						{/if}
					</div>
					<p class="shard-config-description">
						Controls token revocation tracking distribution. Used for logout and token invalidation.
						<span class="shard-config-range">(Default: 64, Range: 1-256)</span>
					</p>
					{#if revocationShards.error}
						<p class="shard-config-error">{revocationShards.error}</p>
					{/if}
				</div>
				<div class="shard-config-controls">
					{#if revocationShards.loading}
						<span class="text-secondary">Loading...</span>
					{:else}
						<input
							type="number"
							min="1"
							max="256"
							bind:value={revocationShards.editValue}
							disabled={revocationShards.saving || revocationShards.config?.source === 'env'}
							class="shard-input"
						/>
						<button
							onclick={saveRevocationShards}
							disabled={revocationShards.saving ||
								revocationShards.editValue === revocationShards.config?.current ||
								revocationShards.config?.source === 'env'}
							class="btn btn-primary"
						>
							{revocationShards.saving ? 'Saving...' : 'Save'}
						</button>
					{/if}
				</div>
			</div>
			{#if revocationShards.config?.source === 'env'}
				<p class="env-lock-notice">
					Locked by environment variable. To change, update AUTHRIM_REVOCATION_SHARDS and redeploy.
				</p>
			{/if}
		</div>
	</div>

	<!-- Info box -->
	<div class="info-box-blue">
		<h4>About Sharding</h4>
		<p>
			Sharding distributes state across multiple instances using consistent hashing. Higher shard
			counts improve parallelism but increase complexity. Changes only affect new sessions; existing
			sessions continue using their original shard routing until expiration.
		</p>
	</div>
</div>
