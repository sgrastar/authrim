<script lang="ts">
	import { onMount } from 'svelte';
	import { Card, Alert, Spinner } from '$lib/components';
	import LanguageSwitcher from '$lib/components/LanguageSwitcher.svelte';
	import { LL } from '$i18n/i18n-svelte';
	import { brandingStore } from '$lib/stores/branding.svelte';
	import { isValidReturnUrl } from '$lib/utils/url-validation';
	import { getAuthConfig } from '$lib/auth';
	import { auth } from '$lib/stores/auth';
	import { API_BASE_URL } from '$lib/api/client';

	let status = $state<'processing' | 'success' | 'error'>('processing');
	let errorMessage = $state('');
	let errorCode = $state('');

	/**
	 * Handle Smart Handoff SSO callback
	 */
	async function handleHandoffCallback(
		params: URLSearchParams,
		handoffToken: string
	): Promise<void> {
		const state = params.get('state');

		console.log('[Authrim] Handoff callback detected');

		// Remove handoff token from URL immediately (Referrer leak prevention)
		history.replaceState(null, '', window.location.pathname);

		// Note: State validation is performed server-side (ar-bridge)
		// ar-bridge validates state when generating handoff token
		// Client-side state validation is optional and skipped here

		try {
			const authConfig = getAuthConfig();

			// Verify handoff token with Authrim AS (via EXTERNAL_IDP worker)
			const response = await fetch(`${authConfig.issuer}/auth/external/handoff/verify`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json'
				},
				body: JSON.stringify({
					handoff_token: handoffToken,
					state: state,
					client_id: authConfig.clientId
				})
			});

			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				console.error('[Authrim] Handoff verification failed:', data);
				errorCode = data.error || 'handoff_verification_failed';
				errorMessage = data.error_description || 'Handoff token verification failed';
				status = 'error';
				return;
			}

			const tokenData = await response.json();

			// Store session (same pattern as Passkey login)
			if (tokenData.session && tokenData.user) {
				auth.login(tokenData.session.id, {
					userId: tokenData.user.id,
					email: tokenData.user.email,
					name: tokenData.user.name
				});
			}

			// Clean up session storage (except oauth_return_url, used below)
			sessionStorage.removeItem('pkce_code_verifier');
			sessionStorage.removeItem('oauth_provider_id');

			console.log('[Authrim] Handoff login successful');

			status = 'success';

			// Redirect to stored return URL or home
			const storedReturnUrl = sessionStorage.getItem('oauth_return_url');
			sessionStorage.removeItem('oauth_return_url');
			const returnUrl =
				storedReturnUrl && isValidReturnUrl(storedReturnUrl) ? storedReturnUrl : '/';

			setTimeout(() => {
				window.location.href = returnUrl;
			}, 1000);
		} catch (error) {
			console.error('[Authrim] Handoff error:', error);
			errorCode = 'network_error';
			errorMessage = 'An error occurred during handoff authentication';
			status = 'error';
		}
	}

	onMount(async () => {
		const params = new URLSearchParams(window.location.search);

		// Check for error response from the OP
		const error = params.get('error');
		if (error) {
			errorCode = error;
			errorMessage = params.get('error_description') || getErrorMessage(error);
			status = 'error';
			return;
		}

		// Check for handoff token (Smart Handoff SSO)
		const handoffToken = params.get('handoff_token');
		if (handoffToken) {
			await handleHandoffCallback(params, handoffToken);
			return;
		}

		// Extract authorization code and state
		const code = params.get('code');
		const state = params.get('state');

		if (!code) {
			errorCode = 'missing_code';
			errorMessage = $LL.callback_errorMissingCode();
			status = 'error';
			return;
		}

		// Retrieve code_verifier and provider_id from sessionStorage (Client ↔ Authrim PKCE)
		// Note: state validation is performed server-side (ar-bridge)
		let codeVerifier: string | null = null;
		let providerId: string | null = null;

		try {
			codeVerifier = sessionStorage.getItem('pkce_code_verifier');
			providerId = sessionStorage.getItem('oauth_provider_id');

			if (codeVerifier) {
				// Clean up OAuth session data immediately after reading
				sessionStorage.removeItem('pkce_code_verifier');
				sessionStorage.removeItem('oauth_provider_id');
			} else {
				// Log debug info when code_verifier is not found
				console.warn('PKCE code_verifier not found in sessionStorage');
				const debugInfo = {
					hasCode: !!code,
					hasState: !!state,
					origin: window.location.origin,
					referrer: document.referrer,
					hasProviderId: !!providerId
				};
				console.debug('OAuth callback debug info:', debugInfo);
			}
		} catch (storageError) {
			console.error('Failed to access session storage:', storageError);
			errorCode = 'storage_unavailable';
			errorMessage = $LL.callback_errorStorageUnavailable();
			status = 'error';
			return;
		}

		// PKCE code_verifier is required for external IdP login
		if (!codeVerifier) {
			errorCode = 'missing_code_verifier';
			errorMessage = $LL.callback_errorMissingCodeVerifier();
			status = 'error';
			return;
		}

		try {
			// バックエンドAPI直接呼び出し（Passkeyと同じパターン）
			const authConfig = getAuthConfig();

			const requestBody: {
				grant_type: 'authorization_code';
				code: string;
				client_id: string;
				code_verifier: string;
				provider_id?: string;
			} = {
				grant_type: 'authorization_code',
				code,
				client_id: authConfig.clientId,
				code_verifier: codeVerifier
			};

			// Add provider_id for external IdP logins
			if (providerId) {
				requestBody.provider_id = providerId;
			}

			const response = await fetch(`${API_BASE_URL}/api/v1/auth/direct/token`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json'
				},
				body: JSON.stringify(requestBody)
			});

			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				errorCode = data.error || 'callback_failed';
				errorMessage = data.error_description || $LL.callback_errorExchangeFailed();
				status = 'error';
				return;
			}

			const tokenData = await response.json();

			// auth.login()でセッション保存（Passkeyと同じパターン）
			if (tokenData.session && tokenData.user) {
				auth.login(tokenData.session.id, {
					userId: tokenData.user.id,
					email: tokenData.user.email,
					name: tokenData.user.name
				});
			}

			status = 'success';

			// Redirect to the stored return URL or home
			const storedReturnUrl = sessionStorage.getItem('oauth_return_url');
			sessionStorage.removeItem('oauth_return_url');
			// SECURITY: Only allow same-origin return URLs to prevent open redirect
			const returnUrl =
				storedReturnUrl && isValidReturnUrl(storedReturnUrl) ? storedReturnUrl : '/';

			setTimeout(() => {
				window.location.href = returnUrl;
			}, 1000);
		} catch (error) {
			console.error('Token exchange error:', error);
			errorCode = 'network_error';
			errorMessage = $LL.callback_errorNetwork();
			status = 'error';
		}
	});

	function getErrorMessage(code: string): string {
		const messages: Record<string, () => string> = {
			access_denied: () => $LL.error_access_denied(),
			invalid_request: () => $LL.error_invalid_request(),
			server_error: () => $LL.error_server_error(),
			temporarily_unavailable: () => $LL.error_temporarily_unavailable(),
			login_required: () => $LL.error_login_required()
		};
		return (messages[code] || (() => $LL.error_unknown()))();
	}

	function handleRetry() {
		window.location.href = '/login';
	}
