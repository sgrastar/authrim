<script lang="ts">
	import { Button, Card, Alert } from '$lib/components';
	import LanguageSwitcher from '$lib/components/LanguageSwitcher.svelte';
	import { LL } from '$i18n/i18n-svelte';
	import { deviceFlowAPI } from '$lib/api/client';
	import { createPinInput, melt } from '@melt-ui/svelte';
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import * as QRCode from 'qrcode';

	let error = $state('');
	let success = $state('');
	let loading = $state(false);
	let userCode = $state('');
	let qrCodeDataUrl = $state('');
	let verificationUrl = $state('');

	// Melt UI Pin Input - 8 cells (XXXX-XXXX)
	const {
		elements: { root, input, hiddenInput },
		states: { value }
	} = createPinInput({
		placeholder: '0',
		type: 'text',
		defaultValue: []
	});

	// Watch for PIN input value changes
	$effect(() => {
		// Convert array of characters to string
		const pinValue = $value.join('').toUpperCase();

		// Format as XXXX-XXXX (add hyphen after 4th character)
		if (pinValue.length > 4) {
			userCode = pinValue.slice(0, 4) + '-' + pinValue.slice(4, 8);
		} else {
			userCode = pinValue;
		}
	});

	// Generate QR code when user code changes
	$effect(() => {
		if (typeof window !== 'undefined' && userCode && userCode.replace(/-/g, '').length === 8) {
			// Build verification URL with the current user code
			const baseUrl = window.location.origin + window.location.pathname;
			verificationUrl = `${baseUrl}?user_code=${userCode}`;

			// Generate QR code
			QRCode.toDataURL(verificationUrl, {
				width: 256,
				margin: 2,
				color: {
					dark: '#000000',
					light: '#FFFFFF'
				}
			})
				.then((url) => {
					qrCodeDataUrl = url;
				})
				.catch((err) => {
					console.error('QR code generation failed:', err);
				});
		}
	});

	// Pre-fill code from URL query parameter
	onMount(() => {
		const codeParam = $page.url.searchParams.get('user_code');
		if (codeParam) {
			// Remove hyphen and split into characters
			const cleanCode = codeParam.replace(/-/g, '').toUpperCase();
			// Set initial value for pin input
			value.set(cleanCode.split('').slice(0, 8));
		}
	});

	async function handleApprove() {
		error = '';
		success = '';

		// Validate code is 8 characters (excluding hyphen)
		const cleanCode = userCode.replace(/-/g, '');
		if (cleanCode.length !== 8) {
			error = $LL.device_errorCodeRequired();
			return;
		}

		loading = true;

		try {
			const { data, error: apiError } = await deviceFlowAPI.verifyDeviceCode(userCode, true);

			if (apiError) {
				// Handle specific error codes
				if (apiError.error === 'invalid_code') {
					error = $LL.device_errorInvalidCode();
				} else if (apiError.error_description?.includes('already been')) {
					error = $LL.device_errorAlreadyUsed();
				} else {
					error = apiError.error_description || $LL.device_errorGeneric();
				}
				return;
			}

			// Success
			success = data?.message || $LL.device_success();
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.device_errorGeneric();
		} finally {
			loading = false;
		}
	}

	async function handleDeny() {
		error = '';
		success = '';

		// Validate code
		const cleanCode = userCode.replace(/-/g, '');
		if (cleanCode.length !== 8) {
			error = $LL.device_errorCodeRequired();
			return;
		}

		loading = true;

		try {
			const { data, error: apiError } = await deviceFlowAPI.verifyDeviceCode(userCode, false);

			if (apiError) {
				error = apiError.error_description || $LL.device_errorGeneric();
				return;
			}

			// Denied successfully
			success = data?.message || $LL.device_denied();
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.device_errorGeneric();
		} finally {
			loading = false;
		}
	}
</script>

