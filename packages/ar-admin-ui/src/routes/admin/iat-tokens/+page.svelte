<script lang="ts">
	import { onMount } from 'svelte';
	import {
		adminIatTokensAPI,
		type IatToken,
		type CreateIatTokenResponse
	} from '$lib/api/admin-iat-tokens';
	import { ToggleSwitch, Modal } from '$lib/components';
	import { getLocale, LL } from '$i18n/i18n-svelte';
	import AdminDataTable from '$lib/components/admin/AdminDataTable.svelte';
	import AdminPageHeader from '$lib/components/admin/AdminPageHeader.svelte';
	import AdminPageShell from '$lib/components/admin/AdminPageShell.svelte';
	import AdminSection from '$lib/components/admin/AdminSection.svelte';

	let tokens: IatToken[] = $state([]);
	let loading = $state(true);
	let error = $state('');

	// Create token dialog state
	let showCreateDialog = $state(false);
	let creating = $state(false);
	let createError = $state('');
	let newTokenDescription = $state('');
	let newTokenExpiresInDays = $state(30);
	let newTokenSingleUse = $state(false);

	// Token created success dialog state
	let showTokenCreatedDialog = $state(false);
	let createdToken: CreateIatTokenResponse | null = $state(null);
	let tokenCopied = $state(false);

	// Revoke confirmation dialog state
	let showRevokeDialog = $state(false);
	let tokenToRevoke: IatToken | null = $state(null);
	let revoking = $state(false);
	let revokeError = $state('');

	async function loadTokens() {
		loading = true;
		error = '';

		try {
			const response = await adminIatTokensAPI.list();
			tokens = response.tokens;
		} catch (err) {
			console.error('Failed to load IAT tokens:', err);
			error = $LL.admin_iat_tokens_load_failed();
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		loadTokens();
	});

	function openCreateDialog() {
		newTokenDescription = '';
		newTokenExpiresInDays = 30;
		newTokenSingleUse = false;
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
			const result = await adminIatTokensAPI.create({
				description: newTokenDescription || undefined,
				expiresInDays: newTokenExpiresInDays,
				single_use: newTokenSingleUse
			});

			createdToken = result;
			showCreateDialog = false;
			tokenCopied = false;
			showTokenCreatedDialog = true;
			await loadTokens();
		} catch (err) {
			createError = err instanceof Error ? err.message : $LL.admin_iat_tokens_create_failed();
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
		} catch (err) {
			console.error('Failed to copy token:', err);
		}
	}

	function openRevokeDialog(token: IatToken) {
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
			await adminIatTokensAPI.revoke(tokenToRevoke.tokenHash);
			showRevokeDialog = false;
			tokenToRevoke = null;
			await loadTokens();
		} catch (err) {
			revokeError = err instanceof Error ? err.message : $LL.admin_iat_tokens_revoke_failed();
		} finally {
			revoking = false;
		}
	}

	function formatTokenHash(hash: string): string {
		return hash.slice(0, 8) + '...';
	}

	function formatDateTime(isoString: string): string {
		return new Date(isoString).toLocaleString(getLocale() === 'ja' ? 'ja-JP' : 'en-US');
	}

	function isExpired(expiresAt: string | null): boolean {
		if (!expiresAt) return false;
		return new Date(expiresAt).getTime() < Date.now();
	}
</script>

<svelte:head>
	<title>{$LL.admin_iat_tokens_page_title()}</title>
</svelte:head>

