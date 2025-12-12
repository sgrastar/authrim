<script lang="ts">
	import { LL } from '$i18n/i18n-svelte';
	import { Card, Button, Dialog, Alert } from '$lib/components';
	import { onMount } from 'svelte';
	import { externalIdpAdminAPI } from '$lib/api/client';
	import ProviderModal from './ProviderModal.svelte';

	interface Provider {
		id: string;
		tenantId: string;
		name: string;
		providerType: 'oidc' | 'oauth2';
		enabled: boolean;
		priority: number;
		issuer?: string;
		clientId: string;
		hasSecret: boolean;
		scopes: string;
		autoLinkEmail: boolean;
		jitProvisioning: boolean;
		iconUrl?: string;
		buttonColor?: string;
		buttonText?: string;
		createdAt: number;
		updatedAt: number;
	}

	let providers: Provider[] = $state([]);
	let loading = $state(true);
	let error = $state('');

	// Modal state
	let showModal = $state(false);
	let editingProvider: Provider | null = $state(null);

	// Delete dialog state
	let showDeleteDialog = $state(false);
	let providerToDelete: Provider | null = $state(null);
	let deleting = $state(false);

	onMount(async () => {
		await loadProviders();
	});

	async function loadProviders() {
		loading = true;
		error = '';

		try {
			const { data, error: apiError } = await externalIdpAdminAPI.list();

			if (apiError) {
				error = apiError.error_description || 'Failed to load providers';
				providers = [];
			} else if (data) {
				providers = data.providers;
			}
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to load providers';
			providers = [];
		} finally {
			loading = false;
		}
	}

	function openCreateModal() {
		editingProvider = null;
		showModal = true;
	}

	function openEditModal(provider: Provider) {
		editingProvider = provider;
		showModal = true;
	}

	function closeModal() {
		showModal = false;
		editingProvider = null;
	}

	async function handleModalSave() {
		closeModal();
		await loadProviders();
	}

	function openDeleteDialog(provider: Provider) {
		providerToDelete = provider;
		showDeleteDialog = true;
	}

	function closeDeleteDialog() {
		showDeleteDialog = false;
		providerToDelete = null;
	}

	async function confirmDelete() {
		if (!providerToDelete) return;

		deleting = true;
		try {
			const { error: apiError } = await externalIdpAdminAPI.delete(providerToDelete.id);
			if (apiError) {
				alert('Failed to delete provider: ' + (apiError.error_description || 'Unknown error'));
			} else {
				await loadProviders();
			}
		} catch (err) {
			console.error('Delete error:', err);
			alert('Failed to delete provider');
		} finally {
			deleting = false;
			closeDeleteDialog();
		}
	}

	async function toggleEnabled(provider: Provider) {
		try {
			const { error: apiError } = await externalIdpAdminAPI.update(provider.id, {
				enabled: !provider.enabled
			});
			if (apiError) {
				alert('Failed to update provider: ' + (apiError.error_description || 'Unknown error'));
			} else {
				await loadProviders();
			}
		} catch (err) {
			console.error('Toggle error:', err);
			alert('Failed to update provider');
		}
	}

	function formatDate(timestamp: number): string {
		return new Date(timestamp).toLocaleString('ja-JP', {
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit'
		});
	}

	function getProviderIcon(provider: Provider): string {
		if (provider.iconUrl) return '';
		const name = provider.name.toLowerCase();
		if (name.includes('google')) return 'i-logos-google-icon';
		if (name.includes('github')) return 'i-logos-github-icon';
		if (name.includes('microsoft') || name.includes('azure')) return 'i-logos-microsoft-icon';
		if (name.includes('apple')) return 'i-logos-apple';
		if (name.includes('facebook')) return 'i-logos-facebook';
		return 'i-heroicons-globe-alt';
	}
</script>

<svelte:head>
	<title>Identity Providers - {$LL.app_title()}</title>
</svelte:head>

