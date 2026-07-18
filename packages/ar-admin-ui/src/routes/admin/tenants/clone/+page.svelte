<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import {
		adminTenantsAPI,
		type CloneTenantResponse,
		type TenantCloneOptions
	} from '$lib/api/admin-tenants';
	import { AdminPageHeader, AdminPageShell } from '$lib/components/admin';
	import { tenantStore } from '$lib/stores/tenants.svelte';
	import { LL } from '$i18n/i18n-svelte';

	const TENANT_ID_REGEX = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

	let sourceTenantId = $state('');
	let newId = $state('');
	let newTenantCode = $state('');
	let newName = $state('');
	let newDescription = $state('');
	let loading = $state(true);
	let cloning = $state(false);
	let error = $state('');
	let idError = $state('');
	let codeError = $state('');
	let result = $state<CloneTenantResponse | null>(null);
	let cloneAttemptFingerprint = '';
	let cloneAttemptIdempotencyKey = '';
	let options = $state<TenantCloneOptions>({
		settings: true,
		secret_settings: false,
		clients: false,
		client_credentials: false,
		roles: true,
		admin_access: false,
		webhooks: false,
		webhook_secrets: false
	});

	let tenants = $derived(
		tenantStore.tenants.filter((tenant) => tenant.lifecycle_state === 'active')
	);
	let selectedSource = $derived(tenants.find((tenant) => tenant.id === sourceTenantId));

	onMount(async () => {
		try {
			await tenantStore.reload();
			const requested = $page.url.searchParams.get('source');
			sourceTenantId =
				(requested &&
				tenantStore.tenants.some(
					(tenant) => tenant.id === requested && tenant.lifecycle_state === 'active'
				)
					? requested
					: '') ||
				tenantStore.tenants.find((tenant) => tenant.lifecycle_state === 'active')?.id ||
				'';
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_tenants_load_failed();
		} finally {
			loading = false;
		}
	});

	function validateId(value: string): string {
		if (!value) return $LL.admin_tenants_validation_id_required();
		if (value.length > 63) return $LL.admin_tenants_validation_id_too_long();
		if (!TENANT_ID_REGEX.test(value)) return $LL.admin_tenants_validation_id_format();
		return '';
	}

	function validateCode(value: string): string {
		if (!value) return '';
		if (value.length > 63) return $LL.admin_tenants_validation_code_too_long();
		if (!TENANT_ID_REGEX.test(value)) return $LL.admin_tenants_validation_code_format();
		return '';
	}

	function setParentOption(option: 'settings' | 'clients' | 'webhooks', value: boolean) {
		options[option] = value;
		if (!value && option === 'settings') options.secret_settings = false;
		if (!value && option === 'clients') options.client_credentials = false;
		if (!value && option === 'webhooks') options.webhook_secrets = false;
	}

	async function handleClone() {
		idError = validateId(newId);
		codeError = validateCode(newTenantCode);
		if (idError || codeError) return;
		if (!sourceTenantId) {
			error = $LL.admin_tenants_clone_source_required();
			return;
		}
		if (!newName.trim()) {
			error = $LL.admin_tenants_name_required();
			return;
		}

		cloning = true;
		error = '';
		try {
			const request = {
				id: newId,
				tenant_code: newTenantCode.trim() || undefined,
				name: newName.trim(),
				description: newDescription.trim() || undefined,
				copy: { ...options }
			};
			const fingerprint = JSON.stringify({ sourceTenantId, request });
			if (fingerprint !== cloneAttemptFingerprint) {
				cloneAttemptFingerprint = fingerprint;
				cloneAttemptIdempotencyKey = crypto.randomUUID();
			}
			result = await adminTenantsAPI.clone(sourceTenantId, request, cloneAttemptIdempotencyKey);
			tenantStore.add(result);
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_tenants_clone_failed();
		} finally {
			cloning = false;
		}
	}

	function resetForm() {
		result = null;
		newId = '';
		newTenantCode = '';
		newName = '';
		newDescription = '';
		idError = '';
		codeError = '';
		cloneAttemptFingerprint = '';
		cloneAttemptIdempotencyKey = '';
	}
