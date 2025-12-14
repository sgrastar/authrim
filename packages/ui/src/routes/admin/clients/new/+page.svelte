<script lang="ts">
	import { LL } from '$i18n/i18n-svelte';
	import { Card, Button, Input, Dialog } from '$lib/components';
	import { adminClientsAPI } from '$lib/api/client';

	// Form state
	let clientName = '';
	let redirectUris: string[] = [];
	let newRedirectUri = '';
	let grantTypes: string[] = ['authorization_code'];
	let scope = 'openid profile email';
	let logoUri = '';
	let clientUri = '';
	let policyUri = '';
	let tosUri = '';
	let isTrusted = false;
	let skipConsent = false;
	let allowClaimsWithoutScope = false;

	// UI state
	let saving = false;
	let error = '';
	let showSuccessDialog = false;
	let createdClient: { client_id: string; client_secret: string } | null = null;

	const availableGrantTypes = [
		{ value: 'authorization_code', label: 'Authorization Code' },
		{ value: 'refresh_token', label: 'Refresh Token' },
		{ value: 'client_credentials', label: 'Client Credentials' }
	];

	async function handleCreate() {
		// Validation
		if (!clientName.trim()) {
			error = 'Client name is required';
			return;
		}
		if (redirectUris.length === 0) {
			error = 'At least one redirect URI is required';
			return;
		}

		saving = true;
		error = '';

		try {
			const { data, error: apiError } = await adminClientsAPI.create({
				client_name: clientName.trim(),
				redirect_uris: redirectUris,
				grant_types: grantTypes,
				scope: scope.trim(),
				logo_uri: logoUri.trim() || undefined,
				client_uri: clientUri.trim() || undefined,
				policy_uri: policyUri.trim() || undefined,
				tos_uri: tosUri.trim() || undefined,
				is_trusted: isTrusted,
				skip_consent: skipConsent,
				allow_claims_without_scope: allowClaimsWithoutScope
			});

			if (apiError) {
				error = apiError.error_description || 'Failed to create client';
			} else if (data) {
				createdClient = {
					client_id: data.client.client_id,
					client_secret: data.client.client_secret
				};
				showSuccessDialog = true;
			}
		} catch (err) {
			error = err instanceof Error ? err.message : 'An error occurred';
		} finally {
			saving = false;
		}
	}

	function addRedirectUri() {
		if (!newRedirectUri.trim()) return;

		// Validate URL
		try {
			new URL(newRedirectUri.trim());
		} catch {
			alert('Invalid URL format');
			return;
		}

		if (redirectUris.includes(newRedirectUri.trim())) {
			alert('This URI is already in the list');
			return;
		}
		redirectUris = [...redirectUris, newRedirectUri.trim()];
		newRedirectUri = '';
	}

	function removeRedirectUri(uri: string) {
		redirectUris = redirectUris.filter((u) => u !== uri);
	}

	function toggleGrantType(grantType: string) {
		if (grantTypes.includes(grantType)) {
			grantTypes = grantTypes.filter((g) => g !== grantType);
		} else {
			grantTypes = [...grantTypes, grantType];
		}
	}

	function copyToClipboard(text: string) {
		navigator.clipboard.writeText(text);
	}

	function handleCloseSuccessDialog() {
		showSuccessDialog = false;
		window.location.href = '/admin/clients';
	}
</script>

