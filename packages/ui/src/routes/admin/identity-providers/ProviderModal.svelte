<script lang="ts">
	import { Button, Input, Dialog } from '$lib/components';
	import { externalIdpAdminAPI } from '$lib/api/client';

	interface Provider {
		id: string;
		name: string;
		providerType: 'oidc' | 'oauth2';
		enabled: boolean;
		issuer?: string;
		clientId: string;
		hasSecret: boolean;
		scopes: string;
		autoLinkEmail: boolean;
		jitProvisioning: boolean;
		requireEmailVerified?: boolean;
		iconUrl?: string;
		buttonColor?: string;
		buttonText?: string;
	}

	interface Props {
		provider: Provider | null;
		onSave: () => void;
		onClose: () => void;
	}

	let { provider, onSave, onClose }: Props = $props();

	// Form state
	let name = $state(provider?.name || '');
	let providerType = $state<'oidc' | 'oauth2'>(provider?.providerType || 'oidc');
	let clientId = $state(provider?.clientId || '');
	let clientSecret = $state('');
	let issuer = $state(provider?.issuer || '');
	let scopes = $state(provider?.scopes || 'openid email profile');
	let enabled = $state(provider?.enabled ?? true);
	let autoLinkEmail = $state(provider?.autoLinkEmail ?? true);
	let jitProvisioning = $state(provider?.jitProvisioning ?? true);
	let requireEmailVerified = $state(provider?.requireEmailVerified ?? true);
	let iconUrl = $state(provider?.iconUrl || '');
	let buttonColor = $state(provider?.buttonColor || '');
	let buttonText = $state(provider?.buttonText || '');
	let template = $state<'google' | 'github' | 'microsoft' | ''>('');

	let saving = $state(false);
	let error = $state('');
	let showAdvanced = $state(false);

	const isEditing = provider !== null;

	// Template configurations
	const templates = {
		google: {
			name: 'Google',
			issuer: 'https://accounts.google.com',
			scopes: 'openid email profile',
			iconUrl: '',
			buttonColor: '#4285F4',
			buttonText: 'Continue with Google'
		},
		github: {
			name: 'GitHub',
			issuer: '',
			scopes: 'read:user user:email',
			iconUrl: '',
			buttonColor: '#24292e',
			buttonText: 'Continue with GitHub'
		},
		microsoft: {
			name: 'Microsoft',
			issuer: 'https://login.microsoftonline.com/common/v2.0',
			scopes: 'openid email profile',
			iconUrl: '',
			buttonColor: '#00a4ef',
			buttonText: 'Continue with Microsoft'
		}
	};

	function applyTemplate(t: 'google' | 'github' | 'microsoft') {
		const config = templates[t];
		name = config.name;
		issuer = config.issuer;
		scopes = config.scopes;
		buttonColor = config.buttonColor;
		buttonText = config.buttonText;
		providerType = t === 'github' ? 'oauth2' : 'oidc';
		template = t;
	}

	async function handleSubmit() {
		error = '';

		// Validation
		if (!name.trim()) {
			error = 'Name is required';
			return;
		}
		if (!clientId.trim()) {
			error = 'Client ID is required';
			return;
		}
		if (!isEditing && !clientSecret.trim()) {
			error = 'Client Secret is required';
			return;
		}
		if (providerType === 'oidc' && !issuer.trim()) {
			error = 'Issuer URL is required for OIDC providers';
			return;
		}

		saving = true;

		try {
			if (isEditing) {
				// Update existing provider
				const updateData: Record<string, unknown> = {
					name,
					provider_type: providerType,
					client_id: clientId,
					issuer: issuer || undefined,
					scopes,
					enabled,
					auto_link_email: autoLinkEmail,
					jit_provisioning: jitProvisioning,
					require_email_verified: requireEmailVerified,
					icon_url: iconUrl || undefined,
					button_color: buttonColor || undefined,
					button_text: buttonText || undefined
				};

				// Only include secret if changed
				if (clientSecret.trim()) {
					updateData.client_secret = clientSecret;
				}

				const { error: apiError } = await externalIdpAdminAPI.update(provider.id, updateData);
				if (apiError) {
					error = apiError.error_description || 'Failed to update provider';
					return;
				}
			} else {
				// Create new provider
				const createData = {
					name,
					provider_type: providerType,
					client_id: clientId,
					client_secret: clientSecret,
					issuer: issuer || undefined,
					scopes,
					enabled,
					auto_link_email: autoLinkEmail,
					jit_provisioning: jitProvisioning,
					require_email_verified: requireEmailVerified,
					icon_url: iconUrl || undefined,
					button_color: buttonColor || undefined,
					button_text: buttonText || undefined,
					template: template || undefined
				};

				const { error: apiError } = await externalIdpAdminAPI.create(createData);
				if (apiError) {
					error = apiError.error_description || 'Failed to create provider';
					return;
				}
			}

			onSave();
		} catch (err) {
			error = err instanceof Error ? err.message : 'An error occurred';
		} finally {
			saving = false;
		}
	}
</script>

