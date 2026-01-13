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

<div style="max-width: 900px;">
	<div style="margin-bottom: 24px;">
		<a href="/admin/clients" style="color: #6b7280; text-decoration: none; font-size: 14px;">
			← Back to Clients
		</a>
	</div>

	{#if loading}
		<p style="color: #6b7280; text-align: center; padding: 40px;">Loading client...</p>
	{:else if error}
		<div style="background-color: #fee2e2; border: 1px solid #ef4444; color: #b91c1c; padding: 12px; border-radius: 6px;">
			{error}
		</div>
	{:else if client}
		<!-- Header -->
		<div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 24px;">
			<div>
				<h1 style="font-size: 24px; font-weight: bold; color: #1f2937; margin: 0 0 4px 0;">
					{client.client_name}
				</h1>
				<p style="color: #6b7280; font-size: 14px; font-family: monospace; margin: 0;">
					{client.client_id}
				</p>
			</div>
			<div style="display: flex; gap: 8px;">
				{#if !isEditing}
					<button
						onclick={startEditing}
						style="
							padding: 8px 16px;
							border: 1px solid #d1d5db;
							border-radius: 6px;
							background-color: white;
							color: #374151;
							cursor: pointer;
							font-size: 14px;
						"
					>
						Edit
					</button>
				{/if}
				<button
					onclick={() => showDeleteModal = true}
					style="
						padding: 8px 16px;
						border: 1px solid #ef4444;
						border-radius: 6px;
						background-color: white;
						color: #ef4444;
						cursor: pointer;
						font-size: 14px;
					"
				>
					Delete
				</button>
			</div>
		</div>

		<!-- Usage Statistics -->
		{#if usage}
			<div style="background-color: white; border-radius: 8px; padding: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); margin-bottom: 16px;">
				<h2 style="font-size: 16px; font-weight: 600; color: #1f2937; margin: 0 0 16px 0;">Usage Statistics</h2>
				<div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px;">
					<div style="text-align: center;">
						<div style="font-size: 24px; font-weight: bold; color: #1f2937;">{formatNumber(usage.tokens_issued_24h)}</div>
						<div style="font-size: 12px; color: #6b7280;">Tokens (24h)</div>
					</div>
					<div style="text-align: center;">
						<div style="font-size: 24px; font-weight: bold; color: #1f2937;">{formatNumber(usage.tokens_issued_7d)}</div>
						<div style="font-size: 12px; color: #6b7280;">Tokens (7d)</div>
					</div>
					<div style="text-align: center;">
						<div style="font-size: 24px; font-weight: bold; color: #1f2937;">{formatNumber(usage.tokens_issued_30d)}</div>
						<div style="font-size: 12px; color: #6b7280;">Tokens (30d)</div>
					</div>
					<div style="text-align: center;">
						<div style="font-size: 24px; font-weight: bold; color: #1f2937;">{formatNumber(usage.active_sessions)}</div>
						<div style="font-size: 12px; color: #6b7280;">Active Sessions</div>
					</div>
				</div>
				{#if usage.last_token_issued_at}
					<p style="color: #6b7280; font-size: 12px; margin: 16px 0 0 0; text-align: center;">
						Last token issued: {formatDate(usage.last_token_issued_at)}
					</p>
				{/if}
			</div>
		{/if}

		<!-- Client Details -->
		<div style="background-color: white; border-radius: 8px; padding: 24px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); margin-bottom: 16px;">
			{#if saveError}
				<div style="background-color: #fee2e2; border: 1px solid #ef4444; color: #b91c1c; padding: 12px; border-radius: 6px; margin-bottom: 16px;">
					{saveError}
				</div>
			{/if}

			<!-- Basic Info -->
			<section style="margin-bottom: 24px;">
				<h2 style="font-size: 16px; font-weight: 600; color: #1f2937; margin: 0 0 16px 0; padding-bottom: 8px; border-bottom: 1px solid #e5e7eb;">
					Basic Information
				</h2>

				<div style="display: grid; gap: 16px;">
					<!-- Client ID -->
					<div>
						<label style="display: block; font-size: 12px; font-weight: 500; color: #6b7280; margin-bottom: 4px;">
							Client ID
						</label>
						<div style="display: flex; gap: 8px;">
							<input
								type="text"
								value={client.client_id}
								readonly
								style="
									flex: 1;
									padding: 8px 12px;
									border: 1px solid #e5e7eb;
									border-radius: 6px;
									font-size: 14px;
									font-family: monospace;
									background-color: #f9fafb;
									color: #1f2937;
								"
							/>
							<button
								onclick={() => copyToClipboard(client!.client_id, 'client_id')}
								style="
									padding: 8px 12px;
									border: 1px solid {copiedField === 'client_id' ? '#10b981' : '#d1d5db'};
									border-radius: 6px;
									background-color: {copiedField === 'client_id' ? '#d1fae5' : 'white'};
									color: {copiedField === 'client_id' ? '#059669' : '#374151'};
									cursor: pointer;
									font-size: 13px;
									min-width: 70px;
									transition: all 0.2s ease;
								"
							>
								{copiedField === 'client_id' ? '✓ Copied' : 'Copy'}
							</button>
						</div>
					</div>

					<!-- Client Name -->
					<div>
						<label style="display: block; font-size: 12px; font-weight: 500; color: #6b7280; margin-bottom: 4px;">
							Client Name
						</label>
						{#if isEditing}
							<input
								type="text"
								bind:value={editForm.client_name}
								style="
									width: 100%;
									padding: 8px 12px;
									border: 1px solid #d1d5db;
									border-radius: 6px;
									font-size: 14px;
									box-sizing: border-box;
								"
							/>
						{:else}
							<p style="margin: 0; padding: 8px 0; font-size: 14px; color: #1f2937;">
								{client.client_name}
							</p>
						{/if}
					</div>

					<!-- Client Secret -->
					<div>
						<label style="display: block; font-size: 12px; font-weight: 500; color: #6b7280; margin-bottom: 4px;">
							Client Secret
						</label>
						<div style="display: flex; gap: 8px; align-items: center;">
							<input
								type="text"
								value={client.client_secret ? `••••••••${client.client_secret.slice(-4)}` : '••••••••••••'}
								readonly
								style="
									flex: 1;
									padding: 8px 12px;
									border: 1px solid #e5e7eb;
									border-radius: 6px;
									font-size: 14px;
									font-family: monospace;
									background-color: #f9fafb;
									color: #1f2937;
								"
							/>
							<button
								onclick={() => showRegenerateModal = true}
								style="
									padding: 8px 12px;
									border: 1px solid #f59e0b;
									border-radius: 6px;
									background-color: #fef3c7;
									color: #92400e;
									cursor: pointer;
									font-size: 13px;
								"
							>
								Regenerate
							</button>
						</div>
						<p style="margin: 4px 0 0 0; font-size: 11px; color: #9ca3af;">
							Secret is only fully visible when created or regenerated
						</p>
					</div>
				</div>
			</section>

			<!-- OAuth Settings -->
			<section style="margin-bottom: 24px;">
				<h2 style="font-size: 16px; font-weight: 600; color: #1f2937; margin: 0 0 16px 0; padding-bottom: 8px; border-bottom: 1px solid #e5e7eb;">
					OAuth Settings
				</h2>

				<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px;">
					<!-- Grant Types -->
					<div>
						<label style="display: block; font-size: 12px; font-weight: 500; color: #6b7280; margin-bottom: 4px;">
							Grant Types
						</label>
						{#if isEditing}
							<div style="display: flex; flex-direction: column; gap: 6px; padding: 8px 0;">
								{#each [
									{ value: 'authorization_code', label: 'Authorization Code' },
									{ value: 'refresh_token', label: 'Refresh Token' },
									{ value: 'client_credentials', label: 'Client Credentials' },
									{ value: 'implicit', label: 'Implicit (Legacy)' },
									{ value: 'urn:ietf:params:oauth:grant-type:device_code', label: 'Device Code' }
								] as grantType (grantType.value)}
									<label style="display: flex; align-items: center; gap: 8px; font-size: 14px; color: #1f2937; cursor: pointer;">
										<input
											type="checkbox"
											checked={editForm.grant_types?.includes(grantType.value)}
											onchange={(e) => {
												const target = e.target as HTMLInputElement;
												if (target.checked) {
													editForm.grant_types = [...(editForm.grant_types || []), grantType.value];
												} else {
													editForm.grant_types = (editForm.grant_types || []).filter(g => g !== grantType.value);
												}
											}}
											style="width: 16px; height: 16px;"
										/>
										{grantType.label}
									</label>
								{/each}
							</div>
						{:else}
							<p style="margin: 0; padding: 8px 0; font-size: 14px; color: #1f2937;">
								{client.grant_types.join(', ') || '-'}
							</p>
						{/if}
					</div>

					<!-- Response Types -->
					<div>
						<label style="display: block; font-size: 12px; font-weight: 500; color: #6b7280; margin-bottom: 4px;">
							Response Types
						</label>
						{#if isEditing}
							<div style="display: flex; flex-direction: column; gap: 6px; padding: 8px 0;">
								{#each [
									{ value: 'code', label: 'code' },
									{ value: 'token', label: 'token (Implicit)' },
									{ value: 'id_token', label: 'id_token' },
									{ value: 'id_token token', label: 'id_token token' },
									{ value: 'code id_token', label: 'code id_token' }
								] as responseType (responseType.value)}
									<label style="display: flex; align-items: center; gap: 8px; font-size: 14px; color: #1f2937; cursor: pointer;">
										<input
											type="checkbox"
											checked={editForm.response_types?.includes(responseType.value)}
											onchange={(e) => {
												const target = e.target as HTMLInputElement;
												if (target.checked) {
													editForm.response_types = [...(editForm.response_types || []), responseType.value];
												} else {
													editForm.response_types = (editForm.response_types || []).filter(r => r !== responseType.value);
												}
											}}
											style="width: 16px; height: 16px;"
										/>
										{responseType.label}
									</label>
								{/each}
							</div>
						{:else}
							<p style="margin: 0; padding: 8px 0; font-size: 14px; color: #1f2937;">
								{client.response_types.join(', ') || '-'}
							</p>
						{/if}
					</div>

					<!-- Token Endpoint Auth Method -->
					<div>
						<label style="display: block; font-size: 12px; font-weight: 500; color: #6b7280; margin-bottom: 4px;">
							Token Endpoint Auth Method
						</label>
						{#if isEditing}
							<select
								bind:value={editForm.token_endpoint_auth_method}
								style="
									width: 100%;
									padding: 8px 12px;
									border: 1px solid #d1d5db;
									border-radius: 6px;
									font-size: 14px;
									background-color: white;
									color: #1f2937;
								"
							>
								<option value="none">none (Public Client)</option>
								<option value="client_secret_basic">client_secret_basic</option>
								<option value="client_secret_post">client_secret_post</option>
								<option value="private_key_jwt">private_key_jwt</option>
							</select>
						{:else}
							<p style="margin: 0; padding: 8px 0; font-size: 14px; color: #1f2937;">
								{client.token_endpoint_auth_method || 'none'}
							</p>
						{/if}
					</div>

					<!-- PKCE Required -->
					<div>
						<label style="display: block; font-size: 12px; font-weight: 500; color: #6b7280; margin-bottom: 4px;">
							PKCE Required
						</label>
						{#if isEditing}
							<label style="display: flex; align-items: center; gap: 8px; padding: 8px 0; font-size: 14px; color: #1f2937; cursor: pointer;">
								<input
									type="checkbox"
									bind:checked={editForm.require_pkce}
									style="width: 16px; height: 16px;"
								/>
								Require PKCE for authorization requests
							</label>
						{:else}
							<p style="margin: 0; padding: 8px 0; font-size: 14px; color: #1f2937;">
								{client.require_pkce ? 'Yes' : 'No'}
							</p>
						{/if}
					</div>
				</div>
			</section>

			<!-- Redirect URIs -->
			<section style="margin-bottom: 24px;">
				<h2 style="font-size: 16px; font-weight: 600; color: #1f2937; margin: 0 0 16px 0; padding-bottom: 8px; border-bottom: 1px solid #e5e7eb;">
					Redirect URIs
				</h2>
				{#if isEditing}
					<div style="display: flex; flex-direction: column; gap: 8px;">
						{#each editForm.redirect_uris || [] as uri, index (index)}
							<div style="display: flex; gap: 8px; align-items: center;">
								<input
									type="url"
									value={uri}
									oninput={(e) => {
										const target = e.target as HTMLInputElement;
										const newUris = [...(editForm.redirect_uris || [])];
										newUris[index] = target.value;
										editForm.redirect_uris = newUris;
									}}
									placeholder="https://example.com/callback"
									style="
										flex: 1;
										padding: 8px 12px;
										border: 1px solid #d1d5db;
										border-radius: 6px;
										font-size: 14px;
										font-family: monospace;
										color: #1f2937;
									"
								/>
								<button
									type="button"
									onclick={() => {
										editForm.redirect_uris = (editForm.redirect_uris || []).filter((_, i) => i !== index);
									}}
									style="
										padding: 8px 12px;
										border: 1px solid #ef4444;
										border-radius: 6px;
										background-color: white;
										color: #ef4444;
										cursor: pointer;
										font-size: 14px;
									"
								>
									Remove
								</button>
							</div>
						{/each}
						<button
							type="button"
							onclick={() => {
								editForm.redirect_uris = [...(editForm.redirect_uris || []), ''];
							}}
							style="
								padding: 8px 16px;
								border: 1px dashed #d1d5db;
								border-radius: 6px;
								background-color: #f9fafb;
								color: #6b7280;
								cursor: pointer;
								font-size: 14px;
								text-align: center;
							"
						>
							+ Add Redirect URI
						</button>
					</div>
				{:else if client.redirect_uris.length > 0}
					<ul style="margin: 0; padding: 0; list-style: none;">
						{#each client.redirect_uris as uri (uri)}
							<li style="padding: 8px 12px; background-color: #f9fafb; border-radius: 4px; margin-bottom: 8px; font-size: 14px; font-family: monospace; color: #1f2937;">
								{uri}
							</li>
						{/each}
					</ul>
				{:else}
					<p style="color: #6b7280; font-size: 14px; margin: 0;">No redirect URIs configured</p>
				{/if}
			</section>

			<!-- Timestamps -->
			<section>
				<h2 style="font-size: 16px; font-weight: 600; color: #1f2937; margin: 0 0 16px 0; padding-bottom: 8px; border-bottom: 1px solid #e5e7eb;">
					Timestamps
				</h2>
				<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px;">
					<div>
						<label style="display: block; font-size: 12px; font-weight: 500; color: #6b7280; margin-bottom: 4px;">
							Created
						</label>
						<p style="margin: 0; padding: 8px 0; font-size: 14px; color: #1f2937;">
							{formatDate(client.created_at)}
						</p>
					</div>
					<div>
						<label style="display: block; font-size: 12px; font-weight: 500; color: #6b7280; margin-bottom: 4px;">
							Updated
						</label>
						<p style="margin: 0; padding: 8px 0; font-size: 14px; color: #1f2937;">
							{formatDate(client.updated_at)}
						</p>
					</div>
				</div>
			</section>

			<!-- Edit Actions -->
			{#if isEditing}
				<div style="display: flex; justify-content: flex-end; gap: 12px; padding-top: 24px; border-top: 1px solid #e5e7eb; margin-top: 24px;">
					<button
						onclick={cancelEditing}
						style="
							padding: 10px 20px;
							border: 1px solid #d1d5db;
							border-radius: 6px;
							background-color: white;
							color: #374151;
							cursor: pointer;
							font-size: 14px;
						"
					>
						Cancel
					</button>
					<button
						onclick={saveChanges}
						disabled={saving}
						style="
							padding: 10px 20px;
							border: none;
							border-radius: 6px;
							background-color: {saving ? '#9ca3af' : '#3b82f6'};
							color: white;
							cursor: {saving ? 'not-allowed' : 'pointer'};
							font-size: 14px;
							font-weight: 500;
						"
					>
						{saving ? 'Saving...' : 'Save Changes'}
					</button>
				</div>
			{/if}
		</div>
	{/if}
</div>

<!-- Delete Confirmation Modal -->
{#if showDeleteModal && client}
	<div style="position: fixed; inset: 0; background-color: rgba(0,0,0,0.5); display: flex; justify-content: center; align-items: center; z-index: 50;">
		<div style="background-color: white; border-radius: 12px; padding: 24px; max-width: 480px; width: 90%; box-shadow: 0 25px 50px -12px rgba(0,0,0,0.25);">
			<h3 style="font-size: 18px; font-weight: 600; color: #b91c1c; margin: 0 0 16px 0;">
				⚠️ Delete Client
			</h3>

			<div style="background-color: #fee2e2; border: 1px solid #fecaca; border-radius: 6px; padding: 12px; margin-bottom: 16px;">
				<p style="color: #b91c1c; font-size: 14px; margin: 0 0 8px 0; font-weight: 500;">
					This action CANNOT be undone.
				</p>
				<ul style="color: #b91c1c; font-size: 13px; margin: 0; padding-left: 20px;">
					<li>All tokens issued to this client will be invalidated immediately</li>
					<li>Historical audit data for this client will become orphaned</li>
				</ul>
			</div>

			<p style="color: #374151; font-size: 14px; margin: 0 0 8px 0;">
				Type <strong>{client.client_name}</strong> to confirm:
			</p>
			<input
				type="text"
				bind:value={deleteConfirmName}
				placeholder="Enter client name"
				style="
					width: 100%;
					padding: 10px 12px;
					border: 1px solid #d1d5db;
					border-radius: 6px;
					font-size: 14px;
					margin-bottom: 16px;
					box-sizing: border-box;
				"
			/>

			<div style="display: flex; justify-content: flex-end; gap: 12px;">
				<button
					onclick={() => { showDeleteModal = false; deleteConfirmName = ''; }}
					style="
						padding: 10px 20px;
						border: 1px solid #d1d5db;
						border-radius: 6px;
						background-color: white;
						color: #374151;
						cursor: pointer;
						font-size: 14px;
					"
				>
					Cancel
				</button>
				<button
					onclick={handleDelete}
					disabled={deleting || deleteConfirmName !== client.client_name}
					style="
						padding: 10px 20px;
						border: none;
						border-radius: 6px;
						background-color: {deleting || deleteConfirmName !== client.client_name ? '#fca5a5' : '#ef4444'};
						color: white;
						cursor: {deleting || deleteConfirmName !== client.client_name ? 'not-allowed' : 'pointer'};
						font-size: 14px;
						font-weight: 500;
					"
				>
					{deleting ? 'Deleting...' : 'Delete Client'}
				</button>
			</div>
		</div>
	</div>
{/if}

<!-- Regenerate Secret Modal -->
{#if showRegenerateModal}
	<div style="position: fixed; inset: 0; background-color: rgba(0,0,0,0.5); display: flex; justify-content: center; align-items: center; z-index: 50;">
		<div style="background-color: white; border-radius: 12px; padding: 24px; max-width: 520px; width: 90%; box-shadow: 0 25px 50px -12px rgba(0,0,0,0.25);">
			{#if newSecret}
				<!-- Success: Show new secret -->
				<h3 style="font-size: 18px; font-weight: 600; color: #059669; margin: 0 0 16px 0;">
					✅ Secret Regenerated
				</h3>

				<div style="background-color: #fef3c7; border: 1px solid #f59e0b; border-radius: 6px; padding: 12px; margin-bottom: 16px;">
					<p style="color: #92400e; font-size: 13px; margin: 0;">
						⚠️ <strong>Save this secret now!</strong> It will not be shown again.
					</p>
				</div>

				<div style="margin-bottom: 16px;">
					<label style="display: block; font-size: 12px; font-weight: 500; color: #6b7280; margin-bottom: 4px;">
						New Client Secret
					</label>
					<div style="display: flex; gap: 8px;">
						<input
							type="text"
							value={newSecret}
							readonly
							style="
								flex: 1;
								padding: 10px 12px;
								border: 1px solid #d1d5db;
								border-radius: 6px;
								font-size: 14px;
								font-family: monospace;
								background-color: #f9fafb;
								color: #1f2937;
							"
						/>
						<button
							onclick={() => copyToClipboard(newSecret!, 'new_secret')}
							style="
								padding: 10px 16px;
								border: 1px solid {copiedField === 'new_secret' ? '#10b981' : '#d1d5db'};
								border-radius: 6px;
								background-color: {copiedField === 'new_secret' ? '#d1fae5' : 'white'};
								color: {copiedField === 'new_secret' ? '#059669' : '#374151'};
								cursor: pointer;
								font-size: 14px;
								min-width: 80px;
								transition: all 0.2s ease;
							"
						>
							{copiedField === 'new_secret' ? '✓ Copied' : 'Copy'}
						</button>
					</div>
				</div>

				<div style="display: flex; justify-content: flex-end;">
					<button
						onclick={() => { showRegenerateModal = false; newSecret = null; }}
						style="
							padding: 10px 20px;
							border: none;
							border-radius: 6px;
							background-color: #3b82f6;
							color: white;
							cursor: pointer;
							font-size: 14px;
							font-weight: 500;
						"
					>
						Done
					</button>
				</div>
			{:else}
				<!-- Confirmation -->
				<h3 style="font-size: 18px; font-weight: 600; color: #92400e; margin: 0 0 16px 0;">
					🔄 Regenerate Client Secret
				</h3>

				<div style="background-color: #fef3c7; border: 1px solid #f59e0b; border-radius: 6px; padding: 12px; margin-bottom: 16px;">
					<p style="color: #92400e; font-size: 14px; margin: 0;">
						This will <strong>invalidate</strong> the current client secret. All applications using the old secret will stop working immediately.
					</p>
				</div>

				<p style="color: #374151; font-size: 14px; margin: 0 0 16px 0;">
					The new secret will only be shown once. Make sure to update your applications after regenerating.
				</p>

				<div style="display: flex; justify-content: flex-end; gap: 12px;">
					<button
						onclick={() => showRegenerateModal = false}
						style="
							padding: 10px 20px;
							border: 1px solid #d1d5db;
							border-radius: 6px;
							background-color: white;
							color: #374151;
							cursor: pointer;
							font-size: 14px;
						"
					>
						Cancel
					</button>
					<button
						onclick={handleRegenerateSecret}
						disabled={regenerating}
						style="
							padding: 10px 20px;
							border: none;
							border-radius: 6px;
							background-color: {regenerating ? '#fcd34d' : '#f59e0b'};
							color: white;
							cursor: {regenerating ? 'not-allowed' : 'pointer'};
							font-size: 14px;
							font-weight: 500;
						"
					>
						{regenerating ? 'Regenerating...' : 'Regenerate Secret'}
					</button>
				</div>
			{/if}
		</div>
	</div>
{/if}
