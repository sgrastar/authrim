<script lang="ts">
	import { onMount } from 'svelte';
	import { Button, Card, Spinner } from '$lib/components';
	import LanguageSwitcher from '$lib/components/LanguageSwitcher.svelte';
	import { CheckCircle, User, Building2, ExternalLink } from 'lucide-svelte';
	import * as m from '$lib/paraglide/messages';

	interface ConsentData {
		clientName: string;
		clientLogo?: string;
		clientUri?: string;
		policyUri?: string;
		tosUri?: string;
		scopes: string[];
		user: {
			email: string;
			name?: string;
			picture?: string;
		};
	}

	let loading = $state(true);
	let allowLoading = $state(false);
	let denyLoading = $state(false);
	let consentData = $state<ConsentData | null>(null);
	let error = $state('');

	onMount(async () => {
		await loadConsentData();
	});

	async function loadConsentData() {
		try {
			// TODO: Implement consent data loading
			// 1. Call GET /auth/consent with session
			// 2. Load client metadata and scopes
			// 3. Load current user info
			// 4. Display consent screen

			// Placeholder for now
			await new Promise(resolve => setTimeout(resolve, 1000));

			// Mock data (replace with actual API call)
			consentData = {
				clientName: 'Example Application',
				clientLogo: undefined,
				clientUri: 'https://example.com',
				policyUri: 'https://example.com/privacy',
				tosUri: 'https://example.com/terms',
				scopes: ['openid', 'profile', 'email', 'offline_access'],
				user: {
					email: 'user@example.com',
					name: 'John Doe',
					picture: undefined
				}
			};

			loading = false;
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to load consent data';
			loading = false;
		}
	}

	function getScopeLabel(scope: string): string {
		const scopeLabels: Record<string, () => string> = {
			openid: m.consent_scope_openid,
			profile: m.consent_scope_profile,
			email: m.consent_scope_email,
			phone: m.consent_scope_phone,
			address: m.consent_scope_address,
			offline_access: m.consent_scope_offline_access
		};

		return scopeLabels[scope]?.() || scope;
	}

	async function handleAllow() {
		allowLoading = true;

		try {
			// TODO: Implement consent approval
			// 1. Call POST /auth/consent with { decision: 'allow' }
			// 2. Redirect to client with authorization code

			// Placeholder for now
			await new Promise(resolve => setTimeout(resolve, 1000));
			console.log('Consent allowed');

			// TODO: Redirect to client with authorization code
			// window.location.href = redirectUri + '?code=' + code;
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to approve consent';
		} finally {
			allowLoading = false;
		}
	}

	async function handleDeny() {
		denyLoading = true;

		try {
			// TODO: Implement consent denial
			// 1. Call POST /auth/consent with { decision: 'deny' }
			// 2. Redirect to client with error

			// Placeholder for now
			await new Promise(resolve => setTimeout(resolve, 1000));
			console.log('Consent denied');

			// TODO: Redirect to client with error
			// window.location.href = redirectUri + '?error=access_denied';
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to deny consent';
		} finally {
			denyLoading = false;
		}
	}

	function handleSwitchAccount() {
		// Redirect to logout and then login
		window.location.href = '/logout?redirect_uri=' + encodeURIComponent(window.location.href);
	}
</script>

<svelte:head>
	<title>{m.consent_title({ clientName: consentData?.clientName || '' })} - {m.app_title()}</title>
</svelte:head>

