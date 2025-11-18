<script lang="ts">
	import * as m from '$lib/paraglide/messages';
	import { Card, Button, Input } from '$lib/components';
	import { onMount } from 'svelte';
	import { page } from '$app/stores';

	interface Client {
		client_id: string;
		client_name: string;
		redirect_uris: string[];
		grant_types: string[];
		scope: string;
		logo_uri: string | null;
		client_uri: string | null;
		policy_uri: string | null;
		tos_uri: string | null;
		created_at: number;
		updated_at: number;
	}

	let clientId: string;
	let client: Client | null = null;
	let loading = true;
	let saving = false;
	let newRedirectUri = '';

	$: clientId = $page.params.id as string;

	const availableGrantTypes = [
		{ value: 'authorization_code', label: 'Authorization Code' },
		{ value: 'refresh_token', label: 'Refresh Token' },
		{ value: 'client_credentials', label: 'Client Credentials' }
	];

	onMount(async () => {
		await loadClient();
	});

	async function loadClient() {
		loading = true;
		// Simulate API call - would call GET /admin/clients/:id in real implementation
		await new Promise((resolve) => setTimeout(resolve, 500));

		// Mock data
		client = {
			client_id: clientId,
			client_name: 'My Application',
			redirect_uris: ['https://example.com/callback', 'https://example.com/auth/callback'],
			grant_types: ['authorization_code', 'refresh_token'],
			scope: 'openid profile email',
			logo_uri: 'https://example.com/logo.png',
			client_uri: 'https://example.com',
			policy_uri: 'https://example.com/privacy',
			tos_uri: 'https://example.com/terms',
			created_at: Date.now() - 86400000 * 30,
			updated_at: Date.now() - 86400000 * 5
		};

		loading = false;
	}

	async function handleSave() {
		if (!client) return;

		saving = true;
		// Simulate API call - would call PUT /admin/clients/:id in real implementation
		await new Promise((resolve) => setTimeout(resolve, 1000));
		saving = false;

		alert('Client updated successfully');
	}

	async function handleDelete() {
		if (!confirm(m.admin_client_detail_deleteClient() + '?')) return;

		// Simulate API call - would call DELETE /admin/clients/:id in real implementation
		await new Promise((resolve) => setTimeout(resolve, 500));

		window.location.href = '/admin/clients';
	}

	async function handleRegenerateSecret() {
		if (!confirm('Are you sure you want to regenerate the client secret? The old secret will be invalidated.')) return;

		// Simulate API call - would call POST /admin/clients/:id/regenerate-secret in real implementation
		await new Promise((resolve) => setTimeout(resolve, 500));

		alert('New secret generated: ********************\n\nMake sure to save this secret as it will not be shown again!');
	}

	function formatDate(timestamp: number): string {
		return new Date(timestamp).toLocaleString();
	}

	function addRedirectUri() {
		if (!client || !newRedirectUri.trim()) return;
		if (client.redirect_uris.includes(newRedirectUri.trim())) {
			alert('This URI is already in the list');
			return;
		}
		client.redirect_uris = [...client.redirect_uris, newRedirectUri.trim()];
		newRedirectUri = '';
	}

	function removeRedirectUri(uri: string) {
		if (!client) return;
		client.redirect_uris = client.redirect_uris.filter((u) => u !== uri);
	}

	function toggleGrantType(grantType: string) {
		if (!client) return;
		if (client.grant_types.includes(grantType)) {
			client.grant_types = client.grant_types.filter((g) => g !== grantType);
		} else {
			client.grant_types = [...client.grant_types, grantType];
		}
	}
</script>

<svelte:head>
	<title>{m.admin_client_detail_title()} - {m.app_title()}</title>
</svelte:head>