<div class="space-y-6">
	<!-- Page header -->
	<div class="flex items-center justify-between">
		<div>
			<h1 class="text-3xl font-bold text-gray-900 dark:text-white">Identity Providers</h1>
			<p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
				Manage external identity providers for social login (Google, GitHub, etc.)
			</p>
		</div>
		<Button variant="primary" onclick={openCreateModal}>
			<div class="i-heroicons-plus h-5 w-5"></div>
			Add Provider
		</Button>
	</div>

	<!-- Error alert -->
	{#if error}
		<Alert variant="error" dismissible={true} onDismiss={() => (error = '')}>
			{error}
		</Alert>
	{/if}

	<!-- Providers table -->
	<Card>
		<div class="overflow-x-auto">
			<table class="w-full">
				<thead>
					<tr class="border-b border-gray-200 dark:border-gray-700">
						<th
							class="px-4 py-3 text-left text-sm font-semibold text-gray-900 dark:text-white whitespace-nowrap"
						>
							Provider
						</th>
						<th
							class="px-4 py-3 text-left text-sm font-semibold text-gray-900 dark:text-white whitespace-nowrap"
						>
							Type
						</th>
						<th
							class="px-4 py-3 text-left text-sm font-semibold text-gray-900 dark:text-white whitespace-nowrap"
						>
							Client ID
						</th>
						<th
							class="px-4 py-3 text-left text-sm font-semibold text-gray-900 dark:text-white whitespace-nowrap"
						>
							Status
						</th>
						<th
							class="px-4 py-3 text-left text-sm font-semibold text-gray-900 dark:text-white whitespace-nowrap"
						>
							Created
						</th>
						<th
							class="px-4 py-3 text-right text-sm font-semibold text-gray-900 dark:text-white whitespace-nowrap"
						>
							Actions
						</th>
					</tr>
				</thead>
				<tbody>
					{#if loading}
						{#each [0, 1, 2] as i (i)}
							<tr class="border-b border-gray-200 dark:border-gray-700">
								<td class="px-4 py-3">
									<div class="flex items-center gap-3">
										<div
											class="h-8 w-8 animate-pulse rounded-lg bg-gray-300 dark:bg-gray-700"
										></div>
										<div class="h-4 w-24 animate-pulse rounded bg-gray-300 dark:bg-gray-700"></div>
									</div>
								</td>
								<td class="px-4 py-3">
									<div class="h-4 w-16 animate-pulse rounded bg-gray-300 dark:bg-gray-700"></div>
								</td>
								<td class="px-4 py-3">
									<div class="h-4 w-32 animate-pulse rounded bg-gray-300 dark:bg-gray-700"></div>
								</td>
								<td class="px-4 py-3">
									<div class="h-6 w-16 animate-pulse rounded bg-gray-300 dark:bg-gray-700"></div>
								</td>
								<td class="px-4 py-3">
									<div class="h-4 w-24 animate-pulse rounded bg-gray-300 dark:bg-gray-700"></div>
								</td>
								<td class="px-4 py-3">
									<div class="h-8 w-20 animate-pulse rounded bg-gray-300 dark:bg-gray-700"></div>
								</td>
							</tr>
						{/each}
					{:else if providers.length === 0}
						<tr>
							<td colspan="6" class="px-4 py-12 text-center">
								<div class="flex flex-col items-center gap-3">
									<div class="i-heroicons-identification h-12 w-12 text-gray-400"></div>
									<p class="text-gray-500 dark:text-gray-400">No identity providers configured</p>
									<Button variant="primary" onclick={openCreateModal}>
										<div class="i-heroicons-plus h-5 w-5"></div>
										Add your first provider
									</Button>
								</div>
							</td>
						</tr>
					{:else}
						{#each providers as provider (provider.id)}
							<tr
								class="border-b border-gray-200 hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800"
							>
								<td class="px-4 py-3">
									<div class="flex items-center gap-3">
										{#if provider.iconUrl}
											<img
												src={provider.iconUrl}
												alt={provider.name}
												class="h-8 w-8 rounded-lg object-contain"
											/>
										{:else}
											<div
												class="flex h-8 w-8 items-center justify-center rounded-lg bg-gray-100 dark:bg-gray-700"
											>
												<div class="{getProviderIcon(provider)} h-5 w-5"></div>
											</div>
										{/if}
										<span class="font-medium text-gray-900 dark:text-white">{provider.name}</span>
									</div>
								</td>
								<td class="px-4 py-3">
									<span
										class="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium {provider.providerType ===
										'oidc'
											? 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200'
											: 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200'}"
									>
										{provider.providerType.toUpperCase()}
									</span>
								</td>
								<td class="px-4 py-3 font-mono text-sm text-gray-500 dark:text-gray-400">
									{provider.clientId.length > 24
										? provider.clientId.slice(0, 12) + '...' + provider.clientId.slice(-8)
										: provider.clientId}
								</td>
								<td class="px-4 py-3">
									<button
										class="relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-2 {provider.enabled
											? 'bg-primary-600'
											: 'bg-gray-200 dark:bg-gray-700'}"
										onclick={() => toggleEnabled(provider)}
										aria-label="Toggle enabled"
									>
										<span
											class="pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out {provider.enabled
												? 'translate-x-5'
												: 'translate-x-0'}"
										></span>
									</button>
								</td>
								<td class="px-4 py-3 text-sm text-gray-500 dark:text-gray-400 whitespace-nowrap">
									{formatDate(provider.createdAt)}
								</td>
								<td class="px-4 py-3 text-right whitespace-nowrap">
									<div class="flex items-center justify-end gap-2">
										<button
											class="rounded bg-gray-100 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600 transition-colors"
											onclick={() => openEditModal(provider)}
										>
											Edit
										</button>
										<button
											class="rounded bg-red-100 px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-200 dark:bg-red-900/30 dark:text-red-400 dark:hover:bg-red-900/50 transition-colors"
											onclick={() => openDeleteDialog(provider)}
										>
											Delete
										</button>
									</div>
								</td>
							</tr>
						{/each}
					{/if}
				</tbody>
			</table>
		</div>
	</Card>
</div>

<!-- Provider Modal (Create/Edit) -->
{#if showModal}
	<ProviderModal provider={editingProvider} onSave={handleModalSave} onClose={closeModal} />
{/if}

<!-- Delete Confirmation Dialog -->
<Dialog bind:open={showDeleteDialog} title="Delete Provider">
	<p class="text-gray-600 dark:text-gray-300">
		Are you sure you want to delete <strong>{providerToDelete?.name}</strong>? This will remove all
		linked identities and cannot be undone.
	</p>

	<div slot="footer" class="flex justify-end gap-3">
		<Button variant="secondary" onclick={closeDeleteDialog} disabled={deleting}>Cancel</Button>
		<Button variant="danger" onclick={confirmDelete} disabled={deleting}>
			{#if deleting}
				Deleting...
			{:else}
				Delete
			{/if}
		</Button>
	</div>
</Dialog>
