<script lang="ts">
	import { goto } from '$app/navigation';
	import { adminTenantsAPI } from '$lib/api/admin-tenants';
	import { AdminPageHeader, AdminPageShell } from '$lib/components/admin';
	import { tenantStore } from '$lib/stores/tenants.svelte';
	import { LL } from '$i18n/i18n-svelte';

	// ==========================================================================
	// State
	// ==========================================================================

	let newId = $state('');
	let newTenantCode = $state('');
	let newName = $state('');
	let newDescription = $state('');
	let isolationPolicy = $state<'shared_pool' | 'tenant_exclusive'>('tenant_exclusive');
	let creating = $state(false);
	let createError = $state('');
	let idValidationError = $state('');
	let tenantCodeValidationError = $state('');

	// ==========================================================================
	// Validation
	// ==========================================================================

	const TENANT_ID_REGEX = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

	function validateTenantId(value: string): string {
		if (!value) return $LL.admin_tenants_validation_id_required();
		if (value.length > 63) return $LL.admin_tenants_validation_id_too_long();
		if (!TENANT_ID_REGEX.test(value)) return $LL.admin_tenants_validation_id_format();
		return '';
	}

	function validateTenantCode(value: string): string {
		if (!value) return $LL.admin_tenants_validation_code_required();
		if (value.length > 63) return $LL.admin_tenants_validation_code_too_long();
		if (!TENANT_ID_REGEX.test(value)) return $LL.admin_tenants_validation_code_format();
		return '';
	}

	function handleIdInput() {
		idValidationError = validateTenantId(newId);
	}

	function handleTenantCodeInput() {
		tenantCodeValidationError = newTenantCode ? validateTenantCode(newTenantCode) : '';
	}

	// ==========================================================================
	// Create
	// ==========================================================================

	async function handleCreate() {
		idValidationError = validateTenantId(newId);
		tenantCodeValidationError = newTenantCode ? validateTenantCode(newTenantCode) : '';
		if (idValidationError || tenantCodeValidationError) return;
		if (!newName.trim()) {
			createError = $LL.admin_tenants_name_required();
			return;
		}

		creating = true;
		createError = '';

		try {
			const created = await adminTenantsAPI.create({
				id: newId,
				tenant_code: newTenantCode.trim() || undefined,
				name: newName.trim(),
				description: newDescription.trim() || undefined,
				isolation_policy: isolationPolicy
			});
			tenantStore.add(created);
			await goto(`/admin/tenants/${encodeURIComponent(created.id)}`);
		} catch (err) {
			createError = err instanceof Error ? err.message : $LL.admin_tenants_create_failed();
		} finally {
			creating = false;
		}
	}
</script>

<svelte:head>
	<title>{$LL.admin_tenants_new_head_title()}</title>
</svelte:head>