<Dialog open={true} title={isEditing ? `Edit ${provider.name}` : 'Add Identity Provider'}>
	<form
		onsubmit={(e) => {
			e.preventDefault();
			handleSubmit();
		}}
		class="space-y-6"
	>
		<!-- Error message -->
		{#if error}
			<div
				class="rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-900/20 dark:text-red-400"
			>
				{error}
			</div>
		{/if}

		<!-- Template selector (only for new providers) -->
		{#if !isEditing}
			<div>
				<p class="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">
					Quick Start Template
				</p>
				<div class="flex flex-wrap gap-2">
					<button
						type="button"
						class="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors {template ===
						'google'
							? 'border-primary-500 bg-primary-50 dark:bg-primary-900/20'
							: 'border-gray-300 hover:bg-gray-50 dark:border-gray-600 dark:hover:bg-gray-800'}"
						onclick={() => applyTemplate('google')}
					>
						<div class="i-logos-google-icon h-4 w-4"></div>
						Google
					</button>
					<button
						type="button"
						class="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors {template ===
						'github'
							? 'border-primary-500 bg-primary-50 dark:bg-primary-900/20'
							: 'border-gray-300 hover:bg-gray-50 dark:border-gray-600 dark:hover:bg-gray-800'}"
						onclick={() => applyTemplate('github')}
					>
						<div class="i-logos-github-icon h-4 w-4"></div>
						GitHub
					</button>
					<button
						type="button"
						class="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors {template ===
						'microsoft'
							? 'border-primary-500 bg-primary-50 dark:bg-primary-900/20'
							: 'border-gray-300 hover:bg-gray-50 dark:border-gray-600 dark:hover:bg-gray-800'}"
						onclick={() => applyTemplate('microsoft')}
					>
						<div class="i-logos-microsoft-icon h-4 w-4"></div>
						Microsoft
					</button>
				</div>
			</div>
		{/if}

		<!-- Basic Info -->
		<div class="grid gap-4 sm:grid-cols-2">
			<Input label="Provider Name" bind:value={name} placeholder="e.g., Google" required />

			<div>
				<label
					for="providerType"
					class="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300"
				>
					Provider Type
				</label>
				<select
					id="providerType"
					bind:value={providerType}
					class="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500 dark:border-gray-600 dark:bg-gray-700 dark:text-white"
				>
					<option value="oidc">OpenID Connect (OIDC)</option>
					<option value="oauth2">OAuth 2.0</option>
				</select>
			</div>
		</div>

		<!-- OAuth Credentials -->
		<div class="grid gap-4 sm:grid-cols-2">
			<Input label="Client ID" bind:value={clientId} placeholder="Your OAuth client ID" required />

			<Input
				label={isEditing ? 'Client Secret (leave blank to keep)' : 'Client Secret'}
				type="password"
				bind:value={clientSecret}
				placeholder={isEditing ? '••••••••' : 'Your OAuth client secret'}
				required={!isEditing}
			/>
		</div>

		<!-- OIDC Settings -->
		{#if providerType === 'oidc'}
			<Input
				label="Issuer URL"
				bind:value={issuer}
				placeholder="https://accounts.google.com"
				required
			/>
		{/if}

		<Input label="Scopes" bind:value={scopes} placeholder="openid email profile" />

		<!-- Toggles -->
		<div class="space-y-3">
			<label class="flex items-center gap-3">
				<input
					type="checkbox"
					bind:checked={enabled}
					class="h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
				/>
				<span class="text-sm text-gray-700 dark:text-gray-300">Enabled</span>
			</label>

			<label class="flex items-center gap-3">
				<input
					type="checkbox"
					bind:checked={autoLinkEmail}
					class="h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
				/>
				<span class="text-sm text-gray-700 dark:text-gray-300"
					>Auto-link by email (match existing users)</span
				>
			</label>

			<label class="flex items-center gap-3">
				<input
					type="checkbox"
					bind:checked={jitProvisioning}
					class="h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
				/>
				<span class="text-sm text-gray-700 dark:text-gray-300"
					>Just-in-Time provisioning (create new users)</span
				>
			</label>
		</div>

		<!-- Advanced Settings -->
		<div>
			<button
				type="button"
				class="flex items-center gap-2 text-sm text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-200"
				onclick={() => (showAdvanced = !showAdvanced)}
			>
				<div
					class="i-heroicons-chevron-right h-4 w-4 transition-transform {showAdvanced
						? 'rotate-90'
						: ''}"
				></div>
				Advanced Settings
			</button>

			{#if showAdvanced}
				<div class="mt-4 space-y-4 rounded-lg border border-gray-200 p-4 dark:border-gray-700">
					<label class="flex items-center gap-3">
						<input
							type="checkbox"
							bind:checked={requireEmailVerified}
							class="h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
						/>
						<span class="text-sm text-gray-700 dark:text-gray-300"
							>Require verified email from provider</span
						>
					</label>

					<Input label="Icon URL" bind:value={iconUrl} placeholder="https://example.com/icon.png" />

					<div class="grid gap-4 sm:grid-cols-2">
						<Input
							label="Button Color"
							type="text"
							bind:value={buttonColor}
							placeholder="#4285F4"
						/>
						<Input
							label="Button Text"
							bind:value={buttonText}
							placeholder="Continue with Provider"
						/>
					</div>
				</div>
			{/if}
		</div>
	</form>

	<div slot="footer" class="flex justify-end gap-3">
		<Button variant="secondary" onclick={onClose} disabled={saving}>Cancel</Button>
		<Button variant="primary" onclick={handleSubmit} loading={saving}>
			{isEditing ? 'Save Changes' : 'Create Provider'}
		</Button>
	</div>
</Dialog>
