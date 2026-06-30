<script lang="ts">
	import { Button, Card, Alert } from '$lib/components';
	import LanguageSwitcher from '$lib/components/LanguageSwitcher.svelte';
	import { LL } from '$i18n/i18n-svelte';
	import { accountAPI } from '$lib/api/account';
	import { emailCodeAPI } from '$lib/api/client';
	import {
		flowRuntimeAPI,
		type FlowRuntimeStartResponse,
		type FlowRuntimeStep
	} from '$lib/api/flow-runtime';
	import { messageForApiError } from '$lib/errors/sdk-error-mapper';
	import { brandingStore } from '$lib/stores/branding.svelte';
	import { auth } from '$lib/stores/auth';
	import { isValidRedirectUrl, isValidReturnUrl } from '$lib/utils/url-validation';
	import { createPinInput, melt } from '@melt-ui/svelte';
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import {
		LOGIN_UI_LEGACY_SESSION_STORAGE_KEYS,
		LOGIN_UI_SESSION_STORAGE_KEYS,
		consumeLoginUiSessionItem,
		getLoginUiSessionItem,
		removeLoginUiSessionItems
	} from '$lib/authrim/storage-keys';
	import {
		consumeFlowRuntimeState,
		persistFlowRuntimeState
	} from '$lib/authrim/flow-runtime-state';

	let email = $state('');
	let inviteToken = $state('');
	let authorizationChallengeId = $state('');
	let samlRequestId = $state('');
	let samlSpEntityId = $state('');
	let returnTo = $state('');
	let accountReturn = $state('');
	let runtimeInteractionId = $state('');
	let runtimeFlowKind = $state<'login' | 'registration'>('login');
	let error = $state('');
	let success = $state('');
	let loading = $state(false);
	let resendLoading = $state(false);
	let countdown = $state(60);
	let canResend = $state(false);
	let intervalId: number | null = null;

	function getApiErrorMessage(apiError: Parameters<typeof messageForApiError>[0]): string {
		return messageForApiError(apiError, {
			unknown: () => $LL.error_unknown(),
			invalidRequest: () => $LL.error_invalid_request(),
			accessDenied: () => $LL.error_access_denied(),
			serverError: () => $LL.error_server_error(),
			loginRequired: () => $LL.error_login_required(),
			emailCodeInvalid: () => $LL.emailCode_errorInvalid()
		});
	}

	function getStoredCustomFields(): Record<string, unknown> | undefined {
		try {
			const raw =
				getLoginUiSessionItem(LOGIN_UI_SESSION_STORAGE_KEYS.signupCustomFields) ??
				consumeLoginUiSessionItem(LOGIN_UI_LEGACY_SESSION_STORAGE_KEYS.signupCustomFields);
			if (!raw) {
				return undefined;
			}

			const parsed = JSON.parse(raw);
			if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
				return undefined;
			}

			return parsed as Record<string, unknown>;
		} catch {
			return undefined;
		}
	}

	// Melt UI Pin Input - 6 digits
	const {
		elements: { root, input, hiddenInput },
		states: { value }
	} = createPinInput({
		placeholder: '0',
		type: 'text',
		defaultValue: []
	});

	// Watch for PIN input value changes and auto-submit when complete
	$effect(() => {
		const code = $value.join('');
		if (code.length === 6 && !loading && !success) {
			handleVerify(code);
		}
	});

	onMount(() => {
		// Get email and invite_token from URL parameters
		email = $page.url.searchParams.get('email') || '';
		inviteToken = $page.url.searchParams.get('invite_token') || '';
		authorizationChallengeId = $page.url.searchParams.get('challenge_id') || '';
		samlRequestId = $page.url.searchParams.get('saml_request_id') || '';
		samlSpEntityId = $page.url.searchParams.get('saml_sp_entity_id') || '';
		returnTo = $page.url.searchParams.get('return_to') || '';
		accountReturn = $page.url.searchParams.get('account_return') || '';
		runtimeInteractionId = $page.url.searchParams.get('runtime_interaction_id') || '';
		runtimeFlowKind =
			$page.url.searchParams.get('runtime_flow_kind') === 'registration' ? 'registration' : 'login';

		// If no email, redirect to login
		if (!email) {
			window.location.href = '/login';
			return;
		}

		// Start countdown timer
		startCountdown();

		return () => {
			if (intervalId !== null) {
				clearInterval(intervalId);
			}
		};
	});

	function startCountdown() {
		countdown = 60;
		canResend = false;

		if (intervalId !== null) {
			clearInterval(intervalId);
		}

		intervalId = window.setInterval(() => {
			countdown -= 1;

			if (countdown <= 0) {
				if (intervalId !== null) {
					clearInterval(intervalId);
					intervalId = null;
				}
				canResend = true;
			}
		}, 1000);
	}

	async function handleVerify(code?: string) {
		// Prevent concurrent submissions (race condition: auto-verify + button click)
		if (loading) return;

		const verifyCode = code || $value.join('');

		// Validate code is 6 digits
		if (!/^\d{6}$/.test(verifyCode)) {
			error = $LL.emailCode_errorInvalid();
			return;
		}

		error = '';
		loading = true;

		try {
			const { data: verifyData, error: apiError } = await emailCodeAPI.verify({
				code: verifyCode,
				email,
				authorizationChallengeId: authorizationChallengeId || undefined
			});

			if (apiError) {
				// Use generic error message for all failures to avoid
				// leaking session state information (e.g., session_mismatch)
				error = getApiErrorMessage(apiError);
				// Clear the input on error
				value.set([]);
				return;
			}

			// Success
			success = $LL.emailCode_success();
			try {
				removeLoginUiSessionItems([
					LOGIN_UI_SESSION_STORAGE_KEYS.signupCustomFields,
					LOGIN_UI_LEGACY_SESSION_STORAGE_KEYS.signupCustomFields
				]);
			} catch {
				// Non-fatal
			}

			// Restore authenticated state from the HttpOnly managed session cookie.
			await auth.refreshFromSession();

			const postVerifyRedirect = await resolveRuntimePostEmailRedirect(verifyData?.redirect_url);

			// Redirect after delay. OAuth/OIDC challenges resume /authorize via the server-provided URL.
			setTimeout(() => {
				window.location.href = postVerifyRedirect;
			}, 2000);
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.emailCode_errorInvalid();
			value.set([]);
		} finally {
			loading = false;
		}
	}

	async function resolveAccountReturnRedirect(): Promise<string | null> {
		if (!accountReturn) return null;
		const result = await accountAPI.consumeAccountReturn(accountReturn);
		const redirectUrl = result.data?.redirect_url;
		return redirectUrl && isValidReturnUrl(redirectUrl) ? redirectUrl : null;
	}

	async function buildPostAuthRedirect(redirectUrl?: string): Promise<string> {
		if (returnTo === 'saml_sso' && samlRequestId && samlSpEntityId) {
			const params = new URLSearchParams({
				saml_request_id: samlRequestId,
				saml_sp_entity_id: samlSpEntityId,
				return_to: 'saml_sso'
			});
			return `/saml/idp/sso?${params.toString()}`;
		}

		const accountReturnRedirect = await resolveAccountReturnRedirect();
		if (accountReturnRedirect) {
			return accountReturnRedirect;
		}

		if (returnTo && isValidReturnUrl(returnTo)) {
			return returnTo;
		}

		if (redirectUrl && isValidRedirectUrl(redirectUrl)) {
			return redirectUrl;
		}

		return '/';
	}

	function getRuntimeCurrentStep(flow: FlowRuntimeStartResponse): FlowRuntimeStep | null {
		const currentStepId = flow.interaction.current_step_id;
		if (!currentStepId) return null;
		return flow.contract.ui.steps.find((step) => step.id === currentStepId) ?? null;
	}

	function getRuntimeResumePath(): string {
		return runtimeFlowKind === 'registration' ? '/signup' : '/login';
	}

	async function resolveRuntimePostEmailRedirect(redirectUrl?: string): Promise<string> {
		const postAuthRedirect = await buildPostAuthRedirect(redirectUrl);
		if (!runtimeInteractionId) {
			return postAuthRedirect;
		}

		const storedRuntime = consumeFlowRuntimeState(runtimeInteractionId);
		if (!storedRuntime) {
			throw new Error($LL.error_invalid_request());
		}

		const { data: resumedFlow, error: resumeError } = await flowRuntimeAPI.start({
			resume_interaction_id: storedRuntime.interaction_id,
			contract_hash: storedRuntime.contract_hash,
			signature: storedRuntime.signature
		});
		if (resumeError || !resumedFlow) {
			throw new Error(resumeError?.error_description || $LL.error_invalid_request());
		}

		let flow: FlowRuntimeStartResponse = resumedFlow;
		let guard = 0;
		while (guard < 10) {
			guard += 1;
			if (flow.interaction.state === 'completed') {
				consumeFlowRuntimeState(flow.interaction.id);
				return postAuthRedirect;
			}

			const step = getRuntimeCurrentStep(flow);
			if (!step) {
				throw new Error($LL.error_invalid_request());
			}

			if (step.render !== false && step.component !== 'email_verification') {
				if (!persistFlowRuntimeState(flow, { postAuthRedirect })) {
					throw new Error($LL.error_invalid_request());
				}
				return `${getRuntimeResumePath()}?runtime_interaction_id=${encodeURIComponent(
					flow.interaction.id
				)}`;
			}

			const { data: submittedFlow, error: submitError } = await flowRuntimeAPI.submit(
				flow.interaction.id,
				{
					step_id: step.id,
					node_id: step.source_node_id,
					selected_handle: step.component === 'email_verification' ? 'verified' : undefined,
					contract_hash: flow.contract_hash,
					signature: flow.signature
				}
			);
			if (submitError || !submittedFlow) {
				throw new Error(submitError?.error_description || $LL.error_invalid_request());
			}

			flow = {
				...flow,
				interaction: submittedFlow.interaction
			};
			if (submittedFlow.completed || flow.interaction.state === 'completed') {
				consumeFlowRuntimeState(flow.interaction.id);
				return postAuthRedirect;
			}
		}

		throw new Error($LL.error_invalid_request());
	}

	async function handleResend() {
		resendLoading = true;
		error = '';

		try {
			const { error: apiError } = await emailCodeAPI.send({
				email,
				invite_token: inviteToken || undefined,
				custom_fields: getStoredCustomFields()
			});

			if (apiError) {
				throw new Error(getApiErrorMessage(apiError));
			}

			// Clear the input
			value.set([]);

			// Show success message
			success = $LL.emailCode_resendSuccess();

			// Restart countdown timer
			startCountdown();

			// Clear success message after delay
			setTimeout(() => {
				if (success === $LL.emailCode_resendSuccess()) {
					success = '';
				}
			}, 3000);
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to resend code';
		} finally {
			resendLoading = false;
		}
	}
