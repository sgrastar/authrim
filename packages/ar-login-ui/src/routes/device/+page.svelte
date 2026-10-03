<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import AuthPageShell from '$lib/components/AuthPageShell.svelte';
	import DeviceView, { type DeviceInfo } from '$lib/views/DeviceView.svelte';
	import { useLoginUIStores } from '$lib/stores/login-ui-context';
	import { LL } from '$i18n/i18n-svelte';
	import { deviceFlowAPI } from '$lib/api/client';
	import { loginUiDisplayError, messageForCaughtError } from '$lib/errors/display-error';
	import { isValidRedirectUrl } from '$lib/utils/url-validation';

	const { brandingStore } = useLoginUIStores();

	// ---------------------------------------------------------------------------
	// State
	// ---------------------------------------------------------------------------
	let userCode = $state('');
	let loading = $state(false);
	let verifying = $state(false);
	let error = $state('');
	let success = $state('');
	let step = $state<'input' | 'verified'>('input');

	// Device info (loaded after verification)
	let deviceInfo = $state<DeviceInfo | null>(null);

	// ---------------------------------------------------------------------------
	// Lifecycle
	// ---------------------------------------------------------------------------
	onMount(() => {
		const code = $page.url.searchParams.get('user_code');
		if (code) {
			userCode = code.toUpperCase();
		}
	});

	// ---------------------------------------------------------------------------
	// Handlers
	// ---------------------------------------------------------------------------
	function formatUserCode(value: string): string {
		const clean = value.replace(/[^A-Z0-9]/gi, '').toUpperCase();
		if (clean.length > 4) {
			return clean.slice(0, 4) + '-' + clean.slice(4, 8);
		}
		return clean;
	}

	function handleCodeInput(event: Event) {
		const target = event.target as HTMLInputElement;
		const formatted = formatUserCode(target.value);
		userCode = formatted;
		target.value = formatted;
	}

	async function handleVerify() {
		const cleanCode = userCode.replace(/-/g, '');
		if (cleanCode.length !== 8) {
			error = $LL.device_errorInvalidCode();
			return;
		}

		error = '';
		verifying = true;

		try {
			const { data, error: apiError } = await deviceFlowAPI.verify(cleanCode);
			if (apiError) {
				throw loginUiDisplayError($LL.device_errorInvalidOrExpiredCode());
			}
			if (data) {
				deviceInfo = data as DeviceInfo;
				step = 'verified';
			}
		} catch (err) {
			error = messageForCaughtError(err, $LL.device_errorVerifyFailed());
		} finally {
			verifying = false;
		}
	}

	async function handleApprove() {
		if (loading) return;
		loading = true;
		error = '';

		try {
			const cleanCode = userCode.replace(/-/g, '');
			const { data, error: apiError } = await deviceFlowAPI.approve(cleanCode);
			if (apiError) {
				throw loginUiDisplayError($LL.device_errorApproveFailed());
			}
			if (!data?.redirect_url) {
				success = $LL.device_success();
			} else if (!isValidRedirectUrl(data.redirect_url)) {
				error = $LL.device_errorInvalidRedirect();
			} else {
				success = $LL.device_success();
				const url = data.redirect_url;
				setTimeout(() => {
					window.location.href = url;
				}, 2000);
			}
		} catch (err) {
			error = messageForCaughtError(err, $LL.device_errorApproveFailed());
		} finally {
			loading = false;
		}
	}

	async function handleDeny() {
		if (loading) return;
		loading = true;
		error = '';

		try {
			const cleanCode = userCode.replace(/-/g, '');
			const { error: apiError } = await deviceFlowAPI.deny(cleanCode);
			if (apiError) {
				throw loginUiDisplayError($LL.device_errorDenyFailed());
			}
			window.location.href = '/';
		} catch (err) {
			error = messageForCaughtError(err, $LL.device_errorDenyFailed());
		} finally {
			loading = false;
		}
	}

	function handleKeyPress(event: KeyboardEvent) {
		if (event.key === 'Enter') {
			handleVerify();
		}
	}
</script>

<svelte:head>
	<title>{$LL.device_title()} - {brandingStore.brandName || $LL.app_title()}</title>
</svelte:head>

<AuthPageShell>
	<DeviceView
		{step}
		{userCode}
		{error}
		{success}
		{verifying}
		{loading}
		{deviceInfo}
		onCodeInput={handleCodeInput}
		onKeyPress={handleKeyPress}
		onVerify={handleVerify}
		onApprove={handleApprove}
		onDeny={handleDeny}
		onDismissError={() => (error = '')}
	/>
</AuthPageShell>
