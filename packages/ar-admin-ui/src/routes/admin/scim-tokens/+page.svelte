<script lang="ts">
	import { onMount } from 'svelte';
	import {
		adminScimTokensAPI,
		type ScimToken,
		type CreateScimTokenResponse
	} from '$lib/api/admin-scim-tokens';
	import { Modal } from '$lib/components';
	import { LL } from '$i18n/i18n-svelte';

	let tokens: ScimToken[] = $state([]);
	let loading = $state(true);
	let error = $state('');

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
		loadTokens();
	});

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

<div class="admin-page">
	<!-- Page Header -->
	<div class="page-header">
		<div>
			<h1 class="page-title">{$LL.admin_scim_tokens_title()}</h1>
			<p class="page-description">
				{$LL.admin_scim_tokens_description()}
			</p>
		</div>
		<div class="page-actions">
			<button class="btn btn-primary" onclick={openCreateDialog}>
				<i class="i-ph-plus"></i>
				{$LL.admin_scim_tokens_create_token()}
			</button>
		</div>
	</div>

	{#if error}
		<div class="alert alert-error">{error}</div>
	{/if}

	{#if loading}
		<div class="loading-state">
			<i class="i-ph-circle-notch loading-spinner"></i>
			<p>{$LL.admin_scim_tokens_loading()}</p>
		</div>
	{:else if tokens.length === 0}
		<div class="panel">
			<div class="empty-state">
				<p class="empty-state-description">{$LL.admin_scim_tokens_empty()}</p>
				<p class="empty-state-hint">
					{$LL.admin_scim_tokens_empty_hint()}
				</p>
				<button class="btn btn-primary" onclick={openCreateDialog}
					>{$LL.admin_scim_tokens_create_token()}</button
				>
			</div>
		</div>
	{:else}
		<div class="data-table-container">
			<table class="data-table">
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
			</table>
		</div>
	{/if}
</div>

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

	<div class="form-group">
		<label for="description" class="form-label"
			>{$LL.admin_scim_tokens_description_optional()}</label
		>
		<input
			id="description"
			type="text"
			class="form-input"
			bind:value={newTokenDescription}
			placeholder="e.g., Okta SCIM Integration"
		/>
	</div>

	<div class="form-group">
		<label for="expiresInDays" class="form-label">{$LL.admin_scim_tokens_expires_in_days()}</label>
		<input
			id="expiresInDays"
			type="number"
			min="1"
			max="3650"
			class="form-input"
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

	<div class="form-group">
		<!-- svelte-ignore a11y_label_has_associated_control -->
		<label class="form-label">{$LL.admin_scim_tokens_scim_token()}</label>
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
