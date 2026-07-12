<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { adminTenantsAPI } from '$lib/api/admin-tenants';
	import { getTenantD1CreateUiState } from '$lib/admin/tenant-d1-ui-state';
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
			createError = err instanceof Error ? err.message : $LL.admin_tenants_create_failed();
		} finally {
			if (stepTimer !== undefined) {
				window.clearInterval(stepTimer);
			}
			creating = false;
			creatingStep = '';
		}
	}

	function provisioningStepLabel(step: string): string {
		switch (step) {
			case 'reserve':
				return $LL.admin_tenants_step_reserve();
			case 'seed':
				return $LL.admin_tenants_step_seed();
			case 'registry':
				return $LL.admin_tenants_step_registry();
			case 'snapshot':
				return $LL.admin_tenants_step_snapshot();
			case 'smoke':
				return $LL.admin_tenants_step_smoke();
			case 'activate':
				return $LL.admin_tenants_step_activate();
			default:
				return step;
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
		{#if tenantD1CreateState.showPool}
			<div class="alert alert-info">
				<i class="i-ph-database"></i>
				<div>
					<strong>{$LL.admin_tenants_d1_slots()}</strong>
					<p>
						{$LL.admin_tenants_d1_slots_available({
							available: tenantD1Pool?.available_slots ?? 0,
							capacity: tenantD1Pool?.capacity ?? 0
						})}
					</p>
				</div>
			</div>
		{/if}

		{#if tenantD1CreateState.exhausted}
			<div class="alert alert-error">
				<i class="i-ph-warning-circle"></i>
				<div>
					<strong>{$LL.admin_tenants_d1_exhausted_title()}</strong>
					<p>{$LL.admin_tenants_d1_exhausted_message()}</p>
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
						<span>{provisioningStepLabel(step)}</span>
					</div>
				{/each}
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
		</div>

		<div class="form-actions">
			<a href="/admin/tenants" class="btn btn-secondary">{$LL.admin_tenants_cancel()}</a>
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

	.alert-info {
		border-color: color-mix(in srgb, var(--color-accent) 26%, var(--color-border));
		background: color-mix(in srgb, var(--color-accent) 8%, var(--color-surface));
		color: var(--color-text);
	}

	.alert-info :global(i) {
		color: var(--color-accent);
	}

	.alert p {
		margin: 0.2rem 0 0;
		color: var(--color-text-muted);
		line-height: 1.6;
	}

	.provisioning-steps {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 0.5rem;
		margin-bottom: 1rem;
	}

	.provisioning-steps > div {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		min-width: 0;
		padding: 0.55rem;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-control, var(--radius-md));
		background: var(--color-surface-muted);
		color: var(--color-text-muted);
		font-size: 0.75rem;
	}

	.provisioning-steps > div.active,
	.provisioning-steps > div.done {
		color: var(--color-text);
		border-color: var(--color-accent);
		background: color-mix(in srgb, var(--color-accent) 8%, var(--color-surface));
	}

	.provisioning-steps :global(i) {
		width: 14px;
		height: 14px;
		flex-shrink: 0;
	}

	@media (max-width: 640px) {
		.form-grid {
			grid-template-columns: 1fr;
		}

		.provisioning-steps {
			grid-template-columns: 1fr 1fr;
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