</script>

<svelte:head>
	<title>{$LL.admin_tenants_clone_head_title()}</title>
</svelte:head>

<AdminPageShell width="narrow">
	<a href="/admin/tenants" class="back-link">
		<i class="i-ph-arrow-left"></i>
		{$LL.admin_tenants_back_to_tenants()}
	</a>

	<AdminPageHeader
		title={$LL.admin_tenants_clone_title()}
		description={$LL.admin_tenants_clone_description()}
	/>

	{#if error}
		<div class="alert alert-error" role="alert">
			<i class="i-ph-warning-circle"></i>
			{error}
		</div>
	{/if}

	{#if loading}
		<div class="loading-state">
			<i class="i-ph-circle-notch animate-spin"></i>
			{$LL.admin_tenants_loading()}
		</div>
	{:else if result}
		<section class="result-panel" aria-labelledby="clone-result-heading">
			<div class="result-icon" aria-hidden="true"><i class="i-ph-check-circle"></i></div>
			<div>
				<h2 id="clone-result-heading">{$LL.admin_tenants_clone_success_title()}</h2>
				<p>{$LL.admin_tenants_clone_success_description({ name: result.name })}</p>
			</div>
			<dl class="result-counts">
				<div>
					<dt>{$LL.admin_tenants_clone_result_settings()}</dt>
					<dd>{result.cloned_items.settings}</dd>
				</div>
				<div>
					<dt>{$LL.admin_tenants_clone_result_clients()}</dt>
					<dd>{result.cloned_items.clients}</dd>
				</div>
				<div>
					<dt>{$LL.admin_tenants_clone_result_client_settings()}</dt>
					<dd>{result.cloned_items.client_settings}</dd>
				</div>
				<div>
					<dt>{$LL.admin_tenants_clone_result_client_contracts()}</dt>
					<dd>{result.cloned_items.client_contracts}</dd>
				</div>
				<div>
					<dt>{$LL.admin_tenants_clone_result_web_origins()}</dt>
					<dd>{result.cloned_items.client_web_origins}</dd>
				</div>
				<div>
					<dt>{$LL.admin_tenants_clone_result_roles()}</dt>
					<dd>{result.cloned_items.roles}</dd>
				</div>
				<div>
					<dt>{$LL.admin_tenants_clone_result_admin_assignments()}</dt>
					<dd>{result.cloned_items.admin_role_assignments}</dd>
				</div>
				<div>
					<dt>{$LL.admin_tenants_clone_result_webhooks()}</dt>
					<dd>{result.cloned_items.webhooks}</dd>
				</div>
			</dl>
			{#if result.warnings.length > 0}
				<div class="result-warnings" role="status">
					<strong>{$LL.admin_tenants_clone_warnings_title()}</strong>
					<ul>
						{#each result.warnings as warning (warning)}<li>{warning}</li>{/each}
					</ul>
				</div>
			{/if}
			<div class="form-actions">
				<button class="btn btn-secondary" type="button" onclick={resetForm}>
					{$LL.admin_tenants_clone_create_another()}
				</button>
				<a class="btn btn-primary" href={`/admin/tenants/${encodeURIComponent(result.id)}`}>
					<i class="i-ph-arrow-right"></i>{$LL.admin_tenants_clone_open_tenant()}
				</a>
			</div>
		</section>
	{:else}
		<form
			class="clone-form"
			onsubmit={(event) => {
				event.preventDefault();
				void handleClone();
			}}
		>
			<section class="form-section" aria-labelledby="clone-source-heading">
				<div class="section-heading">
					<i class="i-ph-copy"></i>
					<div>
						<h2 id="clone-source-heading">{$LL.admin_tenants_clone_source_title()}</h2>
						<p>{$LL.admin_tenants_clone_source_description()}</p>
					</div>
				</div>
				<div class="admin-field">
					<label for="source-tenant" class="admin-field__label">
						{$LL.admin_tenants_clone_source()} <span class="required">*</span>
					</label>
					<select id="source-tenant" class="admin-input" bind:value={sourceTenantId} required>
						<option value="">{$LL.admin_tenants_clone_source_placeholder()}</option>
						{#each tenants as tenant (tenant.id)}
							<option value={tenant.id}>{tenant.name} ({tenant.id})</option>
						{/each}
					</select>
					{#if selectedSource?.description}
						<p class="field-hint">{selectedSource.description}</p>
					{/if}
				</div>
			</section>

			<section class="form-section" aria-labelledby="clone-destination-heading">
				<div class="section-heading">
					<i class="i-ph-buildings"></i>
					<div>
						<h2 id="clone-destination-heading">{$LL.admin_tenants_clone_destination_title()}</h2>
						<p>{$LL.admin_tenants_clone_destination_description()}</p>
					</div>
				</div>
				<div class="form-grid">
					<div class="admin-field">
						<label for="clone-id" class="admin-field__label">
							{$LL.admin_tenants_tenant_id()} <span class="required">*</span>
						</label>
						<input
							id="clone-id"
							class:error={!!idError}
							class="admin-input"
							bind:value={newId}
							oninput={() => (idError = validateId(newId))}
							maxlength="63"
							autocomplete="off"
							required
							aria-invalid={!!idError}
							aria-describedby={idError ? 'clone-id-error' : undefined}
						/>
						{#if idError}<p id="clone-id-error" class="field-error">{idError}</p>{/if}
					</div>
					<div class="admin-field">
						<label for="clone-code" class="admin-field__label"
							>{$LL.admin_tenants_tenant_code()}</label
						>
						<input
							id="clone-code"
							class:error={!!codeError}
							class="admin-input"
							bind:value={newTenantCode}
							oninput={() => (codeError = validateCode(newTenantCode))}
							maxlength="63"
							autocomplete="off"
							aria-invalid={!!codeError}
							aria-describedby={codeError ? 'clone-code-error' : 'clone-code-hint'}
						/>
						<p id="clone-code-hint" class="field-hint">{$LL.admin_tenants_code_hint()}</p>
						{#if codeError}<p id="clone-code-error" class="field-error">{codeError}</p>{/if}
					</div>
					<div class="admin-field admin-field--full">
						<label for="clone-name" class="admin-field__label">
							{$LL.admin_tenants_name()} <span class="required">*</span>
						</label>
						<input
							id="clone-name"
							class="admin-input"
							bind:value={newName}
							maxlength="200"
							required
						/>
					</div>
					<div class="admin-field admin-field--full">
						<label for="clone-description" class="admin-field__label"
							>{$LL.admin_tenants_description_label()}</label
						>
						<textarea
							id="clone-description"
							class="admin-input"
							bind:value={newDescription}
							maxlength="500"
							rows="3"
						></textarea>
					</div>
				</div>
			</section>

			<section class="form-section" aria-labelledby="clone-options-heading">
				<div class="section-heading">
					<i class="i-ph-sliders-horizontal"></i>
					<div>
						<h2 id="clone-options-heading">{$LL.admin_tenants_clone_options_title()}</h2>
						<p>{$LL.admin_tenants_clone_options_description()}</p>
					</div>
				</div>

				<div class="option-list">
					<label class="copy-option">
						<input
							type="checkbox"
							checked={options.settings}
							onchange={(e) => setParentOption('settings', e.currentTarget.checked)}
						/>
						<span
							><strong>{$LL.admin_tenants_clone_settings()}</strong><small
								>{$LL.admin_tenants_clone_settings_hint()}</small
							></span
						>
					</label>
					<label class="copy-option nested sensitive" class:disabled={!options.settings}>
						<input
							type="checkbox"
							bind:checked={options.secret_settings}
							disabled={!options.settings}
						/>
						<span
							><strong>{$LL.admin_tenants_clone_secret_settings()}</strong><small
								>{$LL.admin_tenants_clone_secret_settings_hint()}</small
							></span
						>
					</label>

					<label class="copy-option">
						<input type="checkbox" bind:checked={options.roles} />
						<span
							><strong>{$LL.admin_tenants_clone_roles()}</strong><small
								>{$LL.admin_tenants_clone_roles_hint()}</small
							></span
						>
					</label>
					<label class="copy-option">
						<input type="checkbox" bind:checked={options.admin_access} />
						<span
							><strong>{$LL.admin_tenants_clone_admin_access()}</strong><small
								>{$LL.admin_tenants_clone_admin_access_hint()}</small
							></span
						>
					</label>

					<label class="copy-option">
						<input
							type="checkbox"
							checked={options.clients}
							onchange={(e) => setParentOption('clients', e.currentTarget.checked)}
						/>
						<span
							><strong>{$LL.admin_tenants_clone_clients()}</strong><small
								>{$LL.admin_tenants_clone_clients_hint()}</small
							></span
						>
					</label>
					<label class="copy-option nested sensitive" class:disabled={!options.clients}>
						<input
							type="checkbox"
							bind:checked={options.client_credentials}
							disabled={!options.clients}
						/>
						<span
							><strong>{$LL.admin_tenants_clone_client_credentials()}</strong><small
								>{$LL.admin_tenants_clone_client_credentials_hint()}</small
							></span
						>
					</label>

					<label class="copy-option">
						<input
							type="checkbox"
							checked={options.webhooks}
							onchange={(e) => setParentOption('webhooks', e.currentTarget.checked)}
						/>
						<span
							><strong>{$LL.admin_tenants_clone_webhooks()}</strong><small
								>{$LL.admin_tenants_clone_webhooks_hint()}</small
							></span
						>
					</label>
					<label class="copy-option nested sensitive" class:disabled={!options.webhooks}>
						<input
							type="checkbox"
							bind:checked={options.webhook_secrets}
							disabled={!options.webhooks}
						/>
						<span
							><strong>{$LL.admin_tenants_clone_webhook_secrets()}</strong><small
								>{$LL.admin_tenants_clone_webhook_secrets_hint()}</small
							></span
						>
					</label>
				</div>

				<div class="key-notice">
					<i class="i-ph-key"></i>
					<div>
						<strong>{$LL.admin_tenants_clone_signing_keys()}</strong>
						<p>{$LL.admin_tenants_clone_signing_keys_hint()}</p>
					</div>
				</div>
			</section>

			<div class="form-actions">
				<a href="/admin/tenants" class="btn btn-secondary">{$LL.admin_tenants_cancel()}</a>
				<button class="btn btn-primary" type="submit" disabled={cloning || !sourceTenantId}>
					{#if cloning}<i class="i-ph-circle-notch animate-spin"></i>{$LL.admin_tenants_cloning()}
					{:else}<i class="i-ph-copy"></i>{$LL.admin_tenants_clone_button()}{/if}
				</button>
			</div>
		</form>
	{/if}
</AdminPageShell>

<style>
	.back-link {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		margin-bottom: 1rem;
		color: var(--color-text-muted);
		font-size: 0.85rem;
		font-weight: 700;
		text-decoration: none;
	}
	.back-link:hover,
	.back-link:focus-visible {
		color: var(--color-accent);
	}
	.back-link :global(i),
	.section-heading :global(i) {
		width: 1.1rem;
		height: 1.1rem;
		flex: 0 0 auto;
	}
	.clone-form {
		display: grid;
		gap: 1rem;
	}
	.result-panel {
		display: grid;
		gap: 1rem;
		padding: 1.25rem;
		border: 1px solid color-mix(in srgb, var(--color-success) 35%, var(--color-border));
		border-radius: var(--radius-panel, var(--radius-md));
		background: var(--color-surface);
		box-shadow: var(--shadow-sm);
	}
	.result-panel h2,
	.result-panel p,
	.result-warnings ul {
		margin: 0;
	}
	.result-icon {
		color: var(--color-success);
	}
	.result-icon :global(i) {
		width: 2rem;
		height: 2rem;
	}
	.result-counts {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
		gap: 0.5rem;
		margin: 0;
	}
	.result-counts div {
		padding: 0.7rem;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		background: var(--color-surface-raised);
	}
	.result-counts dt {
		color: var(--color-text-muted);
		font-size: 0.75rem;
	}
	.result-counts dd {
		margin: 0.2rem 0 0;
		font-size: 1.2rem;
		font-weight: 700;
	}
	.result-warnings {
		padding: 0.85rem;
		border: 1px solid color-mix(in srgb, var(--color-warning) 35%, var(--color-border));
		border-radius: var(--radius-md);
		background: color-mix(in srgb, var(--color-warning) 7%, var(--color-surface));
	}
	.result-warnings ul {
		padding-left: 1.2rem;
		margin-top: 0.4rem;
	}
	.form-section {
		padding: 1.15rem;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-panel, var(--radius-md));
		background: var(--color-surface);
		box-shadow: var(--shadow-sm);
	}
	.section-heading {
		display: flex;
		gap: 0.7rem;
		align-items: flex-start;
		margin-bottom: 1rem;
	}
	.section-heading h2 {
		margin: 0;
		font-size: 1rem;
	}
	.section-heading p,
	.key-notice p {
		margin: 0.2rem 0 0;
		color: var(--color-text-muted);
		font-size: 0.8rem;
		line-height: 1.45;
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
	.field-hint,
	.field-error {
		margin: 0;
		font-size: 0.75rem;
	}
	.field-hint {
		color: var(--color-text-muted);
	}
	.field-error {
		color: var(--color-danger);
	}
	.option-list {
		display: grid;
		gap: 0.5rem;
	}
	.copy-option {
		display: grid;
		grid-template-columns: auto 1fr;
		gap: 0.7rem;
		align-items: start;
		padding: 0.75rem;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		cursor: pointer;
	}
	.copy-option:hover {
		border-color: color-mix(in srgb, var(--color-accent) 40%, var(--color-border));
	}
	.copy-option input {
		width: 1rem;
		height: 1rem;
		margin-top: 0.1rem;
		accent-color: var(--color-accent);
	}
	.copy-option span {
		display: grid;
		gap: 0.2rem;
	}
	.copy-option small {
		color: var(--color-text-muted);
		line-height: 1.4;
	}
	.copy-option.nested {
		margin-left: 1.75rem;
		background: var(--color-surface-raised);
	}
	.copy-option.sensitive {
		border-color: color-mix(in srgb, var(--color-warning) 34%, var(--color-border));
	}
	.copy-option.disabled {
		opacity: 0.58;
		cursor: not-allowed;
	}
	.key-notice,
	.alert {
		display: flex;
		align-items: flex-start;
		gap: 0.7rem;
		padding: 0.85rem;
		margin-top: 0.85rem;
		border: 1px solid color-mix(in srgb, var(--color-accent) 28%, var(--color-border));
		border-radius: var(--radius-md);
		background: color-mix(in srgb, var(--color-accent) 7%, var(--color-surface));
	}
	.key-notice :global(i),
	.alert :global(i) {
		width: 1.1rem;
		height: 1.1rem;
		flex: 0 0 auto;
	}
	.alert-error {
		color: var(--color-danger);
		border-color: color-mix(in srgb, var(--color-danger) 30%, var(--color-border));
		background: color-mix(in srgb, var(--color-danger) 8%, var(--color-surface));
		margin-bottom: 1rem;
	}
	.form-actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
		flex-wrap: wrap;
	}
	@media (max-width: 720px) {
		.form-grid {
			grid-template-columns: 1fr;
		}
		.copy-option.nested {
			margin-left: 0.75rem;
		}
	}
</style>