<div class="min-h-screen bg-gray-50 dark:bg-gray-900 flex flex-col items-center justify-center px-4 py-12">
	<!-- Language Switcher (Top Right) -->
	<div class="absolute top-4 right-4">
		<LanguageSwitcher />
	</div>

	<!-- Main Card -->
	<div class="w-full max-w-2xl">
		{#if loading}
			<!-- Loading State -->
			<Card class="text-center py-12">
				<Spinner size="xl" color="primary" class="mb-4" />
				<p class="text-gray-600 dark:text-gray-400">{m.common_loading()}</p>
			</Card>
		{:else if consentData}
			<!-- Consent Screen -->
			<Card>
				<!-- Client Logo and Name -->
				<div class="text-center mb-6">
					{#if consentData.clientLogo}
						<img
							src={consentData.clientLogo}
							alt={consentData.clientName}
							class="h-16 w-16 mx-auto mb-4 rounded-lg"
						/>
					{:else}
						<div class="h-16 w-16 mx-auto mb-4 rounded-lg bg-primary-100 dark:bg-primary-900/30 flex items-center justify-center">
							<Building2 class="h-8 w-8 text-primary-600 dark:text-primary-400" />
						</div>
					{/if}

					<h2 class="text-2xl font-semibold text-gray-900 dark:text-white mb-2">
						{m.consent_title({ clientName: consentData.clientName })}
					</h2>

					<p class="text-gray-600 dark:text-gray-400 text-sm">
						{m.consent_subtitle()}
					</p>

					{#if consentData.clientUri}
					<!-- svelte-ignore svelte/no-navigation-without-resolve -->
						<a
							href={consentData.clientUri}
							target="_blank"
							rel="noopener noreferrer"
							class="inline-flex items-center gap-1 text-sm text-primary-600 hover:text-primary-500 dark:text-primary-400 dark:hover:text-primary-300 mt-2"
						>
							{consentData.clientUri}
							<ExternalLink class="h-3 w-3" />
						</a>
					{/if}
				</div>

				<div class="border-t border-gray-200 dark:border-gray-700 pt-6 mb-6">
					<!-- Scopes -->
					<h3 class="text-sm font-medium text-gray-900 dark:text-white mb-4">
						{m.consent_scopesTitle()}
					</h3>

					<ul class="space-y-3 mb-6">
						{#each consentData.scopes as scope (scope)}
							<li class="flex items-start gap-3">
								<CheckCircle class="h-5 w-5 text-success-600 dark:text-success-400 flex-shrink-0 mt-0.5" />
								<span class="text-gray-700 dark:text-gray-300 text-sm">
									{getScopeLabel(scope)}
								</span>
							</li>
						{/each}
					</ul>

					<!-- User Info -->
					<div class="bg-gray-50 dark:bg-gray-800 rounded-lg p-4">
						<p class="text-xs text-gray-500 dark:text-gray-400 mb-2">
							{m.consent_userInfo()}
						</p>

						<div class="flex items-center gap-3">
							{#if consentData.user.picture}
								<img
									src={consentData.user.picture}
									alt={consentData.user.name || consentData.user.email}
									class="h-10 w-10 rounded-full"
								/>
							{:else}
								<div class="h-10 w-10 rounded-full bg-primary-100 dark:bg-primary-900/30 flex items-center justify-center">
									<User class="h-5 w-5 text-primary-600 dark:text-primary-400" />
								</div>
							{/if}

							<div>
								{#if consentData.user.name}
									<p class="text-sm font-medium text-gray-900 dark:text-white">
										{consentData.user.name}
									</p>
								{/if}
								<p class="text-sm text-gray-600 dark:text-gray-400">
									{consentData.user.email}
								</p>
							</div>
						</div>

						<button
							type="button"
							onclick={handleSwitchAccount}
							class="text-xs text-primary-600 hover:text-primary-500 dark:text-primary-400 dark:hover:text-primary-300 mt-2"
						>
							{m.consent_notYou()}
						</button>
					</div>
				</div>

				<!-- Action Buttons -->
				<div class="flex gap-3">
					<Button
						variant="secondary"
						class="flex-1"
						loading={denyLoading}
						disabled={allowLoading}
						onclick={handleDeny}
					>
						{m.consent_denyButton()}
					</Button>

					<Button
						variant="primary"
						class="flex-1"
						loading={allowLoading}
						disabled={denyLoading}
						onclick={handleAllow}
					>
						{m.consent_allowButton()}
					</Button>
				</div>

				<!-- Privacy Policy and ToS Links -->
				{#if consentData.policyUri || consentData.tosUri}
					<div class="flex items-center justify-center gap-4 mt-4 text-xs text-gray-500 dark:text-gray-400">
						{#if consentData.policyUri}
					<!-- svelte-ignore svelte/no-navigation-without-resolve -->
							<a
								href={consentData.policyUri}
								target="_blank"
								rel="noopener noreferrer"
								class="hover:text-primary-600 dark:hover:text-primary-400 inline-flex items-center gap-1"
							>
								{m.consent_privacyPolicy()}
								<ExternalLink class="h-3 w-3" />
							</a>
						{/if}
						{#if consentData.tosUri}
					<!-- svelte-ignore svelte/no-navigation-without-resolve -->
							<a
								href={consentData.tosUri}
								target="_blank"
								rel="noopener noreferrer"
								class="hover:text-primary-600 dark:hover:text-primary-400 inline-flex items-center gap-1"
							>
								{m.consent_termsOfService()}
								<ExternalLink class="h-3 w-3" />
							</a>
						{/if}
					</div>
				{/if}
			</Card>
		{:else}
			<!-- Error State -->
			<Card class="text-center py-12">
				<p class="text-error-600 dark:text-error-400">{error || 'Failed to load consent data'}</p>
			</Card>
		{/if}
	</div>

	<!-- Footer -->
	<footer class="mt-12 text-center text-xs text-gray-500 dark:text-gray-500">
		<p>{m.footer_stack()}</p>
	</footer>
</div>
