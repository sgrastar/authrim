<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { adminTenantsAPI } from '$lib/api/admin-tenants';
	import { getTenantD1CreateUiState } from '$lib/admin/tenant-d1-ui-state';
	import { tenantStore } from '$lib/stores/tenants.svelte';

	// ==========================================================================
	// State
	// ==========================================================================

	let newId = $state('');
	let newTenantCode = $state('');
	let newName = $state('');
	let newDescription = $state('');
	let creating = $state(false);
	let createError = $state('');
	let idValidationError = $state('');
	let tenantCodeValidationError = $state('');
	let creatingStep = $state('');

	const provisioningSteps = ['reserve', 'seed', 'registry', 'snapshot', 'smoke', 'activate'];
	let tenantD1Pool = $derived(tenantStore.tenantD1Pool);
	let tenantD1CreateState = $derived(getTenantD1CreateUiState(tenantD1Pool));

	onMount(async () => {
		await tenantStore.reload();
	});

	// ==========================================================================
	// Validation
	// ==========================================================================

	const TENANT_ID_REGEX = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

	function validateTenantId(value: string): string {
		if (!value) return 'ID is required';
		if (value.length > 63) return 'ID must be 63 characters or fewer';
		if (!TENANT_ID_REGEX.test(value))
			return 'Must start and end with a lowercase letter or digit (hyphens allowed in between)';
		return '';
	}

	function handleIdInput() {
		idValidationError = validateTenantId(newId);
	}

	function handleTenantCodeInput() {
		tenantCodeValidationError = newTenantCode ? validateTenantId(newTenantCode) : '';
	}

	// ==========================================================================
	// Create
	// ==========================================================================

	async function handleCreate() {
		idValidationError = validateTenantId(newId);
		tenantCodeValidationError = newTenantCode ? validateTenantId(newTenantCode) : '';
		if (idValidationError || tenantCodeValidationError) return;
		if (!newName.trim()) {
			createError = 'Name is required';
			return;
		}

		creating = true;
		createError = '';
		creatingStep = 'reserve';
		let stepTimer: number | undefined;

		try {
			stepTimer = window.setInterval(() => {
				const currentIndex = Math.max(0, provisioningSteps.indexOf(creatingStep));
				creatingStep = provisioningSteps[Math.min(currentIndex + 1, provisioningSteps.length - 1)];
			}, 1800);
			const created = await adminTenantsAPI.create({
				id: newId,
				tenant_code: newTenantCode.trim() || undefined,
				name: newName.trim(),
				description: newDescription.trim() || undefined
			});
			window.clearInterval(stepTimer);
			creatingStep = 'activate';
			tenantStore.add(created);
			goto(`/admin/tenants/${encodeURIComponent(created.id)}`);
		} catch (err) {
			createError = err instanceof Error ? err.message : 'Failed to create tenant';
		} finally {
			if (stepTimer !== undefined) {
				window.clearInterval(stepTimer);
			}
			creating = false;
			creatingStep = '';
		}
	}
</script>

<svelte:head>
	<title>New Tenant — Admin Dashboard</title>
</svelte:head>

