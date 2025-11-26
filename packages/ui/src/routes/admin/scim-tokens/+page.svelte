<script lang="ts">
	import { onMount } from 'svelte';
	import { adminScimTokensAPI } from '$lib/api/client';
	import Button from '$lib/components/Button.svelte';
	import Card from '$lib/components/Card.svelte';
	import Alert from '$lib/components/Alert.svelte';
	import Dialog from '$lib/components/Dialog.svelte';
	import Input from '$lib/components/Input.svelte';
	import Spinner from '$lib/components/Spinner.svelte';

	interface ScimToken {
		tokenHash: string;
		description: string;
		createdAt: string;
		expiresAt: string | null;
		enabled: boolean;
	}

	let tokens: ScimToken[] = [];
	let loading = true;
	let error = '';
	let successMessage = '';

	// Create token dialog
	let showCreateDialog = false;
	let newTokenDescription = '';
	let newTokenExpiresInDays = 365;
	let createdToken = '';
	let showTokenDialog = false;

	// Delete confirmation
	let showDeleteDialog = false;
	let tokenToDelete: ScimToken | null = null;

	onMount(async () => {
		await loadTokens();
	});

	async function loadTokens() {
		loading = true;
		error = '';

		const result = await adminScimTokensAPI.list();

		if (result.error) {
			error = result.error.error_description || 'Failed to load SCIM tokens';
		} else if (result.data) {
			tokens = result.data.tokens;
		}

		loading = false;
	}

	async function createToken() {
		error = '';
		successMessage = '';

		const result = await adminScimTokensAPI.create(
			newTokenDescription || 'SCIM provisioning token',
			newTokenExpiresInDays
		);

		if (result.error) {
			error = result.error.error_description || 'Failed to create token';
		} else if (result.data) {
			createdToken = result.data.token;
			showCreateDialog = false;
			showTokenDialog = true;
			newTokenDescription = '';
			newTokenExpiresInDays = 365;
			await loadTokens();
		}
	}

	async function revokeToken(tokenHash: string) {
		error = '';
		successMessage = '';

		const result = await adminScimTokensAPI.revoke(tokenHash);

		if (result.error) {
			error = result.error.error_description || 'Failed to revoke token';
		} else {
			successMessage = 'Token revoked successfully';
			showDeleteDialog = false;
			tokenToDelete = null;
			await loadTokens();
		}
	}

	function copyToClipboard(text: string) {
		navigator.clipboard.writeText(text);
		successMessage = 'Token copied to clipboard';
		setTimeout(() => {
			successMessage = '';
		}, 3000);
	}

	function formatDate(dateString: string) {
		return new Date(dateString).toLocaleString();
	}

	function isExpired(expiresAt: string | null): boolean {
		if (!expiresAt) return false;
		return new Date(expiresAt) < new Date();
	}
</script>

<svelte:head>
	<title>SCIM Tokens - Authrim Admin</title>
</svelte:head>

