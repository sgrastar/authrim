<script lang="ts">
	import { onMount } from 'svelte';
	import {
		adminScimTokensAPI,
		type ScimToken,
		type CreateScimTokenResponse,
		type ScimInboundSettings
	} from '$lib/api/admin-scim-tokens';
	import {
		adminIdentityMappingAPI,
		type IdentityMappingFieldMappingSetSummary
	} from '$lib/api/admin-identity-mapping';
	import { Modal } from '$lib/components';
	import { LL } from '$i18n/i18n-svelte';
	import AdminDataTable from '$lib/components/admin/AdminDataTable.svelte';
	import AdminPageHeader from '$lib/components/admin/AdminPageHeader.svelte';
	import AdminPageShell from '$lib/components/admin/AdminPageShell.svelte';
	import AdminSection from '$lib/components/admin/AdminSection.svelte';

	let tokens: ScimToken[] = $state([]);
	let loading = $state(true);
	let error = $state('');
	let settings = $state<ScimInboundSettings>({
		enabled: false,
		usersEnabled: true,
		groupsEnabled: true,
		bulkEnabled: true,
		mappingSetId: null,
		bulkMaxOperations: 100,
		bulkMaxPayloadSize: 1048576
	});
	let mappingSets = $state<IdentityMappingFieldMappingSetSummary[]>([]);
	let settingsLoading = $state(true);
	let settingsSaving = $state(false);
	let settingsMessage = $state('');
	let settingsError = $state('');

	// Create token dialog state
	let showCreateDialog = $state(false);
	let creating = $state(false);
	let createError = $state('');
	let newTokenDescription = $state('');
	let newTokenExpiresInDays = $state(365);

	// Token created success dialog state
	let showTokenCreatedDialog = $state(false);
	let createdToken: CreateScimTokenResponse | null = $state(null);
	let tokenCopied = $state(false);

	// Revoke confirmation dialog state
	let showRevokeDialog = $state(false);
	let tokenToRevoke: ScimToken | null = $state(null);
	let revoking = $state(false);
	let revokeError = $state('');

	async function loadTokens() {
		loading = true;
		error = '';

		try {
			const response = await adminScimTokensAPI.list();
			tokens = response.tokens;
		} catch {
			error = $LL.admin_scim_tokens_load_failed();
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		void Promise.all([loadTokens(), loadSettingsAndMappings()]);
	});

	async function loadSettingsAndMappings() {
		settingsLoading = true;
		settingsError = '';
		try {
			const [settingsResult, mappingResult] = await Promise.all([
				adminScimTokensAPI.getSettings(),
				adminIdentityMappingAPI.listFieldMappingSets()
			]);
			settings = settingsResult.settings;
			mappingSets = mappingResult.fieldMappingSets.filter(
				(mappingSet) => mappingSet.lifecycleState === 'active'
			);
		} catch (err) {
			settingsError =
				err instanceof Error ? err.message : $LL.admin_scim_tokens_settings_load_failed();
		} finally {
			settingsLoading = false;
		}
	}

	async function saveSettings() {
		settingsSaving = true;
		settingsError = '';
		settingsMessage = '';
		try {
			const result = await adminScimTokensAPI.updateSettings(settings);
			settings = result.settings;
			settingsMessage = $LL.admin_scim_tokens_settings_saved();
		} catch (err) {
			settingsError =
				err instanceof Error ? err.message : $LL.admin_scim_tokens_settings_save_failed();
		} finally {
			settingsSaving = false;
		}
	}

	function openCreateDialog() {
		newTokenDescription = '';
		newTokenExpiresInDays = 365;
		createError = '';
		showCreateDialog = true;
	}

	function closeCreateDialog() {
		showCreateDialog = false;
		newTokenDescription = '';
		createError = '';
	}

	async function confirmCreate() {
		creating = true;
		createError = '';

		try {
			const result = await adminScimTokensAPI.create({
				description: newTokenDescription || undefined,
				expiresInDays: newTokenExpiresInDays
			});

			createdToken = result;
			showCreateDialog = false;
			tokenCopied = false;
			showTokenCreatedDialog = true;
			await loadTokens();
		} catch (err) {
			createError = err instanceof Error ? err.message : $LL.admin_scim_tokens_create_failed();
		} finally {
			creating = false;
		}
	}

	function closeTokenCreatedDialog() {
		showTokenCreatedDialog = false;
		createdToken = null;
		tokenCopied = false;
	}

	async function copyTokenToClipboard() {
		if (!createdToken) return;

		try {
			await navigator.clipboard.writeText(createdToken.token);
			tokenCopied = true;
		} catch {
			tokenCopied = false;
		}
	}

	function openRevokeDialog(token: ScimToken) {
		tokenToRevoke = token;
		revokeError = '';
		showRevokeDialog = true;
	}

	function closeRevokeDialog() {
		showRevokeDialog = false;
		tokenToRevoke = null;
		revokeError = '';
	}

	async function confirmRevoke() {
		if (!tokenToRevoke) return;

		revoking = true;
		revokeError = '';

		try {
			await adminScimTokensAPI.revoke(tokenToRevoke.tokenHash);
			showRevokeDialog = false;
			tokenToRevoke = null;
			await loadTokens();
		} catch (err) {
			revokeError = err instanceof Error ? err.message : $LL.admin_scim_tokens_revoke_failed();
		} finally {
			revoking = false;
		}
	}

	function formatTokenHash(hash: string): string {
		return hash.slice(0, 8) + '...';
	}
