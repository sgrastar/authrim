<script lang="ts">
	import { onMount } from 'svelte';
	import { LL } from '$i18n/i18n-svelte';
	import { adminInfrastructureAPI, type ShardConfig } from '$lib/api/admin-infrastructure';
	import AdminPageHeader from '$lib/components/admin/AdminPageHeader.svelte';
	import AdminPageShell from '$lib/components/admin/AdminPageShell.svelte';

	// State for each shard type
	interface ShardState {
		config: ShardConfig | null;
		loading: boolean;
		saving: boolean;
		error: string;
		editValue: number | null;
	}

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
		await Promise.all([loadCodeShards(), loadRevocationShards()]);
	});

	async function loadCodeShards() {
		codeShards.loading = true;
		codeShards.error = '';
		try {
			codeShards.config = await adminInfrastructureAPI.getCodeShards();
			codeShards.editValue = codeShards.config.current;
		} catch (err) {
			codeShards.error =
				err instanceof Error ? err.message : $LL.admin_settings_shards_load_failed();
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
			revocationShards.error =
				err instanceof Error ? err.message : $LL.admin_settings_shards_load_failed();
		} finally {
			revocationShards.loading = false;
		}
	}

	async function saveCodeShards() {
		if (codeShards.editValue === null || codeShards.editValue === codeShards.config?.current)
			return;

		codeShards.saving = true;
		codeShards.error = '';
		try {
			await adminInfrastructureAPI.updateCodeShards(codeShards.editValue);
			successMessage = $LL.admin_settings_code_shards_updated();
			await loadCodeShards();
			setTimeout(() => {
				successMessage = '';
			}, 3000);
		} catch (err) {
			codeShards.error =
				err instanceof Error ? err.message : $LL.admin_settings_shards_save_failed();
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
			successMessage = $LL.admin_settings_revocation_shards_updated();
			await loadRevocationShards();
			setTimeout(() => {
				successMessage = '';
			}, 3000);
		} catch (err) {
			revocationShards.error =
				err instanceof Error ? err.message : $LL.admin_settings_shards_save_failed();
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

<svelte:head>
	<title>Sharding Configuration - Admin Dashboard - Authrim</title>
</svelte:head>

{#snippet headerActions()}
	<a href="/admin/settings" class="back-link">Back to Settings</a>
{/snippet}

<AdminPageShell>
	<div class="sharding-page">
		<AdminPageHeader
			title="Sharding Configuration"
			description="Configure shard counts for load distribution. Changes take effect for new sessions only."
			actions={headerActions}
		/>

		<!-- Success message -->
		{#if successMessage}
			<div class="alert alert-success">{successMessage}</div>
		{/if}

		<!-- Shard Configuration Cards -->
		<div class="shard-cards">
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
							Controls token revocation tracking distribution. Used for logout and token
							invalidation.
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
						Locked by environment variable. To change, update AUTHRIM_REVOCATION_SHARDS and
						redeploy.
					</p>
				{/if}
			</div>
		</div>

		<!-- Info box -->
		<div class="info-box-blue">
			<h4>About Sharding</h4>
			<p>
				Sharding distributes state across multiple instances using consistent hashing. Higher shard
				counts improve parallelism but increase complexity. Changes only affect new sessions;
				existing sessions continue using their original shard routing until expiration.
			</p>
		</div>
	</div>
</AdminPageShell>

<style>
	.sharding-page {
		max-width: 900px;
	}

	.back-link {
		display: inline-flex;
		align-items: center;
		min-height: var(--control-height, 36px);
		padding: var(--button-padding, 8px 14px);
		border: 1px solid var(--control-border, var(--color-border));
		border-radius: var(--control-radius, var(--radius-control));
		background: var(--color-surface-muted);
		color: var(--color-text-muted);
		text-decoration: none;
		font-size: 0.875rem;
		font-weight: 600;
	}

	.alert {
		margin-bottom: 20px;
		padding: 12px 16px;
		border-radius: var(--radius-control);
		font-size: 0.875rem;
	}

	.alert-success {
		border: 1px solid color-mix(in srgb, var(--color-success) 42%, var(--color-border));
		background: color-mix(in srgb, var(--color-success) 12%, var(--color-surface));
		color: var(--color-success);
	}

	.shard-cards {
		display: grid;
		gap: 16px;
	}

	.shard-config-card,
	.info-box-blue {
		border: 1px solid var(--color-border);
		border-radius: var(--radius-panel);
		background: var(--color-surface);
		color: var(--color-text);
		box-shadow: var(--card-shadow, none);
	}

	.shard-config-card {
		padding: 20px;
	}

	.shard-config-content {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 20px;
	}

	.shard-config-info {
		min-width: 0;
	}

	.shard-config-header {
		display: flex;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
		margin-bottom: 8px;
	}

	.shard-config-header h3,
	.info-box-blue h4 {
		margin: 0;
		color: var(--color-text);
		font-size: 1rem;
		line-height: 1.35;
	}

	.shard-config-description,
	.env-lock-notice,
	.info-box-blue p,
	.text-secondary {
		color: var(--color-text-muted);
		font-size: 0.875rem;
		line-height: 1.6;
	}

	.shard-config-description,
	.info-box-blue p {
		margin: 0;
	}

	.shard-config-range {
		color: var(--color-text-subtle);
	}

	.shard-config-error {
		margin: 8px 0 0;
		color: var(--color-danger);
		font-size: 0.875rem;
	}

	.shard-config-controls {
		display: flex;
		align-items: center;
		gap: 10px;
		flex-shrink: 0;
	}

	.shard-input {
		width: 96px;
		min-height: var(--control-height, 38px);
		padding: var(--control-padding, 8px 10px);
		border: 1px solid var(--control-border, var(--color-border));
		border-radius: var(--control-radius, var(--radius-control));
		background: var(--control-bg, var(--color-surface));
		color: var(--color-text);
		font: inherit;
	}

	.btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-height: var(--control-height, 38px);
		padding: var(--button-padding, 8px 16px);
		border: 1px solid transparent;
		border-radius: var(--control-radius, var(--radius-control));
		font-weight: 600;
		cursor: pointer;
	}

	.btn:disabled,
	.shard-input:disabled {
		cursor: not-allowed;
		opacity: 0.55;
	}

	.btn-primary {
		background: var(--button-primary-bg, var(--color-accent));
		color: var(--button-primary-color, var(--color-accent-contrast));
	}

	.source-badge {
		display: inline-flex;
		align-items: center;
		padding: 3px 8px;
		border-radius: var(--radius-full);
		font-size: 0.75rem;
		font-weight: 700;
	}

	.source-badge.env {
		background: color-mix(in srgb, var(--color-warning) 14%, transparent);
		color: var(--color-warning);
	}

	.source-badge.kv {
		background: color-mix(in srgb, var(--color-success) 14%, transparent);
		color: var(--color-success);
	}

	.source-badge.default {
		background: var(--color-surface-muted);
		color: var(--color-text-muted);
	}

	.env-lock-notice {
		margin: 14px 0 0;
		padding-top: 14px;
		border-top: 1px solid var(--color-border);
	}

	.info-box-blue {
		margin-top: 18px;
		padding: 20px;
		background: var(--color-accent-muted);
		border-color: color-mix(in srgb, var(--color-accent) 28%, var(--color-border));
	}

	.info-box-blue h4 {
		margin-bottom: 8px;
	}

	@media (max-width: 720px) {
		.shard-config-content,
		.shard-config-controls {
			align-items: stretch;
			flex-direction: column;
		}

		.shard-input,
		.btn {
			width: 100%;
		}
	}
</style>