<div class="container mx-auto px-4 py-8">
	<div class="mb-6 flex items-center justify-between">
		<div>
			<h1 class="text-3xl font-bold text-gray-900 dark:text-white">SCIM Tokens</h1>
			<p class="mt-2 text-gray-600 dark:text-gray-400">Manage SCIM 2.0 provisioning tokens for user synchronization</p>
		</div>
		<Button onclick={() => (showCreateDialog = true)}>
			<svg class="mr-2 h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
				<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
			</svg>
			Create Token
		</Button>
	</div>

	{#if error}
		<Alert variant="error" class="mb-4">{error}</Alert>
	{/if}

	{#if successMessage}
		<Alert variant="success" class="mb-4">{successMessage}</Alert>
	{/if}

	<Card>
		<div class="overflow-x-auto">
			{#if loading}
				<div class="flex items-center justify-center py-12">
					<Spinner />
				</div>
			{:else if tokens.length === 0}
				<div class="py-12 text-center">
					<svg
						class="mx-auto h-12 w-12 text-gray-400"
						fill="none"
						stroke="currentColor"
						viewBox="0 0 24 24"
					>
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width="2"
							d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z"
						/>
					</svg>
					<h3 class="mt-2 text-sm font-medium text-gray-900 dark:text-white">No SCIM tokens</h3>
					<p class="mt-1 text-sm text-gray-500 dark:text-gray-400">Get started by creating a new SCIM token.</p>
					<div class="mt-6">
						<Button onclick={() => (showCreateDialog = true)}>Create Token</Button>
					</div>
				</div>
			{:else}
				<table class="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
					<thead class="bg-gray-50 dark:bg-gray-800">
						<tr>
							<th class="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
								Description
							</th>
							<th class="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
								Token Hash
							</th>
							<th class="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
								Created
							</th>
							<th class="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
								Expires
							</th>
							<th class="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
								Status
							</th>
							<th class="px-6 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
								Actions
							</th>
						</tr>
					</thead>
					<tbody class="divide-y divide-gray-200 dark:divide-gray-700 bg-white dark:bg-gray-900">
						{#each tokens as token (token.tokenHash)}
							<tr class="hover:bg-gray-50 dark:hover:bg-gray-800">
								<td class="whitespace-nowrap px-6 py-4">
									<div class="text-sm font-medium text-gray-900 dark:text-white">{token.description}</div>
								</td>
								<td class="whitespace-nowrap px-6 py-4">
									<div class="font-mono text-xs text-gray-500 dark:text-gray-400">
										{token.tokenHash.substring(0, 16)}...
									</div>
								</td>
								<td class="whitespace-nowrap px-6 py-4 text-sm text-gray-500 dark:text-gray-400">
									{formatDate(token.createdAt)}
								</td>
								<td class="whitespace-nowrap px-6 py-4 text-sm text-gray-500 dark:text-gray-400">
									{#if token.expiresAt}
										{formatDate(token.expiresAt)}
									{:else}
										Never
									{/if}
								</td>
								<td class="whitespace-nowrap px-6 py-4">
									{#if !token.enabled}
										<span class="inline-flex rounded-full bg-gray-100 dark:bg-gray-700 px-2 text-xs font-semibold leading-5 text-gray-800 dark:text-gray-300">
											Disabled
										</span>
									{:else if isExpired(token.expiresAt)}
										<span class="inline-flex rounded-full bg-red-100 dark:bg-red-900 px-2 text-xs font-semibold leading-5 text-red-800 dark:text-red-200">
											Expired
										</span>
									{:else}
										<span class="inline-flex rounded-full bg-green-100 dark:bg-green-900 px-2 text-xs font-semibold leading-5 text-green-800 dark:text-green-200">
											Active
										</span>
									{/if}
								</td>
								<td class="whitespace-nowrap px-6 py-4 text-right text-sm font-medium">
									<Button
										variant="danger"
										size="sm"
										onclick={() => {
											tokenToDelete = token;
											showDeleteDialog = true;
										}}
									>
										Revoke
									</Button>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			{/if}
		</div>
	</Card>

	<!-- SCIM Documentation Card -->
	<Card class="mt-6">
		<h2 class="text-lg font-semibold mb-4 dark:text-white">SCIM 2.0 Endpoints</h2>
		<div class="space-y-3 text-sm">
			<div>
				<p class="font-medium mb-2 dark:text-gray-200">Base URL:</p>
				<code class="block bg-gray-50 dark:bg-gray-800 px-3 py-2 rounded text-gray-900 dark:text-gray-100">{window.location.origin}/scim/v2</code>
			</div>
			<div>
				<p class="font-medium mb-2 dark:text-gray-200">Available endpoints:</p>
				<ul class="list-disc list-inside space-y-1 text-gray-600 dark:text-gray-400">
					<li>GET /scim/v2/Users - List users (with filtering and pagination)</li>
					<li>GET /scim/v2/Users/{'{id}'} - Get user by ID</li>
					<li>POST /scim/v2/Users - Create user</li>
					<li>PUT /scim/v2/Users/{'{id}'} - Replace user</li>
					<li>PATCH /scim/v2/Users/{'{id}'} - Update user</li>
					<li>DELETE /scim/v2/Users/{'{id}'} - Delete user</li>
					<li>GET /scim/v2/Groups - List groups</li>
					<li>GET /scim/v2/Groups/{'{id}'} - Get group by ID</li>
					<li>POST /scim/v2/Groups - Create group</li>
					<li>PUT /scim/v2/Groups/{'{id}'} - Replace group</li>
					<li>PATCH /scim/v2/Groups/{'{id}'} - Update group</li>
					<li>DELETE /scim/v2/Groups/{'{id}'} - Delete group</li>
				</ul>
			</div>
			<div>
				<p class="font-medium mb-2 dark:text-gray-200">Authentication:</p>
				<code class="block bg-gray-50 dark:bg-gray-800 px-3 py-2 rounded text-gray-900 dark:text-gray-100">Authorization: Bearer YOUR_TOKEN</code>
			</div>
		</div>
	</Card>
</div>

<!-- Create Token Dialog -->
<Dialog bind:open={showCreateDialog} title="Create SCIM Token">
	<div class="space-y-4">
		<div>
			<label for="description" class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
				Description
			</label>
			<Input
				id="description"
				bind:value={newTokenDescription}
				placeholder="SCIM provisioning token"
			/>
		</div>
		<div>
			<label for="expires" class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
				Expires in (days)
			</label>
			<Input id="expires" type="number" bind:value={newTokenExpiresInDays} min="1" max="3650" />
			<p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
				Set to 3650 (10 years) for long-lived tokens
			</p>
		</div>
	</div>
	<div slot="footer" class="flex justify-end space-x-3">
		<Button variant="secondary" onclick={() => (showCreateDialog = false)}>Cancel</Button>
		<Button onclick={createToken}>Create Token</Button>
	</div>
</Dialog>

<!-- Show Token Dialog -->
<Dialog bind:open={showTokenDialog} title="SCIM Token Created">
	<Alert variant="warning" class="mb-4">
		This token will only be shown once. Make sure to copy it now!
	</Alert>
	<div class="space-y-4">
		<div>
			<label for="created-token" class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Token</label>
			<div class="flex space-x-2">
				<Input id="created-token" value={createdToken} readonly class="flex-1 font-mono text-sm" />
				<Button variant="secondary" onclick={() => copyToClipboard(createdToken)}>
					Copy
				</Button>
			</div>
		</div>
		<div class="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4">
			<h4 class="font-medium text-blue-900 dark:text-blue-200 mb-2">Usage:</h4>
			<code class="block text-sm text-blue-800 dark:text-blue-300">
				curl -H "Authorization: Bearer {createdToken.substring(0, 20)}..." \\<br />
				&nbsp;&nbsp;{window.location.origin}/scim/v2/Users
			</code>
		</div>
	</div>
	<div slot="footer" class="flex justify-end">
		<Button onclick={() => { showTokenDialog = false; createdToken = ''; }}>
			Done
		</Button>
	</div>
</Dialog>

<!-- Delete Confirmation Dialog -->
<Dialog bind:open={showDeleteDialog} title="Revoke SCIM Token">
	{#if tokenToDelete}
		<p class="text-sm text-gray-600 dark:text-gray-400">
			Are you sure you want to revoke the token "{tokenToDelete.description}"?
			This action cannot be undone and will immediately invalidate the token.
		</p>
	{/if}
	<div slot="footer" class="flex justify-end space-x-3">
		<Button variant="secondary" onclick={() => { showDeleteDialog = false; tokenToDelete = null; }}>
			Cancel
		</Button>
		<Button
			variant="danger"
			onclick={() => tokenToDelete && revokeToken(tokenToDelete.tokenHash)}
		>
			Revoke Token
		</Button>
	</div>
</Dialog>