</script>

<svelte:head>
	<title>{$LL.admin_scim_tokens_head_title()}</title>
</svelte:head>

{#snippet pageActions()}
	<button class="btn btn-primary" onclick={openCreateDialog}>
		<i class="i-ph-plus" aria-hidden="true"></i>
		{$LL.admin_scim_tokens_create_token()}
	</button>
{/snippet}

<AdminPageShell>
	<AdminPageHeader
		title={$LL.admin_scim_tokens_title()}
		description={$LL.admin_scim_tokens_description()}
		actions={pageActions}
	/>

	{#if error}
		<div class="alert alert-error">{error}</div>
	{/if}

	<AdminSection title={$LL.admin_scim_tokens_inbound_title()}>
		{#if settingsError}<div class="alert alert-error">{settingsError}</div>{/if}
		{#if settingsMessage}<div class="alert alert-success">{settingsMessage}</div>{/if}
		{#if settingsLoading}
			<p>{$LL.admin_scim_tokens_settings_loading()}</p>
		{:else}
			<div class="settings-grid">
				<label class="check-row">
					<input type="checkbox" bind:checked={settings.enabled} />
					<span>{$LL.admin_scim_tokens_inbound_enabled()}</span>
				</label>
				<div class="admin-field dialog-field">
					<label class="admin-field__label" for="mappingSet"
						>{$LL.admin_scim_tokens_mapping_set()}</label
					>
					<select id="mappingSet" class="admin-input" bind:value={settings.mappingSetId}>
						<option value={null}>{$LL.admin_scim_tokens_mapping_set_placeholder()}</option>
						{#each mappingSets as mappingSet (mappingSet.id)}
							<option value={mappingSet.id}>
								{mappingSet.displayName} ({mappingSet.lifecycleState})
							</option>
						{/each}
					</select>
					<p class="form-hint">
						{$LL.admin_scim_tokens_mapping_set_hint()}
					</p>
				</div>
				<div class="operation-grid">
					<label class="check-row"
						><input type="checkbox" bind:checked={settings.usersEnabled} />
						{$LL.admin_scim_tokens_users_resource()}</label
					>
					<label class="check-row"
						><input type="checkbox" bind:checked={settings.groupsEnabled} />
						{$LL.admin_scim_tokens_groups_resource()}</label
					>
					<label class="check-row"
						><input type="checkbox" bind:checked={settings.bulkEnabled} />
						{$LL.admin_scim_tokens_bulk_resource()}</label
					>
				</div>
				<div class="limit-grid">
					<div class="admin-field dialog-field">
						<label class="admin-field__label" for="bulkMaxOperations"
							>{$LL.admin_scim_tokens_bulk_max_operations()}</label
						>
						<input
							id="bulkMaxOperations"
							class="admin-input"
							type="number"
							min="1"
							max="1000"
							bind:value={settings.bulkMaxOperations}
						/>
					</div>
					<div class="admin-field dialog-field">
						<label class="admin-field__label" for="bulkMaxPayloadSize"
							>{$LL.admin_scim_tokens_bulk_max_payload()}</label
						>
						<input
							id="bulkMaxPayloadSize"
							class="admin-input"
							type="number"
							min="1024"
							max="10485760"
							bind:value={settings.bulkMaxPayloadSize}
						/>
					</div>
				</div>
				<button
					class="btn btn-primary"
					onclick={saveSettings}
					disabled={settingsSaving || (settings.enabled && !settings.mappingSetId)}
				>
					{settingsSaving
						? $LL.admin_scim_tokens_settings_saving()
						: $LL.admin_scim_tokens_settings_save()}
				</button>
			</div>
		{/if}
	</AdminSection>

	{#if loading}
		<div class="loading-state">
			<i class="i-ph-circle-notch loading-spinner"></i>
			<p>{$LL.admin_scim_tokens_loading()}</p>
		</div>
	{:else if tokens.length === 0}
		<AdminSection>
			<div class="empty-state">
				<p class="empty-state-description">{$LL.admin_scim_tokens_empty()}</p>
				<p class="empty-state-hint">
					{$LL.admin_scim_tokens_empty_hint()}
				</p>
				<button class="btn btn-primary" onclick={openCreateDialog}
					>{$LL.admin_scim_tokens_create_token()}</button
				>
			</div>
		</AdminSection>
	{:else}
		<AdminSection title={$LL.admin_scim_tokens_title()}>
			<AdminDataTable>
				<thead>
					<tr>
						<th>{$LL.admin_scim_tokens_token_hash()}</th>
						<th>{$LL.admin_scim_tokens_description_label()}</th>
						<th>{$LL.admin_scim_tokens_expires_in_days()}</th>
						<th>{$LL.admin_scim_tokens_status()}</th>
						<th class="text-right">{$LL.admin_scim_tokens_actions()}</th>
					</tr>
				</thead>
				<tbody>
					{#each tokens as token (token.tokenHash)}
						<tr>
							<td class="mono">{formatTokenHash(token.tokenHash)}</td>
							<td>{token.description || '-'}</td>
							<td>{token.expiresInDays}</td>
							<td>
								<span class={token.enabled ? 'badge badge-success' : 'badge badge-danger'}>
									{token.enabled
										? $LL.admin_scim_tokens_enabled()
										: $LL.admin_scim_tokens_disabled()}
								</span>
							</td>
							<td class="text-right">
								<button class="btn btn-danger btn-sm" onclick={() => openRevokeDialog(token)}>
									{$LL.admin_scim_tokens_revoke()}
								</button>
							</td>
						</tr>
					{/each}
				</tbody>
			</AdminDataTable>
		</AdminSection>
	{/if}
</AdminPageShell>

<!-- Create Token Dialog -->
<Modal
	open={showCreateDialog}
	onClose={closeCreateDialog}
	title={$LL.admin_scim_tokens_create_title()}
	size="md"
>
	{#if createError}
		<div class="alert alert-error">{createError}</div>
	{/if}

	<div class="admin-field dialog-field">
		<label for="description" class="admin-field__label"
			>{$LL.admin_scim_tokens_description_optional()}</label
		>
		<input
			id="description"
			type="text"
			class="admin-input"
			bind:value={newTokenDescription}
			placeholder="e.g., Okta SCIM Integration"
		/>
	</div>

	<div class="admin-field dialog-field">
		<label for="expiresInDays" class="admin-field__label"
			>{$LL.admin_scim_tokens_expires_in_days()}</label
		>
		<input
			id="expiresInDays"
			type="number"
			min="1"
			max="3650"
			class="admin-input"
			bind:value={newTokenExpiresInDays}
		/>
		<p class="form-hint">{$LL.admin_scim_tokens_valid_range()}</p>
	</div>

	{#snippet footer()}
		<button class="btn btn-secondary" onclick={closeCreateDialog} disabled={creating}>
			{$LL.admin_scim_tokens_cancel()}
		</button>
		<button class="btn btn-primary" onclick={confirmCreate} disabled={creating}>
			{creating ? $LL.admin_scim_tokens_creating() : $LL.admin_scim_tokens_create_token()}
		</button>
	{/snippet}
</Modal>

<!-- Token Created Success Dialog -->
<Modal
	open={showTokenCreatedDialog && !!createdToken}
	onClose={closeTokenCreatedDialog}
	title={$LL.admin_scim_tokens_created_title()}
	size="lg"
	closeOnOutsideClick={false}
>
	<div class="alert alert-warning">
		<i class="i-ph-warning"></i>
		<span>{$LL.admin_scim_tokens_save_now_warning()}</span>
	</div>

	<div class="admin-field dialog-field">
		<!-- svelte-ignore a11y_label_has_associated_control -->
		<label class="admin-field__label">{$LL.admin_scim_tokens_scim_token()}</label>
		<div class="token-display">
			<code class="token-value">{createdToken?.token}</code>
			<button
				class={tokenCopied ? 'btn btn-success btn-sm' : 'btn btn-primary btn-sm'}
				onclick={copyTokenToClipboard}
			>
				{tokenCopied ? $LL.admin_scim_tokens_copied() : $LL.admin_scim_tokens_copy()}
			</button>
		</div>
	</div>

	<div class="info-box">
		<div class="info-row">
			<span class="info-label">{$LL.admin_scim_tokens_description_colon()}</span>
			<span class="info-value">{createdToken?.description || $LL.admin_scim_tokens_none()}</span>
		</div>
		<div class="info-row">
			<span class="info-label">{$LL.admin_scim_tokens_expires_in_colon()}</span>
			<span class="info-value"
				>{$LL.admin_scim_tokens_days({ count: createdToken?.expiresInDays ?? 0 })}</span
			>
		</div>
	</div>

	{#snippet footer()}
		<button class="btn btn-primary" onclick={closeTokenCreatedDialog}
			>{$LL.admin_scim_tokens_done()}</button
		>
	{/snippet}
</Modal>

<!-- Revoke Confirmation Dialog -->
<Modal
	open={showRevokeDialog && !!tokenToRevoke}
	onClose={closeRevokeDialog}
	title={$LL.admin_scim_tokens_revoke_title()}
	size="md"
>
	{#if revokeError}
		<div class="alert alert-error">{revokeError}</div>
	{/if}

	<p class="modal-description">
		{$LL.admin_scim_tokens_revoke_confirm()}
	</p>

	<div class="info-box">
		<div class="info-row">
			<span class="info-label">{$LL.admin_scim_tokens_token_hash_colon()}</span>
			<code class="info-value">{formatTokenHash(tokenToRevoke?.tokenHash ?? '')}</code>
		</div>
		<div class="info-row">
			<span class="info-label">{$LL.admin_scim_tokens_description_colon()}</span>
			<span class="info-value">{tokenToRevoke?.description || $LL.admin_scim_tokens_none()}</span>
		</div>
	</div>

	{#snippet footer()}
		<button class="btn btn-secondary" onclick={closeRevokeDialog} disabled={revoking}>
			{$LL.admin_scim_tokens_cancel()}
		</button>
		<button class="btn btn-danger" onclick={confirmRevoke} disabled={revoking}>
			{revoking ? $LL.admin_scim_tokens_revoking() : $LL.admin_scim_tokens_revoke_token()}
		</button>
	{/snippet}
</Modal>

<style>
	.dialog-field {
		display: grid;
		gap: 6px;
		margin-bottom: 16px;
	}

	.settings-grid {
		display: grid;
		gap: 16px;
		max-width: 760px;
	}

	.check-row {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.operation-grid,
	.limit-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
		gap: 12px;
	}

	.dialog-field :global(.admin-field__label) {
		font-family: var(--font-meta, var(--font-body));
		font-size: var(--field-label-size, 0.68rem);
		font-weight: 700;
		letter-spacing: var(--field-label-letter-spacing, 0.16em);
		text-transform: uppercase;
		color: var(--color-text-subtle);
	}

	.dialog-field :global(.admin-input) {
		width: 100%;
		min-height: var(--control-height, 38px);
		padding: var(--control-padding, 8px 12px);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-control);
		background: var(--control-bg, var(--color-surface));
		color: var(--color-text);
		font: inherit;
		outline: none;
	}

	.dialog-field :global(.admin-input:focus) {
		border-color: var(--color-accent);
		box-shadow: 0 0 0 3px var(--color-accent-muted);
	}

	.token-display {
		display: flex;
		align-items: stretch;
		gap: 10px;
	}

	.token-value {
		flex: 1;
		min-width: 0;
		overflow-wrap: anywhere;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-control);
		padding: 10px 12px;
		background: var(--color-surface-raised);
		color: var(--color-text);
		font-family: var(--font-mono);
		font-size: 0.82rem;
	}

	@media (max-width: 640px) {
		.token-display {
			flex-direction: column;
		}
	}
</style>
