<script lang="ts">
	import AuthPageShell from '$lib/components/AuthPageShell.svelte';
	import VerifyEmailCodeView from '$lib/views/VerifyEmailCodeView.svelte';
	import { LL } from '$i18n/i18n-svelte';
	import { accountAPI } from '$lib/api/account';
	import { emailCodeAPI } from '$lib/api/client';
	import {
		flowRuntimeAPI,
		type FlowRuntimeStartResponse,
		type FlowRuntimeStep
	} from '$lib/api/flow-runtime';
	import { messageForApiError } from '$lib/errors/sdk-error-mapper';
	import { loginUiDisplayError, messageForCaughtError } from '$lib/errors/display-error';
	import { useLoginUIStores } from '$lib/stores/login-ui-context';
	import { auth } from '$lib/stores/auth';
	import { isValidRedirectUrl, isValidReturnUrl } from '$lib/utils/url-validation';
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
		peekFlowRuntimeState,
		persistFlowRuntimeState
	} from '$lib/authrim/flow-runtime-state';
	import { completionRedirect } from '$lib/authrim/completion-redirect';

	const { brandingStore } = useLoginUIStores();

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
	let resendNotice = $state('');
	let loading = $state(false);
	let resendLoading = $state(false);
	let countdown = $state(60);
	let canResend = $state(false);
	let intervalId: number | null = null;
	let code = $state('');

	function getApiErrorMessage(apiError: Parameters<typeof messageForApiError>[0]): string {
		return messageForApiError(apiError, {
			unknown: () => $LL.error_unknown(),
			invalidRequest: () => $LL.error_invalid_request(),
			accessDenied: () => $LL.error_access_denied(),
			unauthorizedClient: () => $LL.error_unauthorized_client(),
			unsupportedResponseType: () => $LL.error_unsupported_response_type(),
			invalidScope: () => $LL.error_invalid_scope(),
			serverError: () => $LL.error_server_error(),
			temporarilyUnavailable: () => $LL.error_temporarily_unavailable(),
			requestExpired: () => $LL.error_authorizationRequestExpired(),
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

	// Watch for PIN input value changes and auto-submit when complete
	$effect(() => {
		if (code.length === 6 && !loading && !resendLoading && !success) {
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

	async function handleVerify(codeValue?: string) {
		// Prevent concurrent submissions (race condition: auto-verify + button click)
		if (loading) return;

		const verifyCode = codeValue || code;

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
				authorizationChallengeId: authorizationChallengeId || undefined,
				deferAuthorizationContinuation: Boolean(runtimeInteractionId)
			});

			if (apiError) {
				// Use generic error message for all failures to avoid
				// leaking session state information (e.g., session_mismatch)
				error = getApiErrorMessage(apiError);
				// Clear the input on error
				code = '';
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

			let postVerifyRedirect: string;
			try {
				postVerifyRedirect = await resolveRuntimePostEmailRedirect(verifyData?.redirect_url);
			} catch (resumeError) {
				// The code is spent and the session exists, but the Flow could not be finished just
				// now. Its stored state is still there: the sign-in page resumes it, and tries again
				// to submit the completion, with the session.
				if (!runtimeInteractionId || !peekFlowRuntimeState(runtimeInteractionId)) {
					throw resumeError;
				}
				postVerifyRedirect = `${getRuntimeResumePath()}?runtime_interaction_id=${encodeURIComponent(
					runtimeInteractionId
				)}`;
			}

			// Redirect after delay. OAuth/OIDC challenges resume /authorize via the server-provided URL.
			setTimeout(() => {
				window.location.href = postVerifyRedirect;
			}, 2000);
		} catch (err) {
			error = messageForCaughtError(err, $LL.emailCode_errorInvalid());
			code = '';
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

		// Left in place until the interaction is complete (or handed on): a resume that fails for a
		// moment is tried again from it.
		const storedRuntime = peekFlowRuntimeState(runtimeInteractionId);
		if (!storedRuntime) {
			throw loginUiDisplayError($LL.error_invalid_request());
		}

		const { data: resumedFlow, error: resumeError } = await flowRuntimeAPI.start({
			resume_interaction_id: storedRuntime.interaction_id,
			contract_hash: storedRuntime.contract_hash,
			signature: storedRuntime.signature
		});
		if (resumeError || !resumedFlow) {
			throw loginUiDisplayError($LL.error_invalid_request());
		}

		// The resume signed the contract again as it is now, and the server keeps that one: it is
		// what the next resume, and the submits below, have to present, so it is stored first.
		if (!persistFlowRuntimeState(resumedFlow, { postAuthRedirect })) {
			throw loginUiDisplayError($LL.error_invalid_request());
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
				throw loginUiDisplayError($LL.error_invalid_request());
			}

			// The completion waits for this sign-in (the method was chosen before the code was
			// sent): the session exists now, so it is submitted here rather than at another page.
			if (
				step.render !== false &&
				step.component !== 'email_verification' &&
				step.component !== 'completion'
			) {
				if (!persistFlowRuntimeState(flow, { postAuthRedirect })) {
					throw loginUiDisplayError($LL.error_invalid_request());
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
					selected_handle:
						step.component === 'email_verification'
							? 'verified'
							: step.component === 'completion'
								? 'completed'
								: undefined,
					contract_hash: flow.contract_hash,
					signature: flow.signature
				}
			);
			if (submitError || !submittedFlow) {
				throw loginUiDisplayError($LL.error_invalid_request());
			}

			flow = {
				...flow,
				interaction: submittedFlow.interaction
			};
			if (submittedFlow.completed || flow.interaction.state === 'completed') {
				consumeFlowRuntimeState(flow.interaction.id);
				return completionRedirect(submittedFlow.output, postAuthRedirect);
			}
		}

		throw loginUiDisplayError($LL.error_invalid_request());
	}

	async function handleResend() {
		resendLoading = true;
		error = '';
		resendNotice = '';

		try {
			const { error: apiError } = await emailCodeAPI.send({
				email,
				invite_token: inviteToken || undefined,
				authorizationChallengeId: authorizationChallengeId || undefined,
				custom_fields: getStoredCustomFields(),
				deferAuthorizationContinuation: Boolean(runtimeInteractionId),
				runtimeInteractionId: runtimeInteractionId || undefined
			});

			if (apiError) {
				throw loginUiDisplayError(getApiErrorMessage(apiError));
			}

			// Clear the input
			code = '';

			// Show success message
			resendNotice = $LL.emailCode_resendSuccess();

			// Restart countdown timer
			startCountdown();

			// Clear success message after delay
			setTimeout(() => {
				if (resendNotice === $LL.emailCode_resendSuccess()) {
					resendNotice = '';
				}
			}, 3000);
		} catch (err) {
			error = messageForCaughtError(err, $LL.error_unknown());
		} finally {
			resendLoading = false;
		}
	}
</script>

<svelte:head>
	<title>{$LL.emailCode_title()} - {brandingStore.brandName || $LL.app_title()}</title>
</svelte:head>

<AuthPageShell>
	<VerifyEmailCodeView
		{email}
		{code}
		{countdown}
		{canResend}
		{loading}
		{resendLoading}
		{error}
		{success}
		{resendNotice}
		onCodeChange={(nextValue) => (code = nextValue)}
		onVerify={() => handleVerify()}
		onResend={handleResend}
		onDismissError={() => (error = '')}
		onDismissSuccess={() => (success = '')}
		onDismissResendNotice={() => (resendNotice = '')}
	/>
</AuthPageShell>