</script>

<svelte:head>
	<title>{$LL.callback_title()} - {brandingStore.brandName || $LL.app_title()}</title>
</svelte:head>

<div class="auth-page">
	<LanguageSwitcher />

	<div class="auth-container">
		<!-- Header -->
		<div class="auth-header">
			<h1 class="auth-header__title">
				{brandingStore.brandName || $LL.app_title()}
			</h1>
		</div>

		<Card class="text-center">
			{#if status === 'processing'}
				<!-- Processing -->
				<div class="py-8">
					<Spinner size="lg" color="primary" class="mb-4" />
					<h2 class="auth-section-title text-center">
						{$LL.callback_processing()}
					</h2>
					<p class="auth-section-subtitle text-center">
						{$LL.callback_pleaseWait()}
					</p>
				</div>
			{:else if status === 'success'}
				<!-- Success -->
				<div class="py-8">
					<div class="auth-icon-badge">
						<div class="auth-icon-badge__circle">
							<span class="i-heroicons-check-circle h-9 w-9 auth-icon-badge__icon"></span>
						</div>
					</div>
					<h2 class="auth-section-title text-center">
						{$LL.callback_success()}
					</h2>
					<p class="auth-section-subtitle text-center">
						{$LL.callback_redirecting()}
					</p>
				</div>
			{:else}
				<!-- Error -->
				<div class="auth-icon-badge">
					<div class="auth-icon-badge__circle auth-icon-badge__circle--danger">
						<span class="i-heroicons-exclamation-circle h-9 w-9 auth-icon-badge__icon"></span>
					</div>
				</div>

				<h2 class="auth-section-title text-center">
					{$LL.callback_errorTitle()}
				</h2>

				<Alert variant="error" class="mb-4 text-left">
					<p>{errorMessage}</p>
				</Alert>

				{#if errorCode}
					<div class="auth-error-code-box mb-6">
						<p class="auth-error-code-box__label">
							{$LL.error_errorCode()}
						</p>
						<p class="auth-error-code-box__value">
							{errorCode}
						</p>
					</div>
				{/if}

				<button class="btn-primary w-full" onclick={handleRetry}>
					{$LL.common_backToLogin()}
				</button>
			{/if}
		</Card>
	</div>

	<!-- Footer -->
	<footer class="auth-footer">
		<p>{$LL.footer_stack()}</p>
	</footer>
</div>
