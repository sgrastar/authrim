<script lang="ts">
	import { LL } from '$i18n/i18n-svelte';
	import { Card, Button, Input } from '$lib/components';
	import { onMount } from 'svelte';
	import { adminSettingsAPI } from '$lib/api/client';

	let loading = false;
	let saving = false;
	let error = '';
	let successMessage = '';

	// Feature Flags
	let enableAbac = false;
	let enableRebac = false;
	let enablePolicyLogging = false;
	let enableVerifiedAttributes = false;
	let enableCustomRules = true;
	let enableSdJwt = false;
	let enablePolicyEmbedding = false;

	// Token Claims Configuration
	let accessTokenClaims = 'roles,org_id,org_type';
	let idTokenClaims = 'roles,user_type,org_id,plan,org_type';

	onMount(async () => {
		await loadSettings();
	});

	async function loadSettings() {
		loading = true;
		error = '';

		try {
			const { data, error: apiError } = await adminSettingsAPI.get();

			if (apiError) {
				error = apiError.error_description || 'Failed to load settings';
				console.error('Failed to load settings:', apiError);
			} else if (data?.settings?.policy) {
				const policy = data.settings.policy;
				enableAbac = policy.enableAbac ?? false;
				enableRebac = policy.enableRebac ?? false;
				enablePolicyLogging = policy.enablePolicyLogging ?? false;
				enableVerifiedAttributes = policy.enableVerifiedAttributes ?? false;
				enableCustomRules = policy.enableCustomRules ?? true;
				enableSdJwt = policy.enableSdJwt ?? false;
				enablePolicyEmbedding = policy.enablePolicyEmbedding ?? false;
				accessTokenClaims = policy.accessTokenClaims ?? 'roles,org_id,org_type';
				idTokenClaims = policy.idTokenClaims ?? 'roles,user_type,org_id,plan,org_type';
			}
		} catch (err) {
			error = err instanceof Error ? err.message : 'An error occurred';
			console.error('Error loading settings:', err);
		} finally {
			loading = false;
		}
	}

	async function handleSave() {
		saving = true;
		error = '';
		successMessage = '';

		try {
			const { data, error: apiError } = await adminSettingsAPI.update({
				policy: {
					enableAbac,
					enableRebac,
					enablePolicyLogging,
					enableVerifiedAttributes,
					enableCustomRules,
					enableSdJwt,
					enablePolicyEmbedding,
					accessTokenClaims,
					idTokenClaims
				}
			});

			if (apiError) {
				error = apiError.error_description || 'Failed to save settings';
				console.error('Failed to save settings:', apiError);
			} else if (data) {
				successMessage = $LL.admin_policy_save_success?.() || 'Policy settings saved successfully';
				setTimeout(() => {
					successMessage = '';
				}, 3000);
			}
		} catch (err) {
			error = err instanceof Error ? err.message : 'An error occurred';
			console.error('Error saving settings:', err);
		} finally {
			saving = false;
		}
	}
</script>

<svelte:head>
	<title>{$LL.admin_policy_title?.() || 'Policy Settings'} - {$LL.app_title()}</title>
</svelte:head>

