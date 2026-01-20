<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import {
		adminClientsAPI,
		type Client,
		type ClientUsage,
		type UpdateClientInput
	} from '$lib/api/admin-clients';
	import { ToggleSwitch } from '$lib/components';

	const clientId = $derived($page.params.id ?? '');

	let client = $state<Client | null>(null);
	let usage = $state<ClientUsage | null>(null);
	let loading = $state(true);
	let error = $state('');

	// Edit mode
	let isEditing = $state(false);
	let editForm = $state<UpdateClientInput>({});
	let saving = $state(false);
	let saveError = $state('');

	// Delete modal
	let showDeleteModal = $state(false);
	let deleteConfirmName = $state('');
	let deleting = $state(false);

	// Regenerate secret modal
	let showRegenerateModal = $state(false);
	let regenerating = $state(false);
	let newSecret = $state<string | null>(null);

	// Copy feedback
	let copiedField = $state<string | null>(null);

	async function loadClient() {
		loading = true;
		error = '';

		try {
			client = await adminClientsAPI.get(clientId);
			// Load usage statistics (only on detail page per review feedback)
			try {
				usage = await adminClientsAPI.getUsage(clientId);
			} catch {
				// Usage API may not be implemented yet
				usage = null;
			}
		} catch (err) {
			console.error('Failed to load client:', err);
			error = 'Failed to load client';
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		loadClient();
	});

	function startEditing() {
		if (!client) return;
		editForm = {
			client_name: client.client_name,
			redirect_uris: [...client.redirect_uris],
			grant_types: [...client.grant_types],
			response_types: [...client.response_types],
			token_endpoint_auth_method: client.token_endpoint_auth_method,
			scope: client.scope,
			require_pkce: client.require_pkce
		};
		isEditing = true;
	}

	function cancelEditing() {
		isEditing = false;
		editForm = {};
		saveError = '';
	}

	async function saveChanges() {
		saving = true;
		saveError = '';

		try {
			client = await adminClientsAPI.update(clientId, editForm);
			isEditing = false;
		} catch (err) {
			console.error('Failed to update client:', err);
			saveError = err instanceof Error ? err.message : 'Failed to update client';
		} finally {
			saving = false;
		}
	}

	async function handleDelete() {
		if (!client || deleteConfirmName !== client.client_name) return;

		deleting = true;
		try {
			// TODO: Phase 4（監査ログ）実装時に論理削除への変更を検討
			// 現在は物理削除のため、削除されたclient_idで発行されたトークンの追跡が困難
			await adminClientsAPI.delete(clientId);
			goto('/admin/clients');
		} catch (err) {
			console.error('Failed to delete client:', err);
			error = err instanceof Error ? err.message : 'Failed to delete client';
		} finally {
			deleting = false;
			showDeleteModal = false;
		}
	}

	async function handleRegenerateSecret() {
		regenerating = true;
		try {
			const result = await adminClientsAPI.regenerateSecret(clientId);
			newSecret = result.client_secret;
		} catch (err) {
			console.error('Failed to regenerate secret:', err);
			error = err instanceof Error ? err.message : 'Failed to regenerate secret';
			showRegenerateModal = false;
		} finally {
			regenerating = false;
		}
	}

	function copyToClipboard(text: string, field: string) {
		navigator.clipboard.writeText(text);
		copiedField = field;
		setTimeout(() => {
			copiedField = null;
		}, 2000);
	}

	function formatDate(timestamp: number | null): string {
		if (!timestamp) return '-';
		return new Date(timestamp).toLocaleString();
	}

	function formatNumber(num: number): string {
		return num.toLocaleString();
	}
</script>

<svelte:head>
	<title>{client?.client_name || 'Client'} - Admin Dashboard - Authrim</title>
</svelte:head>