<AdminPageShell width="narrow">
	<a href="/admin/tenants" class="back-link">
		<i class="i-ph-arrow-left"></i>
		{$LL.admin_tenants_back_to_tenants()}
	</a>

	<AdminPageHeader
		title={$LL.admin_tenants_new_title()}
		description={$LL.admin_tenants_new_description()}
	/>

	<section class="tenant-create-panel">
		{#if createError}
			<div class="alert alert-error">
				<i class="i-ph-warning-circle"></i>
				{createError}
			</div>
		{/if}

		<div class="form-grid">
			<div class="admin-field">
				<label for="new-id" class="admin-field__label"
					>{$LL.admin_tenants_tenant_id()} <span class="required">*</span></label
				>
				<input
					id="new-id"
					type="text"
					class="admin-input"
					class:error={!!idValidationError}
					bind:value={newId}
					oninput={handleIdInput}
					placeholder={$LL.admin_tenants_id_placeholder()}
					maxlength="63"
					autocomplete="off"
				/>
				{#if idValidationError}
					<p class="field-error">{idValidationError}</p>
				{:else}
					<p class="field-hint">
						{$LL.admin_tenants_id_hint()}
					</p>
				{/if}
			</div>

			<div class="admin-field">
				<label for="new-tenant-code" class="admin-field__label"
					>{$LL.admin_tenants_tenant_code()}</label
				>
				<input
					id="new-tenant-code"
					type="text"
					class="admin-input"
					class:error={!!tenantCodeValidationError}
					bind:value={newTenantCode}
					oninput={handleTenantCodeInput}
					placeholder={$LL.admin_tenants_code_placeholder()}
					maxlength="63"
					autocomplete="off"
				/>
				{#if tenantCodeValidationError}
					<p class="field-error">{tenantCodeValidationError}</p>
				{:else}
					<p class="field-hint">
						{$LL.admin_tenants_code_hint()}
					</p>
				{/if}
			</div>

			<div class="admin-field admin-field--full">
				<label for="new-name" class="admin-field__label"
					>{$LL.admin_tenants_name()} <span class="required">*</span></label
				>
				<input
					id="new-name"
					type="text"
					class="admin-input"
					bind:value={newName}
					placeholder={$LL.admin_tenants_name_placeholder()}
					maxlength="200"
				/>
			</div>

			<div class="admin-field admin-field--full">
				<label for="new-description" class="admin-field__label"
					>{$LL.admin_tenants_description_label()}</label
				>
				<textarea
					id="new-description"
					class="admin-input"
					bind:value={newDescription}
					placeholder={$LL.admin_tenants_description_placeholder()}
					rows="3"
					maxlength="500"
				></textarea>
			</div>

			<fieldset class="admin-field admin-field--full placement-field">
				<legend class="admin-field__label">{$LL.admin_tenants_placement_label()}</legend>
				<div class="placement-options">
					<label class:active={isolationPolicy === 'shared_pool'}>
						<input type="radio" bind:group={isolationPolicy} value="shared_pool" />
						<i class="i-ph-stack"></i>
						<span>
							<strong>{$LL.admin_tenants_placement_shared()}</strong>
							<small>{$LL.admin_tenants_placement_shared_hint()}</small>
						</span>
					</label>
					<label class:active={isolationPolicy === 'tenant_exclusive'}>
						<input type="radio" bind:group={isolationPolicy} value="tenant_exclusive" />
						<i class="i-ph-database"></i>
						<span>
							<strong>{$LL.admin_tenants_placement_exclusive()}</strong>
							<small>{$LL.admin_tenants_placement_exclusive_hint()}</small>
						</span>
					</label>
				</div>
			</fieldset>
		</div>

		<div class="form-actions">
			<a href="/admin/tenants" class="btn btn-secondary">{$LL.admin_tenants_cancel()}</a>
			<button
				class="btn btn-primary"
				onclick={handleCreate}
				disabled={creating || !!idValidationError || !!tenantCodeValidationError}
			>
				{#if creating}
					<i class="i-ph-circle-notch animate-spin"></i>
					{$LL.admin_tenants_creating()}
				{:else}
					<i class="i-ph-plus"></i>
					{$LL.admin_tenants_create_button()}
				{/if}
			</button>
		</div>
	</section>
</AdminPageShell>

<style>
	.back-link {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		width: fit-content;
		margin-bottom: 1rem;
		font-size: 0.85rem;
		font-weight: 700;
		color: var(--color-text-muted);
		text-decoration: none;
	}

	.back-link:hover,
	.back-link:focus-visible {
		color: var(--color-accent);
	}

	.back-link :global(i) {
		width: 1rem;
		height: 1rem;
	}

	.tenant-create-panel {
		padding: 1.2rem;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-panel, var(--radius-md));
		background: var(--color-surface);
		box-shadow: var(--shadow-sm);
	}

	.form-grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 1rem;
	}

	.required {
		color: var(--color-danger);
	}

	.admin-input.error {
		border-color: var(--color-danger);
	}

	.field-hint {
		font-size: 0.75rem;
		color: var(--color-text-muted);
		margin: 0;
	}

	.field-error {
		font-size: 0.75rem;
		color: var(--color-danger);
		margin: 0;
	}

	.placement-field {
		margin: 0;
		padding: 0;
		border: 0;
	}

	.placement-options {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 0.75rem;
	}

	.placement-options label {
		display: grid;
		grid-template-columns: auto auto minmax(0, 1fr);
		align-items: start;
		gap: 0.65rem;
		min-height: 5.25rem;
		padding: 0.85rem;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-sm);
		background: var(--color-surface);
		cursor: pointer;
	}

	.placement-options label.active {
		border-color: var(--color-accent);
		box-shadow: 0 0 0 1px var(--color-accent);
	}

	.placement-options label > :global(i) {
		width: 1.15rem;
		height: 1.15rem;
		color: var(--color-text-muted);
	}

	.placement-options span {
		display: grid;
		gap: 0.25rem;
		min-width: 0;
	}

	.placement-options strong,
	.placement-options small {
		font-size: 0.82rem;
		line-height: 1.35;
	}

	.placement-options small {
		color: var(--color-text-muted);
	}

	.form-actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
		margin-top: 1.25rem;
		padding-top: 1rem;
		border-top: 1px solid var(--color-border);
		flex-wrap: wrap;
	}

	.alert {
		display: flex;
		align-items: flex-start;
		gap: 0.65rem;
		padding: 0.85rem 1rem;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-panel, var(--radius-md));
		background: var(--color-surface);
		color: var(--color-text);
		font-size: 0.875rem;
		margin-bottom: 1rem;
	}

	.alert :global(i) {
		width: 18px;
		height: 18px;
		flex-shrink: 0;
		margin-top: 1px;
	}

	.alert-error {
		border-color: color-mix(in srgb, var(--color-danger) 30%, var(--color-border));
		background: color-mix(in srgb, var(--color-danger) 9%, var(--color-surface));
		color: var(--color-danger);
	}

	@media (max-width: 640px) {
		.form-grid {
			grid-template-columns: 1fr;
		}

		.placement-options {
			grid-template-columns: 1fr;
		}

		.form-actions {
			justify-content: stretch;
		}

		.form-actions :global(.btn) {
			justify-content: center;
			flex: 0 1 auto;
			width: 100%;
		}
	}
</style>
