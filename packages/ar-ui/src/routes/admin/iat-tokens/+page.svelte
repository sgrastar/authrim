<script lang="ts">
	import { onMount } from 'svelte';
	import {
		adminIatTokensAPI,
		type IatToken,
		type CreateIatTokenResponse
	} from '$lib/api/admin-iat-tokens';
	import { ToggleSwitch } from '$lib/components';

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
			error = 'Failed to load IAT tokens';
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
			createError = err instanceof Error ? err.message : 'Failed to create token';
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
			revokeError = err instanceof Error ? err.message : 'Failed to revoke token';
		} finally {
			revoking = false;
		}
	}

	function formatTokenHash(hash: string): string {
		return hash.slice(0, 8) + '...';
	}

	function formatDateTime(isoString: string): string {
		return new Date(isoString).toLocaleString();
	}

	function isExpired(expiresAt: string | null): boolean {
		if (!expiresAt) return false;
		return new Date(expiresAt).getTime() < Date.now();
	}
</script>

<svelte:head>
	<title>Initial Access Tokens - Admin Dashboard - Authrim</title>
</svelte:head>

<div class="admin-page">
	<!-- Page Header -->
	<div class="page-header">
		<div>
			<h1 class="page-title">Initial Access Tokens</h1>
			<p class="page-description">
				Initial Access Tokens (IAT) are used for Dynamic Client Registration (RFC 7591). Clients can
				use these tokens to register themselves programmatically.
			</p>
		</div>
		<div class="page-actions">
			<button class="btn btn-primary" onclick={openCreateDialog}>
				<i class="i-ph-plus"></i>
				Create Token
			</button>
		</div>
	</div>

	{#if error}
		<div class="alert alert-error">{error}</div>
	{/if}

	{#if loading}
		<div class="loading-state">
			<i class="i-ph-circle-notch loading-spinner"></i>
			<p>Loading...</p>
		</div>
	{:else if tokens.length === 0}
		<div class="panel">
			<div class="empty-state">
				<p class="empty-state-description">No Initial Access Tokens found.</p>
				<p class="empty-state-hint">
					Create a token to allow clients to register dynamically using RFC 7591.
				</p>
				<button class="btn btn-primary" onclick={openCreateDialog}>Create Token</button>
			</div>
		</div>
	{:else}
		<div class="data-table-container">
			<table class="data-table">
				<thead>
					<tr>
						<th>Token Hash</th>
						<th>Description</th>
						<th>Created</th>
						<th>Expires</th>
						<th>Single Use</th>
						<th class="text-right">Actions</th>
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
											<span class="badge badge-danger">Expired</span>
										{/if}
									</span>
								{:else}
									<span class="muted">Never</span>
								{/if}
							</td>
							<td>
								<span class={token.single_use ? 'badge badge-info' : 'badge badge-neutral'}>
									{token.single_use ? 'Yes' : 'No'}
								</span>
							</td>
							<td class="text-right">
								<button class="btn btn-danger btn-sm" onclick={() => openRevokeDialog(token)}>
									Revoke
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
{#if showCreateDialog}
	<div
		class="modal-overlay"
		onclick={closeCreateDialog}
		onkeydown={(e) => e.key === 'Escape' && closeCreateDialog()}
		tabindex="-1"
		role="dialog"
		aria-modal="true"
	>
		<div
			class="modal-content"
			onclick={(e) => e.stopPropagation()}
			onkeydown={(e) => e.stopPropagation()}
			role="document"
		>
			<div class="modal-header">
				<h2 class="modal-title">Create Initial Access Token</h2>
			</div>

			<div class="modal-body">
				{#if createError}
					<div class="alert alert-error">{createError}</div>
				{/if}

				<div class="form-group">
					<label for="description" class="form-label">Description (optional)</label>
					<input
						id="description"
						type="text"
						class="form-input"
						bind:value={newTokenDescription}
						placeholder="e.g., Mobile App Registration"
					/>
				</div>

				<div class="form-group">
					<label for="expiresInDays" class="form-label">Expires In (Days)</label>
					<input
						id="expiresInDays"
						type="number"
						min="1"
						max="365"
						class="form-input"
						bind:value={newTokenExpiresInDays}
					/>
					<p class="form-hint">Valid range: 1-365 days</p>
				</div>

				<div class="form-group">
					<ToggleSwitch
						bind:checked={newTokenSingleUse}
						label="Single Use"
						description="Token can only be used once for registration"
					/>
				</div>
			</div>

			<div class="modal-footer">
				<button class="btn btn-secondary" onclick={closeCreateDialog} disabled={creating}>
					Cancel
				</button>
				<button class="btn btn-primary" onclick={confirmCreate} disabled={creating}>
					{creating ? 'Creating...' : 'Create Token'}
				</button>
			</div>
		</div>
	</div>
{/if}

<!-- Token Created Success Dialog -->
{#if showTokenCreatedDialog && createdToken}
	<div class="modal-overlay" role="dialog" aria-modal="true">
		<div
			class="modal-content modal-lg"
			onclick={(e) => e.stopPropagation()}
			onkeydown={(e) => e.stopPropagation()}
			role="document"
		>
			<div class="modal-header">
				<h2 class="modal-title success">Token Created Successfully</h2>
			</div>

			<div class="modal-body">
				<div class="alert alert-warning">
					<i class="i-ph-warning"></i>
					<span>Save this token now - it will not be shown again!</span>
				</div>

				<div class="form-group">
					<label class="form-label">Initial Access Token</label>
					<div class="token-display">
						<code class="token-value">{createdToken.token}</code>
						<button
							class={tokenCopied ? 'btn btn-success btn-sm' : 'btn btn-primary btn-sm'}
							onclick={copyTokenToClipboard}
						>
							{tokenCopied ? 'Copied!' : 'Copy'}
						</button>
					</div>
				</div>

				<div class="info-box">
					<div class="info-row">
						<span class="info-label">Description:</span>
						<span class="info-value">{createdToken.description || 'None'}</span>
					</div>
					<div class="info-row">
						<span class="info-label">Expires In:</span>
						<span class="info-value">{createdToken.expiresInDays} days</span>
					</div>
					<div class="info-row">
						<span class="info-label">Single Use:</span>
						<span class="info-value">{createdToken.single_use ? 'Yes' : 'No'}</span>
					</div>
				</div>
			</div>

			<div class="modal-footer">
				<button class="btn btn-primary" onclick={closeTokenCreatedDialog}>Done</button>
			</div>
		</div>
	</div>
{/if}

<!-- Revoke Confirmation Dialog -->
{#if showRevokeDialog && tokenToRevoke}
	<div
		class="modal-overlay"
		onclick={closeRevokeDialog}
		onkeydown={(e) => e.key === 'Escape' && closeRevokeDialog()}
		tabindex="-1"
		role="dialog"
		aria-modal="true"
	>
		<div
			class="modal-content"
			onclick={(e) => e.stopPropagation()}
			onkeydown={(e) => e.stopPropagation()}
			role="document"
		>
			<div class="modal-header">
				<h2 class="modal-title">Revoke Initial Access Token</h2>
			</div>

			<div class="modal-body">
				{#if revokeError}
					<div class="alert alert-error">{revokeError}</div>
				{/if}

				<p class="modal-description">
					Are you sure you want to revoke this Initial Access Token? This action cannot be undone
					and will prevent any new client registrations using this token.
				</p>

				<div class="info-box">
					<div class="info-row">
						<span class="info-label">Token Hash:</span>
						<code class="info-value">{formatTokenHash(tokenToRevoke.tokenHash)}</code>
					</div>
					<div class="info-row">
						<span class="info-label">Description:</span>
						<span class="info-value">{tokenToRevoke.description || 'None'}</span>
					</div>
				</div>
			</div>

			<div class="modal-footer">
				<button class="btn btn-secondary" onclick={closeRevokeDialog} disabled={revoking}>
					Cancel
				</button>
				<button class="btn btn-danger" onclick={confirmRevoke} disabled={revoking}>
					{revoking ? 'Revoking...' : 'Revoke Token'}
				</button>
			</div>
		</div>
	</div>
{/if}