<div class="admin-page">
	<a href="/admin/clients" class="back-link">← Back to Clients</a>

	{#if loading}
		<div class="loading-state">
			<i class="i-ph-circle-notch loading-spinner"></i>
			<p>Loading client...</p>
		</div>
	{:else if error}
		<div class="alert alert-error">{error}</div>
	{:else if client}
		<!-- Header -->
		<div class="page-header-with-status">
			<div class="page-header-info">
				<h1>{client.client_name}</h1>
				<p class="mono">{client.client_id}</p>
			</div>
			<div class="action-buttons">
				{#if !isEditing}
					<button class="btn btn-secondary" onclick={startEditing}>Edit</button>
				{/if}
				<button class="btn btn-danger" onclick={() => (showDeleteModal = true)}>Delete</button>
			</div>
		</div>

		<!-- Usage Statistics -->
		{#if usage}
			<div class="panel">
				<h2 class="panel-title">Usage Statistics</h2>
				<div class="stats-grid">
					<div class="stat-card">
						<div class="stat-value">{formatNumber(usage.tokens_issued_24h)}</div>
						<div class="stat-label">Tokens (24h)</div>
					</div>
					<div class="stat-card">
						<div class="stat-value">{formatNumber(usage.tokens_issued_7d)}</div>
						<div class="stat-label">Tokens (7d)</div>
					</div>
					<div class="stat-card">
						<div class="stat-value">{formatNumber(usage.tokens_issued_30d)}</div>
						<div class="stat-label">Tokens (30d)</div>
					</div>
					<div class="stat-card">
						<div class="stat-value">{formatNumber(usage.active_sessions)}</div>
						<div class="stat-label">Active Sessions</div>
					</div>
				</div>
				{#if usage.last_token_issued_at}
					<p class="stat-note">Last token issued: {formatDate(usage.last_token_issued_at)}</p>
				{/if}
			</div>
		{/if}

		<!-- Client Details -->
		<div class="panel">
			{#if saveError}
				<div class="alert alert-error">{saveError}</div>
			{/if}

			<!-- Basic Info -->
			<section class="section-spacing">
				<h2 class="section-title-border">Basic Information</h2>

				<!-- Client ID -->
				<div class="form-group">
					<label class="form-label">Client ID</label>
					<div class="input-copy-group">
						<input type="text" value={client.client_id} readonly class="input-readonly" />
						<button
							class="btn-copy"
							class:copied={copiedField === 'client_id'}
							onclick={() => copyToClipboard(client!.client_id, 'client_id')}
						>
							{copiedField === 'client_id' ? '✓ Copied' : 'Copy'}
						</button>
					</div>
				</div>

				<!-- Client Name -->
				<div class="form-group">
					<label class="form-label">Client Name</label>
					{#if isEditing}
						<input type="text" class="form-input" bind:value={editForm.client_name} />
					{:else}
						<p class="display-text">{client.client_name}</p>
					{/if}
				</div>

				<!-- Client Secret -->
				<div class="form-group">
					<label class="form-label">Client Secret</label>
					<div class="input-copy-group">
						<input
							type="text"
							value={client.client_secret
								? `••••••••${client.client_secret.slice(-4)}`
								: '••••••••••••'}
							readonly
							class="input-readonly"
						/>
						<button class="btn btn-warning btn-sm" onclick={() => (showRegenerateModal = true)}>
							Regenerate
						</button>
					</div>
					<p class="form-hint">Secret is only fully visible when created or regenerated</p>
				</div>
			</section>

			<!-- OAuth Settings -->
			<section class="section-spacing">
				<h2 class="section-title-border">OAuth Settings</h2>

				<div class="form-grid">
					<!-- Grant Types -->
					<div class="form-group">
						<label class="form-label">Grant Types</label>
						{#if isEditing}
							<div class="checkbox-list">
								{#each [{ value: 'authorization_code', label: 'Authorization Code' }, { value: 'refresh_token', label: 'Refresh Token' }, { value: 'client_credentials', label: 'Client Credentials' }, { value: 'implicit', label: 'Implicit (Legacy)' }, { value: 'urn:ietf:params:oauth:grant-type:device_code', label: 'Device Code' }] as grantType (grantType.value)}
									<label class="checkbox-list-item">
										<input
											type="checkbox"
											checked={editForm.grant_types?.includes(grantType.value)}
											onchange={(e) => {
												const target = e.target as HTMLInputElement;
												if (target.checked) {
													editForm.grant_types = [...(editForm.grant_types || []), grantType.value];
												} else {
													editForm.grant_types = (editForm.grant_types || []).filter(
														(g) => g !== grantType.value
													);
												}
											}}
										/>
										{grantType.label}
									</label>
								{/each}
							</div>
						{:else}
							<p class="display-text">{client.grant_types.join(', ') || '-'}</p>
						{/if}
					</div>

					<!-- Response Types -->
					<div class="form-group">
						<label class="form-label">Response Types</label>
						{#if isEditing}
							<div class="checkbox-list">
								{#each [{ value: 'code', label: 'code' }, { value: 'token', label: 'token (Implicit)' }, { value: 'id_token', label: 'id_token' }, { value: 'id_token token', label: 'id_token token' }, { value: 'code id_token', label: 'code id_token' }] as responseType (responseType.value)}
									<label class="checkbox-list-item">
										<input
											type="checkbox"
											checked={editForm.response_types?.includes(responseType.value)}
											onchange={(e) => {
												const target = e.target as HTMLInputElement;
												if (target.checked) {
													editForm.response_types = [
														...(editForm.response_types || []),
														responseType.value
													];
												} else {
													editForm.response_types = (editForm.response_types || []).filter(
														(r) => r !== responseType.value
													);
												}
											}}
										/>
										{responseType.label}
									</label>
								{/each}
							</div>
						{:else}
							<p class="display-text">{client.response_types.join(', ') || '-'}</p>
						{/if}
					</div>

					<!-- Token Endpoint Auth Method -->
					<div class="form-group">
						<label class="form-label">Token Endpoint Auth Method</label>
						{#if isEditing}
							<select class="form-select" bind:value={editForm.token_endpoint_auth_method}>
								<option value="none">none (Public Client)</option>
								<option value="client_secret_basic">client_secret_basic</option>
								<option value="client_secret_post">client_secret_post</option>
								<option value="private_key_jwt">private_key_jwt</option>
							</select>
						{:else}
							<p class="display-text">{client.token_endpoint_auth_method || 'none'}</p>
						{/if}
					</div>

					<!-- PKCE Required -->
					<div class="form-group">
						{#if isEditing}
							<ToggleSwitch
								bind:checked={editForm.require_pkce}
								label="PKCE Required"
								description="Require PKCE for authorization requests"
							/>
						{:else}
							<label class="form-label">PKCE Required</label>
							<p class="display-text">{client.require_pkce ? 'Yes' : 'No'}</p>
						{/if}
					</div>
				</div>
			</section>

			<!-- Redirect URIs -->
			<section class="section-spacing">
				<h2 class="section-title-border">Redirect URIs</h2>
				{#if isEditing}
					<div style="display: flex; flex-direction: column; gap: 8px;">
						{#each editForm.redirect_uris || [] as uri, index (index)}
							<div class="input-copy-group">
								<input
									type="url"
									class="form-input"
									value={uri}
									oninput={(e) => {
										const target = e.target as HTMLInputElement;
										const newUris = [...(editForm.redirect_uris || [])];
										newUris[index] = target.value;
										editForm.redirect_uris = newUris;
									}}
									placeholder="https://example.com/callback"
								/>
								<button
									type="button"
									class="btn btn-danger btn-sm"
									onclick={() => {
										editForm.redirect_uris = (editForm.redirect_uris || []).filter(
											(_, i) => i !== index
										);
									}}
								>
									Remove
								</button>
							</div>
						{/each}
						<button
							type="button"
							class="btn-add"
							onclick={() => {
								editForm.redirect_uris = [...(editForm.redirect_uris || []), ''];
							}}
						>
							+ Add Redirect URI
						</button>
					</div>
				{:else if client.redirect_uris.length > 0}
					<ul class="uri-list">
						{#each client.redirect_uris as uri (uri)}
							<li class="uri-item">{uri}</li>
						{/each}
					</ul>
				{:else}
					<p class="display-text muted">No redirect URIs configured</p>
				{/if}
			</section>

			<!-- Timestamps -->
			<section>
				<h2 class="section-title-border">Timestamps</h2>
				<div class="info-grid">
					<div class="info-item">
						<dt>Created</dt>
						<dd class="info-value">{formatDate(client.created_at)}</dd>
					</div>
					<div class="info-item">
						<dt>Updated</dt>
						<dd class="info-value">{formatDate(client.updated_at)}</dd>
					</div>
				</div>
			</section>

			<!-- Edit Actions -->
			{#if isEditing}
				<div class="edit-actions">
					<button class="btn btn-secondary" onclick={cancelEditing}>Cancel</button>
					<button class="btn btn-primary" onclick={saveChanges} disabled={saving}>
						{saving ? 'Saving...' : 'Save Changes'}
					</button>
				</div>
			{/if}
		</div>
	{/if}
</div>

<!-- Delete Confirmation Modal -->
{#if showDeleteModal && client}
	<div
		class="modal-overlay"
		onclick={() => {
			showDeleteModal = false;
			deleteConfirmName = '';
		}}
		onkeydown={(e) => e.key === 'Escape' && (showDeleteModal = false)}
		role="dialog"
		aria-modal="true"
		tabindex="-1"
	>
		<div
			class="modal-content"
			onclick={(e) => e.stopPropagation()}
			onkeydown={(e) => e.stopPropagation()}
			role="document"
		>
			<div class="modal-header">
				<h3 class="modal-title" style="color: var(--danger);">⚠️ Delete Client</h3>
			</div>

			<div class="modal-body">
				<div class="danger-box">
					<p class="danger-box-title">This action CANNOT be undone.</p>
					<ul>
						<li>All tokens issued to this client will be invalidated immediately</li>
						<li>Historical audit data for this client will become orphaned</li>
					</ul>
				</div>

				<p class="modal-description">
					Type <strong>{client.client_name}</strong> to confirm:
				</p>
				<input
					type="text"
					class="confirm-input"
					bind:value={deleteConfirmName}
					placeholder="Enter client name"
				/>
			</div>

			<div class="modal-footer">
				<button
					class="btn btn-secondary"
					onclick={() => {
						showDeleteModal = false;
						deleteConfirmName = '';
					}}
				>
					Cancel
				</button>
				<button
					class="btn btn-danger"
					onclick={handleDelete}
					disabled={deleting || deleteConfirmName !== client.client_name}
				>
					{deleting ? 'Deleting...' : 'Delete Client'}
				</button>
			</div>
		</div>
	</div>
{/if}

<!-- Regenerate Secret Modal -->
{#if showRegenerateModal}
	<div
		class="modal-overlay"
		onclick={() => {
			showRegenerateModal = false;
			newSecret = null;
		}}
		onkeydown={(e) => e.key === 'Escape' && (showRegenerateModal = false)}
		role="dialog"
		aria-modal="true"
		tabindex="-1"
	>
		<div
			class="modal-content"
			onclick={(e) => e.stopPropagation()}
			onkeydown={(e) => e.stopPropagation()}
			role="document"
		>
			{#if newSecret}
				<!-- Success: Show new secret -->
				<div class="modal-header">
					<h3 class="modal-title" style="color: var(--success);">✅ Secret Regenerated</h3>
				</div>

				<div class="modal-body">
					<div class="warning-box">
						<p>⚠️ <strong>Save this secret now!</strong> It will not be shown again.</p>
					</div>

					<div class="form-group">
						<label class="form-label">New Client Secret</label>
						<div class="input-copy-group">
							<input type="text" value={newSecret} readonly class="input-readonly" />
							<button
								class="btn-copy"
								class:copied={copiedField === 'new_secret'}
								onclick={() => copyToClipboard(newSecret!, 'new_secret')}
							>
								{copiedField === 'new_secret' ? '✓ Copied' : 'Copy'}
							</button>
						</div>
					</div>
				</div>

				<div class="modal-footer">
					<button
						class="btn btn-primary"
						onclick={() => {
							showRegenerateModal = false;
							newSecret = null;
						}}
					>
						Done
					</button>
				</div>
			{:else}
				<!-- Confirmation -->
				<div class="modal-header">
					<h3 class="modal-title" style="color: var(--warning);">🔄 Regenerate Client Secret</h3>
				</div>

				<div class="modal-body">
					<div class="warning-box">
						<p>
							This will <strong>invalidate</strong> the current client secret. All applications using
							the old secret will stop working immediately.
						</p>
					</div>

					<p class="modal-description">
						The new secret will only be shown once. Make sure to update your applications after
						regenerating.
					</p>
				</div>

				<div class="modal-footer">
					<button class="btn btn-secondary" onclick={() => (showRegenerateModal = false)}>
						Cancel
					</button>
					<button class="btn btn-warning" onclick={handleRegenerateSecret} disabled={regenerating}>
						{regenerating ? 'Regenerating...' : 'Regenerate Secret'}
					</button>
				</div>
			{/if}
		</div>
	</div>
{/if}