<div class="page">
	<div class="page-nav">
		<a href="/admin/tenants" class="back-link">
			<i class="i-ph-arrow-left"></i>
			Back to Tenants
		</a>
	</div>

	<div class="page-header">
		<h1 class="page-title">New Tenant</h1>
		<p class="page-description">Create a new tenant for this Authrim instance.</p>
	</div>

	<div class="card">
		{#if tenantD1CreateState.showPool}
			<div class="alert alert-info">
				<i class="i-ph-database"></i>
				<div>
					<strong>Tenant D1 slots</strong>
					<p>{tenantD1CreateState.summary}</p>
				</div>
			</div>
		{/if}

		{#if tenantD1CreateState.exhausted}
			<div class="alert alert-error">
				<i class="i-ph-warning-circle"></i>
				<div>
					<strong>{tenantD1CreateState.exhaustedTitle}</strong>
					<p>{tenantD1CreateState.exhaustedMessage}</p>
				</div>
			</div>
		{/if}

		{#if createError}
			<div class="alert alert-error">
				<i class="i-ph-warning-circle"></i>
				{createError}
			</div>
		{/if}

		{#if creating}
			<div class="provisioning-steps">
				{#each provisioningSteps as step (step)}
					<div
						class:active={step === creatingStep}
						class:done={provisioningSteps.indexOf(step) < provisioningSteps.indexOf(creatingStep)}
					>
						<i
							class={step === creatingStep ? 'i-ph-circle-notch animate-spin' : 'i-ph-check-circle'}
						></i>
						<span>{step}</span>
					</div>
				{/each}
			</div>
		{/if}

		<div class="form-grid">
			<div class="form-group">
				<label for="new-id" class="form-label">Tenant ID <span class="required">*</span></label>
				<input
					id="new-id"
					type="text"
					class="form-input"
					class:error={!!idValidationError}
					bind:value={newId}
					oninput={handleIdInput}
					placeholder="e.g. acme-corp"
					maxlength="63"
					autocomplete="off"
				/>
				{#if idValidationError}
					<p class="field-error">{idValidationError}</p>
				{:else}
					<p class="field-hint">
						Lowercase letters, numbers, hyphens. Max 63 characters. Cannot be changed later.
					</p>
				{/if}
			</div>

			<div class="form-group">
				<label for="new-tenant-code" class="form-label">Tenant Code</label>
				<input
					id="new-tenant-code"
					type="text"
					class="form-input"
					class:error={!!tenantCodeValidationError}
					bind:value={newTenantCode}
					oninput={handleTenantCodeInput}
					placeholder="Defaults to Tenant ID when omitted"
					maxlength="63"
					autocomplete="off"
				/>
				{#if tenantCodeValidationError}
					<p class="field-error">{tenantCodeValidationError.replace(/^ID /, 'Tenant code ')}</p>
				{:else}
					<p class="field-hint">
						Optional. Used by discovery (e.g. manual entry). Lowercase letters, numbers, hyphens.
					</p>
				{/if}
			</div>

			<div class="form-group form-group-full">
				<label for="new-name" class="form-label">Name <span class="required">*</span></label>
				<input
					id="new-name"
					type="text"
					class="form-input"
					bind:value={newName}
					placeholder="e.g. Acme Corporation"
					maxlength="200"
				/>
			</div>

			<div class="form-group form-group-full">
				<label for="new-description" class="form-label">Description</label>
				<textarea
					id="new-description"
					class="form-input"
					bind:value={newDescription}
					placeholder="Optional description"
					rows="3"
					maxlength="500"
				></textarea>
			</div>
		</div>

		<div class="form-actions">
			<a href="/admin/tenants" class="btn btn-secondary">Cancel</a>
			<button
				class="btn btn-primary"
				onclick={handleCreate}
				disabled={creating ||
					tenantD1CreateState.exhausted ||
					!!idValidationError ||
					!!tenantCodeValidationError}
			>
				{#if creating}
					<i class="i-ph-circle-notch animate-spin"></i>
					Creating...
				{:else}
					<i class="i-ph-plus"></i>
					Create Tenant
				{/if}
			</button>
		</div>
	</div>
</div>

<style>
	.page {
		display: flex;
		flex-direction: column;
		gap: 20px;
		max-width: 600px;
	}

	.page-nav {
		margin-bottom: 4px;
	}

	.back-link {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: 0.875rem;
		color: var(--text-secondary);
		text-decoration: none;
		transition: color var(--transition-fast);
	}

	.back-link:hover {
		color: var(--primary);
	}

	.back-link :global(i) {
		width: 16px;
		height: 16px;
	}

	.page-header {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.page-title {
		font-size: 1.5rem;
		font-weight: 700;
		color: var(--text-primary);
		margin: 0;
	}

	.page-description {
		font-size: 0.875rem;
		color: var(--text-secondary);
		margin: 0;
	}

	.card {
		background: var(--bg-card);
		border: 1px solid var(--border);
		border-radius: var(--radius-lg);
		padding: 24px;
	}

	.form-grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 16px;
	}

	.form-group-full {
		grid-column: 1 / -1;
	}

	.form-group {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.form-label {
		font-size: 0.875rem;
		font-weight: 500;
		color: var(--text-primary);
	}

	.required {
		color: var(--danger);
	}

	.form-input {
		padding: 8px 12px;
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		background: var(--bg-card);
		color: var(--text-primary);
		font-size: 0.875rem;
		font-family: var(--font-body);
		outline: none;
		width: 100%;
		box-sizing: border-box;
		transition: border-color var(--transition-fast);
	}

	.form-input:focus {
		border-color: var(--primary);
		box-shadow: 0 0 0 3px var(--primary-light);
	}

	.form-input.error {
		border-color: var(--danger);
	}

	.field-hint {
		font-size: 0.75rem;
		color: var(--text-muted);
		margin: 0;
	}

	.field-error {
		font-size: 0.75rem;
		color: var(--danger);
		margin: 0;
	}

	.form-actions {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
		margin-top: 20px;
		padding-top: 16px;
		border-top: 1px solid var(--border);
	}

	.alert {
		display: flex;
		align-items: flex-start;
		gap: 10px;
		padding: 12px 16px;
		border-radius: var(--radius-md);
		font-size: 0.875rem;
		margin-bottom: 16px;
	}

	.alert :global(i) {
		width: 18px;
		height: 18px;
		flex-shrink: 0;
		margin-top: 1px;
	}

	.alert-error {
		background: var(--danger-subtle);
		color: var(--danger);
		border: 1px solid var(--danger-border);
	}

	.alert-info {
		background: var(--info-subtle, var(--bg-subtle));
		color: var(--text-primary);
		border: 1px solid var(--border);
	}

	.alert p {
		margin: 2px 0 0;
		color: var(--text-secondary);
	}

	.provisioning-steps {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 8px;
		margin-bottom: 16px;
	}

	.provisioning-steps > div {
		display: flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
		padding: 8px;
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		color: var(--text-muted);
		font-size: 0.75rem;
	}

	.provisioning-steps > div.active,
	.provisioning-steps > div.done {
		color: var(--text-primary);
		border-color: var(--primary);
	}

	.provisioning-steps :global(i) {
		width: 14px;
		height: 14px;
		flex-shrink: 0;
	}

	.btn {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 8px 16px;
		border-radius: var(--radius-md);
		font-size: 0.875rem;
		font-weight: 500;
		cursor: pointer;
		transition: all var(--transition-fast);
		border: none;
		text-decoration: none;
		font-family: var(--font-body);
	}

	.btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.btn :global(i) {
		width: 16px;
		height: 16px;
	}

	.btn-primary {
		background: var(--primary);
		color: white;
	}

	.btn-primary:hover:not(:disabled) {
		background: var(--primary-dark);
	}

	.btn-secondary {
		background: var(--bg-subtle);
		color: var(--text-primary);
		border: 1px solid var(--border);
	}

	.btn-secondary:hover:not(:disabled) {
		background: var(--bg-card);
	}

	@media (max-width: 640px) {
		.form-grid {
			grid-template-columns: 1fr;
		}

		.provisioning-steps {
			grid-template-columns: 1fr 1fr;
		}
	}
</style>