<svelte:head>
	<title>Register Client - {$LL.app_title()}</title>
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
				{$LL.admin_clients_registerClient()}
			</h1>
			<p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
				Register a new OAuth 2.0 / OpenID Connect client
			</p>
		</div>
		<Button variant="primary" onclick={handleCreate} disabled={saving}>
			{#if saving}
				<div class="i-heroicons-arrow-path h-4 w-4 animate-spin"></div>
			{/if}
			Create Client
		</Button>
	</div>

	<!-- Error Message -->
	{#if error}
		<div class="rounded-lg bg-red-50 p-4 dark:bg-red-900/20">
			<div class="flex items-center gap-3">
				<div class="i-heroicons-exclamation-circle h-5 w-5 text-red-600 dark:text-red-400"></div>
				<p class="text-sm text-red-800 dark:text-red-200">{error}</p>
			</div>
		</div>
	{/if}

	<!-- Basic Information -->
	<Card>
		<h2 class="mb-4 text-lg font-semibold text-gray-900 dark:text-white">
			{$LL.admin_client_detail_basicInfo()}
		</h2>
		<div class="grid gap-4 sm:grid-cols-2">
			<div class="sm:col-span-2">
				<label
					for="client_name"
					class="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300"
				>
					Client Name <span class="text-red-500">*</span>
				</label>
				<Input id="client_name" type="text" bind:value={clientName} placeholder="My Application" />
			</div>
			<div>
				<label
					for="logo_uri"
					class="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300"
				>
					Logo URI
				</label>
				<Input
					id="logo_uri"
					type="url"
					bind:value={logoUri}
					placeholder="https://example.com/logo.png"
				/>
			</div>
			<div>
				<label
					for="client_uri"
					class="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300"
				>
					Client URI
				</label>
				<Input
					id="client_uri"
					type="url"
					bind:value={clientUri}
					placeholder="https://example.com"
				/>
			</div>
			<div>
				<label
					for="policy_uri"
					class="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300"
				>
					Privacy Policy URI
				</label>
				<Input
					id="policy_uri"
					type="url"
					bind:value={policyUri}
					placeholder="https://example.com/privacy"
				/>
			</div>
			<div>
				<label
					for="tos_uri"
					class="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300"
				>
					Terms of Service URI
				</label>
				<Input
					id="tos_uri"
					type="url"
					bind:value={tosUri}
					placeholder="https://example.com/terms"
				/>
			</div>
		</div>
	</Card>

	<!-- Redirect URIs -->
	<Card>
		<h2 class="mb-4 text-lg font-semibold text-gray-900 dark:text-white">
			{$LL.admin_client_detail_redirectUris()} <span class="text-red-500">*</span>
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
			{#each redirectUris as uri (uri)}
				<div
					class="flex items-center justify-between rounded-lg border border-gray-200 px-3 py-2 dark:border-gray-700"
				>
					<code class="text-sm text-gray-900 dark:text-white">{uri}</code>
					<button
						class="rounded bg-red-500 px-2 py-1 text-xs font-medium text-white hover:bg-red-600 transition-colors"
						onclick={() => removeRedirectUri(uri)}
					>
						Remove
					</button>
				</div>
			{/each}
			{#if redirectUris.length === 0}
				<p class="text-sm text-gray-500 dark:text-gray-400">
					No redirect URIs added. Add at least one redirect URI.
				</p>
			{/if}
		</div>
	</Card>

	<!-- Grant Types -->
	<Card>
		<h2 class="mb-4 text-lg font-semibold text-gray-900 dark:text-white">
			{$LL.admin_client_detail_grantTypes()}
		</h2>
		<div class="space-y-2">
			{#each availableGrantTypes as grantType (grantType.value)}
				<label class="flex items-center gap-2">
					<input
						type="checkbox"
						checked={grantTypes.includes(grantType.value)}
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
			{$LL.admin_client_detail_scopes()}
		</h2>
		<div>
			<label for="scope" class="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
				Allowed Scopes (space-separated)
			</label>
			<Input id="scope" type="text" bind:value={scope} placeholder="openid profile email" />
			<p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
				Separate multiple scopes with spaces
			</p>
		</div>
	</Card>

	<!-- Advanced Settings -->
	<Card>
		<h2 class="mb-4 text-lg font-semibold text-gray-900 dark:text-white">Advanced Settings</h2>
		<div class="space-y-4">
			<label class="flex items-start gap-3">
				<input
					type="checkbox"
					bind:checked={isTrusted}
					class="mt-1 h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
				/>
				<div class="flex-1">
					<span class="block text-sm font-medium text-gray-700 dark:text-gray-300">
						Trusted Client
					</span>
					<span class="block text-xs text-gray-500 dark:text-gray-400 mt-1">
						Mark this client as trusted. Trusted clients may have fewer restrictions.
					</span>
				</div>
			</label>

			<label class="flex items-start gap-3">
				<input
					type="checkbox"
					bind:checked={skipConsent}
					class="mt-1 h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
				/>
				<div class="flex-1">
					<span class="block text-sm font-medium text-gray-700 dark:text-gray-300">
						Skip Consent Screen
					</span>
					<span class="block text-xs text-gray-500 dark:text-gray-400 mt-1">
						Skip the user consent screen for this client. Use with caution.
					</span>
				</div>
			</label>

			<label class="flex items-start gap-3">
				<input
					type="checkbox"
					bind:checked={allowClaimsWithoutScope}
					class="mt-1 h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
				/>
				<div class="flex-1">
					<span class="block text-sm font-medium text-gray-700 dark:text-gray-300">
						Allow claims without scope
					</span>
					<span class="block text-xs text-gray-500 dark:text-gray-400 mt-1">
						When enabled, the client can request user claims via the <code
							class="px-1 py-0.5 bg-gray-100 dark:bg-gray-800 rounded">claims</code
						> parameter even without the corresponding scope. This is required for OIDC conformance tests
						but should be disabled for production clients for privacy protection.
					</span>
				</div>
			</label>
		</div>
	</Card>
</div>

<!-- Success Dialog -->
<Dialog bind:open={showSuccessDialog} title="Client Created Successfully">
	<div class="space-y-4">
		<p class="text-sm text-gray-600 dark:text-gray-300">
			Your OAuth client has been created. Please save the client secret below - it will only be
			shown once!
		</p>

		{#if createdClient}
			<div class="space-y-3">
				<div>
					<span class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
						Client ID
					</span>
					<div class="flex items-center gap-2">
						<code class="flex-1 rounded bg-gray-100 px-3 py-2 text-sm dark:bg-gray-800 break-all">
							{createdClient.client_id}
						</code>
						<Button
							variant="secondary"
							onclick={() => copyToClipboard(createdClient?.client_id || '')}
						>
							Copy
						</Button>
					</div>
				</div>

				<div>
					<span class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
						Client Secret
					</span>
					<div class="flex items-center gap-2">
						<code
							class="flex-1 rounded bg-yellow-100 px-3 py-2 text-sm dark:bg-yellow-900/30 break-all text-yellow-800 dark:text-yellow-200"
						>
							{createdClient.client_secret}
						</code>
						<Button
							variant="secondary"
							onclick={() => copyToClipboard(createdClient?.client_secret || '')}
						>
							Copy
						</Button>
					</div>
					<p class="mt-1 text-xs text-red-600 dark:text-red-400">
						This secret will not be shown again. Please copy and store it securely.
					</p>
				</div>
			</div>
		{/if}
	</div>

	<div slot="footer" class="flex justify-end gap-3">
		<Button variant="primary" onclick={handleCloseSuccessDialog}>Done</Button>
	</div>
</Dialog>
