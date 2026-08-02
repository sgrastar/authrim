<script lang="ts">
	import { onMount } from 'svelte';
	import { Card, Alert, Spinner } from '$lib/components';
	import LanguageSwitcher from '$lib/components/LanguageSwitcher.svelte';
	import FooterText from '$lib/components/FooterText.svelte';
	import { LL } from '$i18n/i18n-svelte';
	import { useLoginUIStores } from '$lib/stores/login-ui-context';
	import { isValidRedirectUrl, isValidReturnUrl } from '$lib/utils/url-validation';
	import { getAuthConfig } from '$lib/auth';
	import { auth } from '$lib/stores/auth';
	import { API_BASE_URL } from '$lib/api/client';
	import { authrimFetch } from '$lib/authrim/fetch';
	import { assertNoBrowserTokenMaterial } from '$lib/authrim/session-profile';
	import { getDiagnosticLogger } from '$lib/stores/diagnostic';
	import {
		LOGIN_UI_LEGACY_SESSION_STORAGE_KEYS,
		LOGIN_UI_SESSION_STORAGE_KEYS,
		consumeLoginUiSessionItem,
		removeLoginUiSessionItems
	} from '$lib/authrim/storage-keys';
	import { updateFlowRuntimePostAuthRedirect } from '$lib/authrim/flow-runtime-state';

	const { brandingStore } = useLoginUIStores();

	let status = $state<'processing' | 'success' | 'error'>('processing');
	let errorCode = $state('');
	let errorMessage = $derived(getErrorMessage(errorCode));

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
			if (!state) {
				errorCode = 'missing_state';
				status = 'error';
				getDiagnosticLogger()?.logAuthDecision({
					decision: 'deny',
					reason: errorCode,
					flow: 'smart-handoff',
					context: { mode: 'cookie-only' }
				});
				return;
			}

			const authConfig = getAuthConfig();
			const finalizeResponse = await authrimFetch('/handoff/finalize', {
				baseUrl: API_BASE_URL,
				method: 'POST',
				headers: {
					'Content-Type': 'application/json'
				},
				body: JSON.stringify({
					handoff_token: handoffToken,
					state,
					client_id: authConfig.clientId
				})
			});

			if (!finalizeResponse.ok) {
				const data = await finalizeResponse.json().catch(() => ({}));
				errorCode = data.error || 'handoff_finalize_failed';
				status = 'error';
				getDiagnosticLogger()?.logAuthDecision({
					decision: 'deny',
					reason: errorCode,
					flow: 'smart-handoff',
					context: { mode: 'cookie-only', status: finalizeResponse.status }
				});
				return;
			}

			const finalizeData = await finalizeResponse.json().catch(() => ({}));
			try {
				assertNoBrowserTokenMaterial(finalizeData, 'handoff finalize');
			} catch {
				errorCode = 'handoff_finalize_invalid_response';
				status = 'error';
				getDiagnosticLogger()?.logAuthDecision({
					decision: 'deny',
					reason: errorCode,
					flow: 'smart-handoff',
					context: { mode: 'cookie-only' }
				});
				return;
			}

			await auth.refreshFromSession();

			if (!auth.checkAuth()) {
				errorCode = 'handoff_cookie_session_missing';
				status = 'error';
				getDiagnosticLogger()?.logAuthDecision({
					decision: 'deny',
					reason: errorCode,
					flow: 'smart-handoff',
					context: { mode: 'cookie-only' }
				});
				return;
			}

			// Clean up external login diagnostic state. The managed LoginUI flow never stores PKCE secrets.
			removeLoginUiSessionItems([
				LOGIN_UI_SESSION_STORAGE_KEYS.externalProviderId,
				LOGIN_UI_LEGACY_SESSION_STORAGE_KEYS.externalProviderId,
				LOGIN_UI_LEGACY_SESSION_STORAGE_KEYS.pkceCodeVerifier
			]);

			console.log('[Authrim] Handoff login successful');

			getDiagnosticLogger()?.logAuthDecision({
				decision: 'allow',
				reason: 'handoff_cookie_session_success',
				flow: 'smart-handoff',
				context: { mode: 'cookie-only' }
			});

			status = 'success';

			// Redirect to stored return URL or home
			const storedReturnUrl = consumeLoginUiSessionItem(
				LOGIN_UI_SESSION_STORAGE_KEYS.externalReturnUrl,
				[LOGIN_UI_LEGACY_SESSION_STORAGE_KEYS.externalReturnUrl]
			);
			const callbackReturnUrl = params.get('return_url');
			const finalizeRedirectUrl =
				typeof finalizeData?.redirect_url === 'string' ? finalizeData.redirect_url : null;
			const returnUrl =
				storedReturnUrl && isValidReturnUrl(storedReturnUrl)
					? storedReturnUrl
					: callbackReturnUrl && isValidReturnUrl(callbackReturnUrl)
						? callbackReturnUrl
						: finalizeRedirectUrl && isValidRedirectUrl(finalizeRedirectUrl)
							? finalizeRedirectUrl
							: '/';
			const runtimeInteractionId = consumeLoginUiSessionItem(
				LOGIN_UI_SESSION_STORAGE_KEYS.externalFlowRuntimeInteractionId
			);
			const runtimeFlowKind = consumeLoginUiSessionItem(
				LOGIN_UI_SESSION_STORAGE_KEYS.externalFlowRuntimeKind
			);
			const runtimeResumePath = runtimeFlowKind === 'registration' ? '/signup' : '/login';
			const runtimeReturnUrl =
				runtimeInteractionId && updateFlowRuntimePostAuthRedirect(runtimeInteractionId, returnUrl)
					? `${runtimeResumePath}?runtime_interaction_id=${encodeURIComponent(
							runtimeInteractionId
						)}`
					: null;

			setTimeout(() => {
				window.location.href = runtimeReturnUrl || returnUrl;
			}, 1000);
		} catch (error) {
			console.error('[Authrim] Handoff error:', error);
			errorCode = 'network_error';
			status = 'error';
			getDiagnosticLogger()?.logAuthDecision({
				decision: 'deny',
				reason: 'network_error',
				flow: 'smart-handoff'
			});
		}
	}

	async function handleProvisioningCallback(token: string, tenantId: string): Promise<void> {
		history.replaceState(null, '', window.location.pathname);
		const deadline = Date.now() + 5 * 60 * 1000;
		let pollingDelay = 250;
		try {
			while (Date.now() < deadline) {
				const response = await authrimFetch('/api/external/provisioning/status', {
					baseUrl: API_BASE_URL,
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ provisioning_token: token, tenant_id: tenantId })
				});
				const data = await response.json().catch(() => ({}));
				if (response.status === 202 && data.status === 'pending') {
					const serverRetryAfter =
						typeof data.retry_after_ms === 'number'
							? Math.min(2000, Math.max(250, data.retry_after_ms))
							: 500;
					pollingDelay = Math.min(2000, Math.max(serverRetryAfter, Math.ceil(pollingDelay * 1.5)));
					await new Promise((resolve) => setTimeout(resolve, pollingDelay));
					continue;
				}
				if (response.ok && data.status === 'ready' && typeof data.resume_url === 'string') {
					const apiOrigin = new URL(API_BASE_URL, window.location.origin).origin;
					const resumeUrl = new URL(data.resume_url, apiOrigin);
					if (
						resumeUrl.origin !== apiOrigin ||
						resumeUrl.pathname !== '/auth/external/provisioning/resume'
					) {
						throw new Error('invalid provisioning resume URL');
					}
					window.location.assign(resumeUrl.toString());
					return;
				}
				throw new Error('external provisioning failed');
			}
			throw new Error('external provisioning timed out');
		} catch {
			errorCode = 'temporarily_unavailable';
			status = 'error';
			getDiagnosticLogger()?.logAuthDecision({
				decision: 'deny',
				reason: 'external_idp_provisioning_resume_failed',
				flow: 'external_idp'
			});
		}
	}

	onMount(async () => {
		const params = new URLSearchParams(window.location.search);

		// Check for error response from the OP
		const error = params.get('error');
		if (error) {
			errorCode = error;
			status = 'error';
			return;
		}

		const provisioningToken = params.get('provisioning_token');
		const provisioningTenant = params.get('provisioning_tenant');
		if (provisioningToken && provisioningTenant) {
			await handleProvisioningCallback(provisioningToken, provisioningTenant);
			return;
		}

		// Check for handoff token (Smart Handoff SSO)
		const handoffToken = params.get('handoff_token');
		if (handoffToken) {
			await handleHandoffCallback(params, handoffToken);
			return;
		}

		// Built-in LoginUI is the managed browser session surface. It accepts
		// handoff_token callbacks and does not exchange OAuth code responses in JS.
		const code = params.get('code');
		if (code) {
			let providerId: string | null = null;
			try {
				providerId = consumeLoginUiSessionItem(LOGIN_UI_SESSION_STORAGE_KEYS.externalProviderId, [
					LOGIN_UI_LEGACY_SESSION_STORAGE_KEYS.externalProviderId
				]);
				removeLoginUiSessionItems([
					LOGIN_UI_LEGACY_SESSION_STORAGE_KEYS.pkceCodeVerifier,
					LOGIN_UI_SESSION_STORAGE_KEYS.externalFlowRuntimeInteractionId,
					LOGIN_UI_SESSION_STORAGE_KEYS.externalFlowRuntimeKind,
					LOGIN_UI_SESSION_STORAGE_KEYS.externalReturnUrl,
					LOGIN_UI_LEGACY_SESSION_STORAGE_KEYS.externalReturnUrl
				]);
			} catch {
				// Storage cleanup is best-effort after an unsupported callback shape.
			}
			errorCode = 'external_handoff_required';
			status = 'error';
			getDiagnosticLogger()?.logAuthDecision({
				decision: 'deny',
				reason: errorCode,
				flow: 'authorization_code',
				context: { provider_id: providerId ?? undefined }
			});
			return;
		}

		errorCode = 'missing_handoff_token';
		status = 'error';
	});

	function getErrorMessage(code: string): string {
		const messages: Record<string, () => string> = {
			access_denied: () => $LL.error_access_denied(),
			invalid_request: () => $LL.error_invalid_request(),
			missing_state: () => $LL.error_invalid_request(),
			unauthorized_client: () => $LL.error_unauthorized_client(),
			unsupported_response_type: () => $LL.error_unsupported_response_type(),
			invalid_scope: () => $LL.error_invalid_scope(),
			server_error: () => $LL.error_server_error(),
			handoff_finalize_invalid_response: () => $LL.error_server_error(),
			handoff_cookie_session_missing: () => $LL.error_server_error(),
			external_handoff_required: () => $LL.error_server_error(),
			temporarily_unavailable: () => $LL.error_temporarily_unavailable(),
			login_required: () => $LL.error_login_required(),
			missing_handoff_token: () => $LL.callback_errorMissingCode(),
			network_error: () => $LL.error_unknown()
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
		<FooterText value={$LL.footer_stack()} />
	</footer>
</div>