<div class="space-y-6">
	<!-- Page header -->
	<div class="flex items-center justify-between">
		<div>
			<a
				href="/admin/clients"
				class="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300"
			>
				<div class="i-heroicons-arrow-left h-4 w-4"></div>
				Back to clients
			</a>
			<h1 class="mt-2 text-3xl font-bold text-gray-900 dark:text-white">
				{m.admin_client_detail_title()}
			</h1>
		</div>
		<div class="flex gap-2">
			<Button variant="primary" onclick={handleSave} disabled={saving || loading}>
				{#if saving}
					<div class="i-heroicons-arrow-path h-4 w-4 animate-spin"></div>
				{/if}
				{m.admin_client_detail_save()}
			</Button>
			<Button variant="secondary" onclick={handleRegenerateSecret} disabled={loading}>
				{m.admin_client_detail_regenerateSecret()}
			</Button>
			<Button variant="secondary" onclick={handleDelete} disabled={loading}>
				{m.admin_client_detail_deleteClient()}
			</Button>
		</div>
	</div>

	{#if loading}
		<Card>
			<div class="space-y-4">
				<div class="h-6 w-32 animate-pulse rounded bg-gray-300 dark:bg-gray-700"></div>
				<!-- eslint-disable-next-line @typescript-eslint/no-unused-vars -->
				{#each Array(5) as _, i (i)}
					<div class="space-y-2">
						<div class="h-4 w-24 animate-pulse rounded bg-gray-300 dark:bg-gray-700"></div>
						<div class="h-10 w-full animate-pulse rounded bg-gray-300 dark:bg-gray-700"></div>
					</div>
				{/each}
			</div>
		</Card>
	{:else if client}
		<!-- Basic Information -->
		<Card>
			<h2 class="mb-4 text-lg font-semibold text-gray-900 dark:text-white">
				{m.admin_client_detail_basicInfo()}
			</h2>
			<div class="grid gap-4 sm:grid-cols-2">
				<div>
					<label for="client_id" class="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
						Client ID
					</label>
					<Input id="client_id" type="text" bind:value={client.client_id} disabled />
				</div>
				<div>
					<label for="client_name" class="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
						Client Name
					</label>
					<Input id="client_name" type="text" bind:value={client.client_name} />
				</div>
				<div>
					<label for="logo_uri" class="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
						Logo URI
					</label>
					<Input id="logo_uri" type="url" bind:value={client.logo_uri} />
				</div>
				<div>
					<label for="client_uri" class="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
						Client URI
					</label>
					<Input id="client_uri" type="url" bind:value={client.client_uri} />
				</div>
				<div>
					<label for="policy_uri" class="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
						Privacy Policy URI
					</label>
					<Input id="policy_uri" type="url" bind:value={client.policy_uri} />
				</div>
				<div>
					<label for="tos_uri" class="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
						Terms of Service URI
					</label>
					<Input id="tos_uri" type="url" bind:value={client.tos_uri} />
				</div>
			</div>

			<div class="mt-4 grid gap-2 text-sm text-gray-500 dark:text-gray-400">
				<p>Created: {formatDate(client.created_at)}</p>
				<p>Last Updated: {formatDate(client.updated_at)}</p>
			</div>
		</Card>

		<!-- Redirect URIs -->
		<Card>
			<h2 class="mb-4 text-lg font-semibold text-gray-900 dark:text-white">
				{m.admin_client_detail_redirectUris()}
			</h2>

			<div class="mb-4 flex gap-2">
				<div class="flex-1">
					<Input
						type="url"
						placeholder="https://example.com/callback"
						bind:value={newRedirectUri}
						onkeydown={(e) => e.key === 'Enter' && addRedirectUri()}
					/>
				</div>
				<Button variant="secondary" onclick={addRedirectUri}>Add</Button>
			</div>

			<div class="space-y-2">
				{#each client.redirect_uris as uri (uri)}
					<div class="flex items-center justify-between rounded-lg border border-gray-200 px-3 py-2 dark:border-gray-700">
						<code class="text-sm text-gray-900 dark:text-white">{uri}</code>
						<button
							class="rounded bg-red-500 px-2 py-1 text-xs font-medium text-white hover:bg-red-600 transition-colors"
							onclick={() => removeRedirectUri(uri)}
						>
							Remove
						</button>
					</div>
				{/each}
				{#if client.redirect_uris.length === 0}
					<p class="text-sm text-gray-500 dark:text-gray-400">No redirect URIs configured</p>
				{/if}
			</div>
		</Card>

		<!-- Grant Types -->
		<Card>
			<h2 class="mb-4 text-lg font-semibold text-gray-900 dark:text-white">
				{m.admin_client_detail_grantTypes()}
			</h2>
			<div class="space-y-2">
				{#each availableGrantTypes as grantType (grantType.value)}
					<label class="flex items-center gap-2">
						<input
							type="checkbox"
							checked={client.grant_types.includes(grantType.value)}
							onchange={() => toggleGrantType(grantType.value)}
							class="h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
						/>
						<span class="text-sm text-gray-700 dark:text-gray-300">{grantType.label}</span>
					</label>
				{/each}
			</div>
		</Card>

		<!-- Scopes -->
		<Card>
			<h2 class="mb-4 text-lg font-semibold text-gray-900 dark:text-white">
				{m.admin_client_detail_scopes()}
			</h2>
			<div>
				<label for="scope" class="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
					Allowed Scopes (space-separated)
				</label>
				<Input
					id="scope"
					type="text"
					bind:value={client.scope}
					placeholder="openid profile email"
				/>
				<p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
					Separate multiple scopes with spaces
				</p>
			</div>
		</Card>
	{:else}
		<Card>
			<p class="text-center text-gray-500 dark:text-gray-400">Client not found</p>
		</Card>
	{/if}
</div>
