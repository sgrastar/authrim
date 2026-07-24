<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import { Button, Card, Alert } from '$lib/components';
	import LanguageSwitcher from '$lib/components/LanguageSwitcher.svelte';
	import { useLoginUIStores } from '$lib/stores/login-ui-context';
	import { LL } from '$i18n/i18n-svelte';
	import { deviceFlowAPI } from '$lib/api/client';
	import { isValidRedirectUrl, isValidImageUrl, isValidLinkUrl } from '$lib/utils/url-validation';

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
	interface DeviceInfo {
		client_name: string;
		client_uri?: string;
		logo_uri?: string;
		scopes: string[];
	}
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
				throw new Error($LL.device_errorInvalidOrExpiredCode());
			}
			if (data) {
				deviceInfo = data as DeviceInfo;
				step = 'verified';
			}
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.device_errorVerifyFailed();
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
				throw new Error($LL.device_errorApproveFailed());
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
			error = err instanceof Error ? err.message : $LL.device_errorApproveFailed();
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
				throw new Error($LL.device_errorDenyFailed());
			}
			window.location.href = '/';
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.device_errorDenyFailed();
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

<div class="auth-page">
	<LanguageSwitcher />

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

		<Card class="mb-6">
			<!-- Icon -->
			<div class="auth-icon-badge">
				<div class="auth-icon-badge__circle">
					<div class="i-heroicons-device-phone-mobile h-9 w-9 auth-icon-badge__icon"></div>
				</div>
			</div>

			{#if step === 'input'}
				<!-- Step 1: Enter device code -->
				<h2 class="auth-section-title text-center">
					{$LL.device_title()}
				</h2>
				<p class="auth-section-subtitle text-center mb-6">
					{$LL.device_subtitle()}
				</p>

				{#if error}
					<Alert variant="error" dismissible={true} onDismiss={() => (error = '')} class="mb-4">
						{error}
					</Alert>
				{/if}

				<div class="mb-6">
					<label
						for="user-code"
						class="block text-sm font-medium mb-2"
						style="color: var(--text-secondary);"
					>
						{$LL.device_codeLabel()}
					</label>
					<input
						id="user-code"
						type="text"
						class="auth-code-input"
						placeholder={$LL.device_codePlaceholder()}
						maxlength="9"
						value={userCode}
						oninput={handleCodeInput}
						onkeypress={handleKeyPress}
						autocomplete="off"
						spellcheck="false"
						aria-describedby="device-code-hint"
					/>
					<p
						id="device-code-hint"
						class="text-xs text-center mt-2"
						style="color: var(--text-muted);"
					>
						{$LL.device_codeHint()}
					</p>
				</div>

				<Button
					variant="primary"
					class="w-full"
					loading={verifying}
					disabled={userCode.replace(/-/g, '').length !== 8}
					onclick={handleVerify}
				>
					{$LL.device_verifyButton()}
				</Button>
			{:else if step === 'verified'}
				<!-- Step 2: Approve/Deny device -->
				<h2 class="auth-section-title text-center">
					{$LL.device_confirmTitle()}
				</h2>

				{#if success}
					<Alert variant="success" class="mt-4">
						{success}
					</Alert>
				{:else}
					{#if error}
						<Alert
							variant="error"
							dismissible={true}
							onDismiss={() => (error = '')}
							class="mt-4 mb-4"
						>
							{error}
						</Alert>
					{/if}

					{#if deviceInfo}
						<div class="auth-info-box mt-6 mb-6">
							<div class="flex items-center gap-3 mb-3">
								{#if deviceInfo.logo_uri && isValidImageUrl(deviceInfo.logo_uri)}
									<img
										src={deviceInfo.logo_uri}
										alt={deviceInfo.client_name}
										class="h-10 w-10 rounded-lg"
									/>
								{/if}
								<div>
									<p class="auth-info-box__value">
										{deviceInfo.client_name}
									</p>
									{#if deviceInfo.client_uri && isValidLinkUrl(deviceInfo.client_uri)}
										<a
											href={deviceInfo.client_uri}
											target="_blank"
											rel="noopener noreferrer"
											class="text-xs"
											style="color: var(--primary);"
										>
											{deviceInfo.client_uri}
										</a>
									{/if}
								</div>
							</div>

							{#if deviceInfo.scopes && deviceInfo.scopes.length > 0}
								<p class="auth-info-box__label mb-2">
									{$LL.device_requestedPermissions()}
								</p>
								<ul class="auth-scopes-list">
									{#each deviceInfo.scopes as scope (scope)}
										<li>
											<div class="i-heroicons-check-circle h-4 w-4 auth-scopes-list__icon"></div>
											{scope}
										</li>
									{/each}
								</ul>
							{/if}
						</div>
					{/if}

					<div class="auth-actions">
						<Button variant="secondary" class="flex-1" disabled={loading} onclick={handleDeny}>
							{$LL.device_denyButton()}
						</Button>
						<Button variant="primary" class="flex-1" {loading} onclick={handleApprove}>
							{$LL.device_approveButton()}
						</Button>
					</div>
				{/if}
			{/if}
		</Card>

		<!-- Back to Home -->
		<p class="auth-bottom-link">
			<a href="/">
				{$LL.common_backToHome()}
			</a>
		</p>
	</div>

	<!-- Footer -->
	<footer class="auth-footer">
		<p>{$LL.footer_stack()}</p>
	</footer>
</div>
