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

	// Get source badge style
	function getSourceBadge(source: string): { text: string; bg: string; color: string } {
		switch (source) {
			case 'env':
				return { text: 'Environment', bg: '#fef3c7', color: '#92400e' };
			case 'kv':
				return { text: 'KV Store', bg: '#dbeafe', color: '#1e40af' };
			default:
				return { text: 'Default', bg: '#f3f4f6', color: '#6b7280' };
		}
	}
</script>

<div>
	<!-- Header -->
	<div style="margin-bottom: 24px;">
		<a
			href="/admin/settings"
			style="color: #3b82f6; text-decoration: none; font-size: 14px; display: inline-flex; align-items: center; gap: 4px;"
		>
			&larr; Back to Settings
		</a>
		<h1 style="font-size: 24px; font-weight: bold; color: #111827; margin: 8px 0 4px 0;">
			Sharding Configuration
		</h1>
		<p style="color: #6b7280; margin: 0;">
			Configure shard counts for load distribution. Changes take effect for new sessions only.
		</p>
	</div>

	<!-- Success message -->
	{#if successMessage}
		<div
			style="background-color: #d1fae5; border: 1px solid #10b981; color: #065f46; padding: 12px; border-radius: 6px; margin-bottom: 16px;"
		>
			{successMessage}
		</div>
	{/if}

	<!-- Shard Configuration Cards -->
	<div style="display: flex; flex-direction: column; gap: 16px;">
		<!-- Flow State Shards -->
		<div
			style="background-color: white; border: 1px solid #e5e7eb; border-radius: 8px; padding: 20px;"
		>
			<div
				style="display: flex; justify-content: space-between; align-items: flex-start; gap: 16px;"
			>
				<div style="flex: 1;">
					<div style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px;">
						<h3 style="font-weight: 600; color: #111827; margin: 0; font-size: 16px;">
							Flow State Shards
						</h3>
						{#if flowState.config}
							{@const badge = getSourceBadge(flowState.config.source)}
							<span
								style="font-size: 11px; padding: 2px 6px; border-radius: 4px; background-color: {badge.bg}; color: {badge.color};"
							>
								{badge.text}
							</span>
						{/if}
					</div>
					<p style="font-size: 13px; color: #6b7280; margin: 0 0 8px 0;">
						Controls Flow Engine session distribution. Used for login/consent flows.
						<span style="color: #9ca3af;">(Default: 32, Range: 1-256)</span>
					</p>
					{#if flowState.error}
						<p style="font-size: 13px; color: #dc2626; margin: 0;">{flowState.error}</p>
					{/if}
				</div>
				<div style="display: flex; align-items: center; gap: 8px;">
					{#if flowState.loading}
						<span style="color: #6b7280;">Loading...</span>
					{:else}
						<input
							type="number"
							min="1"
							max="256"
							bind:value={flowState.editValue}
							disabled={flowState.saving || flowState.config?.source === 'env'}
							style="
								width: 80px;
								padding: 8px 12px;
								border: 1px solid #d1d5db;
								border-radius: 6px;
								font-size: 14px;
								text-align: center;
								background-color: {flowState.config?.source === 'env' ? '#f3f4f6' : 'white'};
							"
						/>
						<button
							onclick={saveFlowStateShards}
							disabled={flowState.saving ||
								flowState.editValue === flowState.config?.current ||
								flowState.config?.source === 'env'}
							style="
								padding: 8px 16px;
								background-color: {flowState.editValue !== flowState.config?.current &&
							flowState.config?.source !== 'env'
								? '#3b82f6'
								: '#9ca3af'};
								color: white;
								border: none;
								border-radius: 6px;
								font-size: 14px;
								cursor: {flowState.editValue !== flowState.config?.current && flowState.config?.source !== 'env'
								? 'pointer'
								: 'not-allowed'};
							"
						>
							{flowState.saving ? 'Saving...' : 'Save'}
						</button>
					{/if}
				</div>
			</div>
			{#if flowState.config?.source === 'env'}
				<p style="font-size: 12px; color: #92400e; margin-top: 8px;">
					Locked by environment variable. To change, update AUTHRIM_FLOW_STATE_SHARDS and redeploy.
				</p>
			{/if}
		</div>

		<!-- Code Shards -->
		<div
			style="background-color: white; border: 1px solid #e5e7eb; border-radius: 8px; padding: 20px;"
		>
			<div
				style="display: flex; justify-content: space-between; align-items: flex-start; gap: 16px;"
			>
				<div style="flex: 1;">
					<div style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px;">
						<h3 style="font-weight: 600; color: #111827; margin: 0; font-size: 16px;">
							Authorization Code Shards
						</h3>
						{#if codeShards.config}
							{@const badge = getSourceBadge(codeShards.config.source)}
							<span
								style="font-size: 11px; padding: 2px 6px; border-radius: 4px; background-color: {badge.bg}; color: {badge.color};"
							>
								{badge.text}
							</span>
						{/if}
					</div>
					<p style="font-size: 13px; color: #6b7280; margin: 0 0 8px 0;">
						Controls authorization code distribution. Used during OAuth authorization flow.
						<span style="color: #9ca3af;">(Default: 4, Range: 1-256)</span>
					</p>
					{#if codeShards.error}
						<p style="font-size: 13px; color: #dc2626; margin: 0;">{codeShards.error}</p>
					{/if}
				</div>
				<div style="display: flex; align-items: center; gap: 8px;">
					{#if codeShards.loading}
						<span style="color: #6b7280;">Loading...</span>
					{:else}
						<input
							type="number"
							min="1"
							max="256"
							bind:value={codeShards.editValue}
							disabled={codeShards.saving || codeShards.config?.source === 'env'}
							style="
								width: 80px;
								padding: 8px 12px;
								border: 1px solid #d1d5db;
								border-radius: 6px;
								font-size: 14px;
								text-align: center;
								background-color: {codeShards.config?.source === 'env' ? '#f3f4f6' : 'white'};
							"
						/>
						<button
							onclick={saveCodeShards}
							disabled={codeShards.saving ||
								codeShards.editValue === codeShards.config?.current ||
								codeShards.config?.source === 'env'}
							style="
								padding: 8px 16px;
								background-color: {codeShards.editValue !== codeShards.config?.current &&
							codeShards.config?.source !== 'env'
								? '#3b82f6'
								: '#9ca3af'};
								color: white;
								border: none;
								border-radius: 6px;
								font-size: 14px;
								cursor: {codeShards.editValue !== codeShards.config?.current && codeShards.config?.source !== 'env'
								? 'pointer'
								: 'not-allowed'};
							"
						>
							{codeShards.saving ? 'Saving...' : 'Save'}
						</button>
					{/if}
				</div>
			</div>
			{#if codeShards.config?.source === 'env'}
				<p style="font-size: 12px; color: #92400e; margin-top: 8px;">
					Locked by environment variable. To change, update AUTHRIM_CODE_SHARDS and redeploy.
				</p>
			{/if}
		</div>

		<!-- Revocation Shards -->
		<div
			style="background-color: white; border: 1px solid #e5e7eb; border-radius: 8px; padding: 20px;"
		>
			<div
				style="display: flex; justify-content: space-between; align-items: flex-start; gap: 16px;"
			>
				<div style="flex: 1;">
					<div style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px;">
						<h3 style="font-weight: 600; color: #111827; margin: 0; font-size: 16px;">
							Token Revocation Shards
						</h3>
						{#if revocationShards.config}
							{@const badge = getSourceBadge(revocationShards.config.source)}
							<span
								style="font-size: 11px; padding: 2px 6px; border-radius: 4px; background-color: {badge.bg}; color: {badge.color};"
							>
								{badge.text}
							</span>
						{/if}
					</div>
					<p style="font-size: 13px; color: #6b7280; margin: 0 0 8px 0;">
						Controls token revocation tracking distribution. Used for logout and token invalidation.
						<span style="color: #9ca3af;">(Default: 64, Range: 1-256)</span>
					</p>
					{#if revocationShards.error}
						<p style="font-size: 13px; color: #dc2626; margin: 0;">{revocationShards.error}</p>
					{/if}
				</div>
				<div style="display: flex; align-items: center; gap: 8px;">
					{#if revocationShards.loading}
						<span style="color: #6b7280;">Loading...</span>
					{:else}
						<input
							type="number"
							min="1"
							max="256"
							bind:value={revocationShards.editValue}
							disabled={revocationShards.saving || revocationShards.config?.source === 'env'}
							style="
								width: 80px;
								padding: 8px 12px;
								border: 1px solid #d1d5db;
								border-radius: 6px;
								font-size: 14px;
								text-align: center;
								background-color: {revocationShards.config?.source === 'env' ? '#f3f4f6' : 'white'};
							"
						/>
						<button
							onclick={saveRevocationShards}
							disabled={revocationShards.saving ||
								revocationShards.editValue === revocationShards.config?.current ||
								revocationShards.config?.source === 'env'}
							style="
								padding: 8px 16px;
								background-color: {revocationShards.editValue !== revocationShards.config?.current &&
							revocationShards.config?.source !== 'env'
								? '#3b82f6'
								: '#9ca3af'};
								color: white;
								border: none;
								border-radius: 6px;
								font-size: 14px;
								cursor: {revocationShards.editValue !== revocationShards.config?.current &&
							revocationShards.config?.source !== 'env'
								? 'pointer'
								: 'not-allowed'};
							"
						>
							{revocationShards.saving ? 'Saving...' : 'Save'}
						</button>
					{/if}
				</div>
			</div>
			{#if revocationShards.config?.source === 'env'}
				<p style="font-size: 12px; color: #92400e; margin-top: 8px;">
					Locked by environment variable. To change, update AUTHRIM_REVOCATION_SHARDS and redeploy.
				</p>
			{/if}
		</div>
	</div>

	<!-- Info box -->
	<div
		style="margin-top: 24px; padding: 16px; background-color: #f0f9ff; border: 1px solid #0ea5e9; border-radius: 8px;"
	>
		<h4 style="margin: 0 0 8px 0; color: #0c4a6e; font-size: 14px; font-weight: 600;">
			About Sharding
		</h4>
		<p style="margin: 0; font-size: 13px; color: #0369a1; line-height: 1.5;">
			Sharding distributes state across multiple instances using consistent hashing. Higher shard
			counts improve parallelism but increase complexity. Changes only affect new sessions; existing
			sessions continue using their original shard routing until expiration.
		</p>
	</div>
</div>