<div class="space-y-6">
	<!-- Page header -->
	<div class="flex items-center justify-between">
		<div>
			<h1 class="text-3xl font-bold text-gray-900 dark:text-white">
				{$LL.admin_policy_title?.() || 'Policy Settings'}
			</h1>
			<p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
				{$LL.admin_policy_subtitle?.() || 'Configure policy system features and token claims'}
			</p>
		</div>
		<Button variant="primary" onclick={handleSave} disabled={saving || loading}>
			{#if saving}
				<div class="i-heroicons-arrow-path h-4 w-4 animate-spin"></div>
			{/if}
			{$LL.admin_policy_save?.() || 'Save Changes'}
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

	<!-- Success Message -->
	{#if successMessage}
		<div class="rounded-lg bg-green-50 p-4 dark:bg-green-900/20">
			<div class="flex items-center gap-3">
				<div class="i-heroicons-check-circle h-5 w-5 text-green-600 dark:text-green-400"></div>
				<p class="text-sm text-green-800 dark:text-green-200">{successMessage}</p>
			</div>
		</div>
	{/if}

	<!-- Warning about OIDC Conformance -->
	<div class="rounded-lg bg-amber-50 p-4 dark:bg-amber-900/20">
		<div class="flex gap-3">
			<div
				class="i-heroicons-exclamation-triangle h-5 w-5 flex-shrink-0 text-amber-600 dark:text-amber-400"
			></div>
			<div>
				<h3 class="text-sm font-medium text-amber-800 dark:text-amber-200">
					{$LL.admin_policy_warning_title?.() || 'OIDC Conformance Notice'}
				</h3>
				<p class="mt-1 text-sm text-amber-700 dark:text-amber-300">
					{$LL.admin_policy_warning_desc?.() ||
						'Enabling policy features may affect OIDC conformance testing. Custom claims use the "authrim_" prefix to avoid conflicts with standard claims.'}
				</p>
			</div>
		</div>
	</div>

	<!-- Feature Flags Section -->
	<Card>
		<h2 class="mb-4 text-lg font-semibold text-gray-900 dark:text-white">
			{$LL.admin_policy_feature_flags?.() || 'Feature Flags'}
		</h2>
		<div class="space-y-4">
			<!-- Enable ABAC -->
			<div class="flex items-start gap-3">
				<input
					type="checkbox"
					id="enableAbac"
					bind:checked={enableAbac}
					class="mt-1 h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
				/>
				<div>
					<label for="enableAbac" class="text-sm font-medium text-gray-700 dark:text-gray-300">
						{$LL.admin_policy_enable_abac?.() || 'Enable ABAC (Attribute-Based Access Control)'}
					</label>
					<p class="text-xs text-gray-500 dark:text-gray-400">
						{$LL.admin_policy_enable_abac_desc?.() ||
							'Evaluate access based on user attributes (department, clearance level, etc.)'}
					</p>
				</div>
			</div>

			<!-- Enable ReBAC -->
			<div class="flex items-start gap-3">
				<input
					type="checkbox"
					id="enableRebac"
					bind:checked={enableRebac}
					class="mt-1 h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
				/>
				<div>
					<label for="enableRebac" class="text-sm font-medium text-gray-700 dark:text-gray-300">
						{$LL.admin_policy_enable_rebac?.() ||
							'Enable ReBAC (Relationship-Based Access Control)'}
					</label>
					<p class="text-xs text-gray-500 dark:text-gray-400">
						{$LL.admin_policy_enable_rebac_desc?.() ||
							'Evaluate access based on relationships between entities (Google Zanzibar style)'}
					</p>
				</div>
			</div>

			<!-- Enable Policy Logging -->
			<div class="flex items-start gap-3">
				<input
					type="checkbox"
					id="enablePolicyLogging"
					bind:checked={enablePolicyLogging}
					class="mt-1 h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
				/>
				<div>
					<label
						for="enablePolicyLogging"
						class="text-sm font-medium text-gray-700 dark:text-gray-300"
					>
						{$LL.admin_policy_enable_logging?.() || 'Enable Policy Logging'}
					</label>
					<p class="text-xs text-gray-500 dark:text-gray-400">
						{$LL.admin_policy_enable_logging_desc?.() ||
							'Log detailed policy evaluation results for debugging'}
					</p>
				</div>
			</div>

			<!-- Enable Verified Attributes -->
			<div class="flex items-start gap-3">
				<input
					type="checkbox"
					id="enableVerifiedAttributes"
					bind:checked={enableVerifiedAttributes}
					class="mt-1 h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
				/>
				<div>
					<label
						for="enableVerifiedAttributes"
						class="text-sm font-medium text-gray-700 dark:text-gray-300"
					>
						{$LL.admin_policy_enable_verified_attrs?.() || 'Enable Verified Attributes'}
					</label>
					<p class="text-xs text-gray-500 dark:text-gray-400">
						{$LL.admin_policy_enable_verified_attrs_desc?.() ||
							'Require cryptographic proof of attribute claims'}
					</p>
				</div>
			</div>

			<!-- Enable Custom Rules -->
			<div class="flex items-start gap-3">
				<input
					type="checkbox"
					id="enableCustomRules"
					bind:checked={enableCustomRules}
					class="mt-1 h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
				/>
				<div>
					<label
						for="enableCustomRules"
						class="text-sm font-medium text-gray-700 dark:text-gray-300"
					>
						{$LL.admin_policy_enable_custom_rules?.() || 'Enable Custom Rules'}
					</label>
					<p class="text-xs text-gray-500 dark:text-gray-400">
						{$LL.admin_policy_enable_custom_rules_desc?.() ||
							'Allow custom policy rules beyond default RBAC'}
					</p>
				</div>
			</div>

			<!-- Enable SD-JWT -->
			<div class="flex items-start gap-3">
				<input
					type="checkbox"
					id="enableSdJwt"
					bind:checked={enableSdJwt}
					class="mt-1 h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
				/>
				<div>
					<label for="enableSdJwt" class="text-sm font-medium text-gray-700 dark:text-gray-300">
						{$LL.admin_policy_enable_sd_jwt?.() || 'Enable SD-JWT (Selective Disclosure)'}
					</label>
					<p class="text-xs text-gray-500 dark:text-gray-400">
						{$LL.admin_policy_enable_sd_jwt_desc?.() ||
							'Issue ID Tokens in SD-JWT format for selective disclosure (RFC 9901)'}
					</p>
				</div>
			</div>

			<!-- Enable Policy Embedding -->
			<div
				class="flex items-start gap-3 rounded-lg border-2 border-primary-200 bg-primary-50 p-3 dark:border-primary-800 dark:bg-primary-900/20"
			>
				<input
					type="checkbox"
					id="enablePolicyEmbedding"
					bind:checked={enablePolicyEmbedding}
					class="mt-1 h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
				/>
				<div>
					<label
						for="enablePolicyEmbedding"
						class="text-sm font-medium text-gray-700 dark:text-gray-300"
					>
						{$LL.admin_policy_enable_embedding?.() || 'Enable Policy Embedding in Access Token'}
					</label>
					<p class="text-xs text-gray-500 dark:text-gray-400">
						{$LL.admin_policy_enable_embedding_desc?.() ||
							'Evaluate requested scopes against policy and embed permitted actions as authrim_permissions claim'}
					</p>
				</div>
			</div>
		</div>
	</Card>

	<!-- Token Claims Configuration Section -->
	<Card>
		<h2 class="mb-4 text-lg font-semibold text-gray-900 dark:text-white">
			{$LL.admin_policy_token_claims?.() || 'Token Claims Configuration'}
		</h2>
		<div class="space-y-4">
			<!-- Access Token Claims -->
			<div>
				<label
					for="accessTokenClaims"
					class="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300"
				>
					{$LL.admin_policy_access_token_claims?.() || 'Access Token Claims'}
				</label>
				<Input
					id="accessTokenClaims"
					type="text"
					bind:value={accessTokenClaims}
					placeholder="roles,org_id,org_type,permissions"
				/>
				<p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
					{$LL.admin_policy_access_token_claims_desc?.() ||
						'Comma-separated list of claims to include in Access Token (prefixed with authrim_)'}
				</p>
				<div class="mt-2 flex flex-wrap gap-1">
					{#each accessTokenClaims.split(',').filter(Boolean) as claim, i (i)}
						<span
							class="rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-800 dark:bg-blue-900 dark:text-blue-200"
						>
							authrim_{claim.trim()}
						</span>
					{/each}
				</div>
			</div>

			<!-- ID Token Claims -->
			<div>
				<label
					for="idTokenClaims"
					class="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300"
				>
					{$LL.admin_policy_id_token_claims?.() || 'ID Token Claims'}
				</label>
				<Input
					id="idTokenClaims"
					type="text"
					bind:value={idTokenClaims}
					placeholder="roles,user_type,org_id,plan,org_type"
				/>
				<p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
					{$LL.admin_policy_id_token_claims_desc?.() ||
						'Comma-separated list of claims to include in ID Token (prefixed with authrim_)'}
				</p>
				<div class="mt-2 flex flex-wrap gap-1">
					{#each idTokenClaims.split(',').filter(Boolean) as claim, i (i)}
						<span
							class="rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800 dark:bg-green-900 dark:text-green-200"
						>
							authrim_{claim.trim()}
						</span>
					{/each}
				</div>
			</div>

			<!-- Available Claims Reference -->
			<div class="rounded-lg bg-gray-50 p-4 dark:bg-gray-800">
				<h3 class="mb-2 text-sm font-medium text-gray-900 dark:text-white">
					{$LL.admin_policy_available_claims?.() || 'Available Claims'}
				</h3>
				<div class="grid gap-2 sm:grid-cols-2">
					<div>
						<p class="text-xs font-medium text-gray-600 dark:text-gray-400">ID Token:</p>
						<p class="text-xs text-gray-500 dark:text-gray-500">
							roles, scoped_roles, user_type, org_id, org_name, plan, org_type, orgs,
							relationships_summary
						</p>
					</div>
					<div>
						<p class="text-xs font-medium text-gray-600 dark:text-gray-400">Access Token:</p>
						<p class="text-xs text-gray-500 dark:text-gray-500">
							roles, scoped_roles, org_id, org_type, permissions, org_context
						</p>
					</div>
				</div>
			</div>
		</div>
	</Card>

	<!-- Policy Embedding Documentation -->
	{#if enablePolicyEmbedding}
		<Card>
			<h2 class="mb-4 text-lg font-semibold text-gray-900 dark:text-white">
				{$LL.admin_policy_embedding_info?.() || 'Policy Embedding Information'}
			</h2>
			<div class="space-y-3 text-sm text-gray-600 dark:text-gray-400">
				<p>
					{$LL.admin_policy_embedding_info_desc?.() ||
						"When enabled, the authorization server evaluates requested scopes against the user's permissions and embeds only permitted actions in the Access Token."}
				</p>
				<div class="rounded-lg bg-gray-100 p-3 font-mono text-xs dark:bg-gray-800">
					<p class="text-gray-500">
						// Example: User requests scope="openid documents:read documents:write users:manage"
					</p>
					<p class="text-gray-500">
						// User has permissions: ["documents:read", "documents:write"]
					</p>
					<p class="mt-2 text-gray-700 dark:text-gray-300">&#123;</p>
					<p class="ml-4 text-gray-700 dark:text-gray-300">
						"authrim_permissions": ["documents:read", "documents:write"]
					</p>
					<p class="ml-4 text-gray-500">
						// users:manage is excluded because user doesn't have that permission
					</p>
					<p class="text-gray-700 dark:text-gray-300">&#125;</p>
				</div>
			</div>
		</Card>
	{/if}
</div>