{#snippet headerActions()}
	<button class="btn btn-primary" onclick={openCreateDialog}>
		<i class="i-ph-plus"></i>
		{$LL.admin_iat_tokens_create_token()}
	</button>
{/snippet}

<AdminPageShell>
	<AdminPageHeader
		title={$LL.admin_iat_tokens_title()}
		description={$LL.admin_iat_tokens_description()}
		actions={headerActions}
	/>
	{#if error}
		<div class="alert alert-error">{error}</div>
	{/if}

	{#if loading}
		<div class="loading-state">
			<i class="i-ph-circle-notch loading-spinner"></i>
			<p>{$LL.admin_iat_tokens_loading()}</p>
		</div>
	{:else if tokens.length === 0}
		<AdminSection>
			<div class="empty-state">
				<p class="empty-state-description">{$LL.admin_iat_tokens_empty()}</p>
				<p class="empty-state-hint">
					{$LL.admin_iat_tokens_empty_hint()}
				</p>
				<button class="btn btn-primary" onclick={openCreateDialog}
					>{$LL.admin_iat_tokens_create_token()}</button
				>
			</div>
		</AdminSection>
	{:else}
		<AdminSection>
			<AdminDataTable width="wide">
				<thead>
					<tr>
						<th>{$LL.admin_iat_tokens_token_hash()}</th>
						<th>{$LL.admin_iat_tokens_description_label()}</th>
						<th>{$LL.admin_iat_tokens_created()}</th>
						<th>{$LL.admin_iat_tokens_expires()}</th>
						<th>{$LL.admin_iat_tokens_single_use()}</th>
						<th class="text-right">{$LL.admin_iat_tokens_actions()}</th>
					</tr>
				</thead>
				<tbody>
					{#each tokens as token (token.tokenHash)}
						<tr>
							<td class="mono">{formatTokenHash(token.tokenHash)}</td>
							<td>{token.description || '-'}</td>
							<td class="muted nowrap">{formatDateTime(token.createdAt)}</td>
							<td>
								{#if token.expiresAt}
									<span class={isExpired(token.expiresAt) ? 'danger-text' : ''}>
										{formatDateTime(token.expiresAt)}
										{#if isExpired(token.expiresAt)}
											<span class="badge badge-danger">{$LL.admin_iat_tokens_expired()}</span>
										{/if}
									</span>
								{:else}
									<span class="muted">{$LL.admin_iat_tokens_never()}</span>
								{/if}
							</td>
							<td>
								<span class={token.single_use ? 'badge badge-info' : 'badge badge-neutral'}>
									{token.single_use ? $LL.admin_iat_tokens_yes() : $LL.admin_iat_tokens_no()}
								</span>
							</td>
							<td class="text-right">
								<button class="btn btn-danger btn-sm" onclick={() => openRevokeDialog(token)}>
									{$LL.admin_iat_tokens_revoke()}
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
	title={$LL.admin_iat_tokens_create_title()}
	size="md"
>
	{#if createError}
		<div class="alert alert-error">{createError}</div>
	{/if}

	<div class="form-group">
		<label for="description" class="form-label">{$LL.admin_iat_tokens_description_optional()}</label
		>
		<input
			id="description"
			type="text"
			class="form-input"
			bind:value={newTokenDescription}
			placeholder={$LL.admin_iat_tokens_description_placeholder()}
		/>
	</div>

	<div class="form-group">
		<label for="expiresInDays" class="form-label">{$LL.admin_iat_tokens_expires_in_days()}</label>
		<input
			id="expiresInDays"
			type="number"
			min="1"
			max="365"
			class="form-input"
			bind:value={newTokenExpiresInDays}
		/>
		<p class="form-hint">{$LL.admin_iat_tokens_valid_range_days()}</p>
	</div>

	<div class="form-group">
		<ToggleSwitch
			bind:checked={newTokenSingleUse}
			label={$LL.admin_iat_tokens_single_use()}
			description={$LL.admin_iat_tokens_single_use_desc()}
		/>
	</div>

	{#snippet footer()}
		<button class="btn btn-secondary" onclick={closeCreateDialog} disabled={creating}>
			{$LL.admin_iat_tokens_cancel()}
		</button>
		<button class="btn btn-primary" onclick={confirmCreate} disabled={creating}>
			{creating ? $LL.admin_iat_tokens_creating() : $LL.admin_iat_tokens_create_token()}
		</button>
	{/snippet}
</Modal>

<!-- Token Created Success Dialog -->
<Modal
	open={showTokenCreatedDialog && !!createdToken}
	onClose={closeTokenCreatedDialog}
	title={$LL.admin_iat_tokens_created_title()}
	size="lg"
	closeOnOutsideClick={false}
>
	{#if createdToken}
		<div class="alert alert-warning">
			<i class="i-ph-warning"></i>
			<span>{$LL.admin_iat_tokens_save_now()}</span>
		</div>

		<div class="form-group">
			<!-- svelte-ignore a11y_label_has_associated_control -->
			<label class="form-label">{$LL.admin_iat_tokens_initial_access_token()}</label>
			<div class="token-display">
				<code class="token-value">{createdToken.token}</code>
				<button
					class={tokenCopied ? 'btn btn-success btn-sm' : 'btn btn-primary btn-sm'}
					onclick={copyTokenToClipboard}
				>
					{tokenCopied ? $LL.admin_iat_tokens_copied() : $LL.admin_iat_tokens_copy()}
				</button>
			</div>
		</div>

		<div class="info-box">
			<div class="info-row">
				<span class="info-label">{$LL.admin_iat_tokens_description_colon()}</span>
				<span class="info-value">{createdToken.description || $LL.admin_iat_tokens_none()}</span>
			</div>
			<div class="info-row">
				<span class="info-label">{$LL.admin_iat_tokens_expires_in()}</span>
				<span class="info-value"
					>{$LL.admin_iat_tokens_days({ count: createdToken.expiresInDays })}</span
				>
			</div>
			<div class="info-row">
				<span class="info-label">{$LL.admin_iat_tokens_single_use()}:</span>
				<span class="info-value"
					>{createdToken.single_use ? $LL.admin_iat_tokens_yes() : $LL.admin_iat_tokens_no()}</span
				>
			</div>
		</div>
	{/if}

	{#snippet footer()}
		<button class="btn btn-primary" onclick={closeTokenCreatedDialog}
			>{$LL.admin_iat_tokens_done()}</button
		>
	{/snippet}
</Modal>

<!-- Revoke Confirmation Dialog -->
<Modal
	open={showRevokeDialog && !!tokenToRevoke}
	onClose={closeRevokeDialog}
	title={$LL.admin_iat_tokens_revoke_title()}
	size="md"
>
	{#if tokenToRevoke}
		{#if revokeError}
			<div class="alert alert-error">{revokeError}</div>
		{/if}

		<p class="modal-description">
			{$LL.admin_iat_tokens_revoke_description()}
		</p>

		<div class="info-box">
			<div class="info-row">
				<span class="info-label">{$LL.admin_iat_tokens_token_hash_label()}</span>
				<code class="info-value">{formatTokenHash(tokenToRevoke.tokenHash)}</code>
			</div>
			<div class="info-row">
				<span class="info-label">{$LL.admin_iat_tokens_description_colon()}</span>
				<span class="info-value">{tokenToRevoke.description || $LL.admin_iat_tokens_none()}</span>
			</div>
		</div>
	{/if}

	{#snippet footer()}
		<button class="btn btn-secondary" onclick={closeRevokeDialog} disabled={revoking}>
			{$LL.admin_iat_tokens_cancel()}
		</button>
		<button class="btn btn-danger" onclick={confirmRevoke} disabled={revoking}>
			{revoking ? $LL.admin_iat_tokens_revoking() : $LL.admin_iat_tokens_revoke_token()}
		</button>
	{/snippet}
</Modal>