<div class="min-h-screen bg-gray-50 dark:bg-gray-900 flex flex-col items-center justify-center p-4">
	<!-- Language Switcher -->
	<div class="absolute top-4 right-4">
		<LanguageSwitcher />
	</div>

	<!-- Main Card -->
	<Card class="w-full max-w-md">
		<div class="text-center mb-8">
			<div class="text-5xl mb-4">🔐</div>
			<h1 class="text-2xl font-bold text-gray-900 dark:text-white mb-2">
				{$LL.device_title()}
			</h1>
			<p class="text-sm text-gray-600 dark:text-gray-400">
				{$LL.device_instructions()}
			</p>
		</div>

		<!-- Alerts -->
		{#if error}
			<Alert variant="error" class="mb-6">
				{error}
			</Alert>
		{/if}

		{#if success}
			<Alert variant="success" class="mb-6">
				{success}
			</Alert>
		{/if}

		<!-- QR Code Section -->
		{#if qrCodeDataUrl}
			<div class="mb-6">
				<div class="text-center">
					<p class="text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">
						{$LL.device_qrCodeLabel()}
					</p>
					<div class="flex justify-center mb-3">
						<img
							src={qrCodeDataUrl}
							alt="QR Code for device verification"
							class="border-4 border-gray-200 dark:border-gray-700 rounded-xl shadow-lg"
							width="256"
							height="256"
						/>
					</div>
					<p class="text-xs text-gray-500 dark:text-gray-400 break-all px-4">
						{verificationUrl}
					</p>
				</div>
			</div>

			<!-- Divider -->
			<div class="relative mb-6">
				<div class="absolute inset-0 flex items-center">
					<div class="w-full border-t border-gray-300 dark:border-gray-600"></div>
				</div>
				<div class="relative flex justify-center text-sm">
					<span class="px-4 bg-white dark:bg-gray-800 text-gray-500 dark:text-gray-400">
						{$LL.device_orManual()}
					</span>
				</div>
			</div>
		{/if}

		<!-- Pin Input -->
		<div class="mb-6">
			<div class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
				{$LL.device_codeLabel()}
			</div>

			<div use:melt={$root} role="group" aria-label={$LL.device_codeLabel()} class="flex gap-2 items-center justify-center">
				{#each Array.from({ length: 8 }, (_, i) => i) as i (i)}
					<!-- Add hyphen separator after 4th digit -->
					{#if i === 4}
						<div class="text-2xl font-bold text-gray-400 px-1">-</div>
					{/if}

					<input
						use:melt={$input()}
						class="w-12 h-14 text-center text-xl font-bold border-2 border-gray-300 dark:border-gray-600 rounded-lg
						       focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20
						       bg-white dark:bg-gray-800 text-gray-900 dark:text-white
						       transition-all uppercase"
						maxlength="1"
					/>
				{/each}
			</div>

			<input use:melt={$hiddenInput} />

			<p class="text-xs text-gray-500 dark:text-gray-400 text-center mt-2">
				{$LL.device_codePlaceholder()}
			</p>
		</div>

		<!-- Action Buttons -->
		<div class="flex gap-3">
			<Button
				variant="primary"
				size="lg"
				class="flex-1"
				disabled={loading || userCode.replace(/-/g, '').length !== 8}
				onclick={handleApprove}
			>
				{loading ? $LL.common_loading() : $LL.device_approveButton()}
			</Button>

			<Button
				variant="ghost"
				size="lg"
				class="flex-1"
				disabled={loading || userCode.replace(/-/g, '').length !== 8}
				onclick={handleDeny}
			>
				{$LL.device_denyButton()}
			</Button>
		</div>
	</Card>

	<!-- Footer -->
	<div class="mt-8 text-center text-sm text-gray-600 dark:text-gray-400">
		<p>{$LL.footer_stack()}</p>
	</div>
</div>

<style>
	/* Additional styling for pin input cells */
	:global(.pin-input-cell:focus) {
		@apply ring-2 ring-primary-500 border-primary-500;
	}
</style>