</script>

<svelte:head>
	<title>{$LL.emailCode_title()} - {brandingStore.brandName || $LL.app_title()}</title>
</svelte:head>

<div class="auth-page">
	<LanguageSwitcher />

	<!-- Main Card -->
	<div class="auth-container">
		<!-- Header -->
		<div class="auth-header">
			<h1 class="auth-header__title">
				{brandingStore.brandName || $LL.app_title()}
			</h1>
			<p class="auth-header__subtitle">
				{$LL.app_subtitle()}
			</p>
		</div>

		<!-- Verification Card -->
		<Card class="mb-6">
			<!-- Icon -->
			<div class="auth-icon-badge">
				<div class="auth-icon-badge__circle">
					<div class="i-heroicons-envelope-solid h-9 w-9 auth-icon-badge__icon"></div>
				</div>
			</div>

			<!-- Title -->
			<h2 class="auth-section-title text-center">
				{$LL.emailCode_title()}
			</h2>

			<!-- Email -->
			<div class="mb-6 text-center">
				<p style="color: var(--text-secondary); margin-bottom: 8px;">
					{$LL.emailCode_subtitle()}
				</p>
				<p class="text-lg font-medium break-all" style="color: var(--text-primary);">
					{email}
				</p>
			</div>

			<!-- Instructions -->
			<div class="auth-binding-message mb-6">
				<p class="text-sm" style="color: var(--text-secondary);">
					{$LL.emailCode_instructions()}
				</p>
			</div>

			<!-- Success Message -->
			{#if success}
				<Alert variant="success" dismissible={true} onDismiss={() => (success = '')} class="mb-4">
					{success}
				</Alert>
			{/if}

			<!-- Error Message -->
			{#if error}
				<Alert variant="error" dismissible={true} onDismiss={() => (error = '')} class="mb-4">
					{error}
				</Alert>
			{/if}

			<!-- Pin Input -->
			<div class="mb-6">
				<div
					class="block text-sm font-medium mb-2 text-center"
					style="color: var(--text-secondary);"
				>
					{$LL.emailCode_codeLabel()}
				</div>

				<div use:melt={$root} class="flex gap-2 items-center justify-center">
					{#each Array.from({ length: 6 }, (_, i) => i) as i (i)}
						<input
							use:melt={$input()}
							aria-label={$LL.emailCode_digitLabel({ position: i + 1 })}
							autocomplete="one-time-code"
							inputmode="numeric"
							pattern="[0-9]*"
							class="auth-pin-cell"
							maxlength="1"
							disabled={loading || !!success}
						/>
					{/each}
				</div>

				<input use:melt={$hiddenInput} />
			</div>

			<!-- Verify Button -->
			<Button
				variant="primary"
				class="w-full mb-4"
				disabled={$value.join('').length !== 6 || loading || !!success}
				{loading}
				onclick={() => handleVerify()}
			>
				{$LL.emailCode_verifyButton()}
			</Button>

			<!-- Resend Button -->
			<Button
				variant="secondary"
				class="w-full"
				disabled={!canResend || resendLoading || !!success}
				loading={resendLoading}
				onclick={handleResend}
			>
				{#if canResend || resendLoading}
					{$LL.emailCode_resendButton()}
				{:else}
					{$LL.emailCode_resendTimer({ seconds: countdown })}
				{/if}
			</Button>
		</Card>

		<!-- Back to Login Link -->
		<p class="auth-bottom-link">
			<a href="/login" class="inline-flex items-center gap-2">
				<span class="i-heroicons-arrow-left h-4 w-4"></span>
				{$LL.common_backToLogin()}
			</a>
		</p>
	</div>

	<!-- Footer -->
	<footer class="auth-footer">
		<p>{$LL.footer_stack()}</p>
	</footer>
</div>
