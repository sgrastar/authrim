<script lang="ts">
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { startAuthentication } from '@simplewebauthn/browser';
	import { adminAuthAPI, getAuthErrorMessage } from '$lib/api/admin-auth';
	import {
		resolveAdminAgentLoginHandoffId,
		resolveAdminLoginReturnTo
	} from '$lib/admin/admin-login-return';
	import { adminAuth } from '$lib/stores/admin-auth.svelte';
	import { adminBrandStore } from '$lib/stores/admin-brand.svelte';
	import { LL } from '$i18n/i18n-svelte';

	let error = $state('');
	let loading = $state(false);

	function safeReturnTo(): string {
		return resolveAdminLoginReturnTo(window.location.search, window.location.origin);
	}

	async function resumeAfterLogin(): Promise<void> {
		const handoffId = resolveAdminAgentLoginHandoffId(window.location.search);
		if (handoffId) {
			const consumeUrl = await adminAuthAPI.approveAgentLoginHandoff(handoffId);
			// Do not retain the one-time code URL behind the Admin login page in browser history.
			window.location.replace(consumeUrl);
			return;
		}
		const destination = safeReturnTo();
		const resolved = new URL(destination, window.location.origin);
		await goto(`${resolved.pathname}${resolved.search}${resolved.hash}`);
	}

	onMount(async () => {
		if (!resolveAdminAgentLoginHandoffId(window.location.search)) return;
		loading = true;
		try {
			const session = await adminAuthAPI.checkSession();
			if (!session) return;
			await adminAuth.checkAuth();
			await resumeAfterLogin();
		} catch (err) {
			error = getAuthErrorMessage(err);
		} finally {
			loading = false;
		}
	});

	async function handlePasskeyLogin() {
		error = '';
		loading = true;

		try {
			// Step 1: Get WebAuthn login options from server
			const { options, challengeId } = await adminAuthAPI.getLoginOptions();

			// Step 2: Perform WebAuthn authentication (browser prompt)
			const credential = await startAuthentication({ optionsJSON: options });

			// Step 3: Verify credential with server
			await adminAuthAPI.verifyLogin(challengeId, credential);

			// Step 4: Refresh session-backed auth state, including tenant context and roles.
			await adminAuth.checkAuth();

			// Step 5: Resume a bounded browser authorization journey or open the dashboard.
			await resumeAfterLogin();
		} catch (err) {
			console.error('Login error:', err);
			error = getAuthErrorMessage(err);
			// Debug: show actual error in development
			if (err instanceof Error && err.message) {
				error += ` (${err.name}: ${err.message})`;
			}
		} finally {
			loading = false;
		}
	}
</script>

<svelte:head>
	<title>{$LL.admin_login_page_title()}</title>
</svelte:head>

<div class="login-page">
	<div class="bg-watermark" aria-hidden="true">{adminBrandStore.name}</div>

	<div class="login-container">
		<div class="login-card">
			<div class="login-header">
				{#if adminBrandStore.logoUrl}
					<img
						class="login-logo"
						src={adminBrandStore.logoUrl}
						alt={adminBrandStore.logoAlt}
						loading="eager"
					/>
				{/if}
				<h1 class="login-title">{adminBrandStore.name}</h1>
				<p class="login-subtitle">{$LL.admin_login_panel()}</p>
			</div>

			{#if error}
				<div class="error-message">
					<i class="i-ph-warning-circle w-4 h-4 flex-shrink-0"></i>
					<span>{error}</span>
				</div>
			{/if}

			<button type="button" class="passkey-btn" onclick={handlePasskeyLogin} disabled={loading}>
				{#if loading}
					<i class="i-ph-circle-notch animate-spin w-5 h-5"></i>
					<span>{$LL.admin_login_authenticating()}</span>
				{:else}
					<i class="i-ph-fingerprint w-5 h-5"></i>
					<span>{$LL.admin_login_with_passkey()}</span>
				{/if}
			</button>

			<p class="login-hint">{$LL.admin_login_hint()}</p>
		</div>
	</div>
</div>

<style>
	.login-page {
		position: relative;
		min-height: 100vh;
		display: flex;
		align-items: center;
		justify-content: center;
		overflow: hidden;
		background: var(--color-bg-page);
		color: var(--color-text);
	}

	.bg-watermark {
		position: fixed;
		top: -16%;
		left: -5%;
		font-family: var(--font-brand, var(--font-display));
		font-size: clamp(26rem, 25vw, 28rem);
		font-weight: var(--brand-weight, 300);
		color: var(--color-text);
		opacity: var(--login-watermark-opacity, 0.04);
		letter-spacing: var(--login-watermark-letter-spacing, var(--brand-letter-spacing, 0.1em));
		white-space: nowrap;
		pointer-events: none;
		z-index: 0;
		user-select: none;
		line-height: 1;
	}

	.login-container {
		position: relative;
		z-index: 1;
		width: 100%;
		max-width: 420px;
		padding: 24px;
	}

	.login-card {
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: var(--login-card-radius, var(--radius-panel, var(--radius-xl)));
		padding: var(--login-card-padding, 48px 40px);
		box-shadow: var(--login-card-shadow, var(--shadow-panel, var(--shadow-xl)));
		backdrop-filter: var(--login-card-backdrop-filter, var(--blur-md, none));
		text-align: center;
	}

	.login-header {
		margin-bottom: 40px;
	}

	.login-logo {
		display: block;
		width: var(--login-logo-width, 64px);
		height: var(--login-logo-height, 64px);
		object-fit: contain;
		margin: 0 auto 18px;
	}

	.login-title {
		font-family: var(--font-brand, var(--font-display));
		font-size: var(--login-brand-size, 2.25rem);
		font-weight: var(--brand-weight, 300);
		color: var(--color-text);
		letter-spacing: var(--login-brand-letter-spacing, var(--brand-letter-spacing, 0.3em));
		margin: 0 0 10px;
		padding-left: var(--login-brand-letter-spacing, var(--brand-letter-spacing, 0.3em));
		line-height: 1.2;
	}

	.login-subtitle {
		font-size: 0.875rem;
		color: var(--color-text-muted);
		margin: 0;
		font-family: var(--font-meta, var(--font-body));
		letter-spacing: var(--field-label-letter-spacing, 0.05em);
		text-transform: uppercase;
		font-weight: 500;
	}

	.error-message {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		background: color-mix(in srgb, var(--color-danger) 12%, var(--color-surface));
		border: 1px solid color-mix(in srgb, var(--color-danger) 42%, var(--color-border));
		color: var(--color-danger);
		padding: 12px 16px;
		border-radius: var(--radius-control, var(--radius-md));
		margin-bottom: 24px;
		font-size: 0.875rem;
		text-align: left;
	}

	.passkey-btn {
		width: 100%;
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 10px;
		padding: 14px 24px;
		font-size: 1rem;
		font-weight: 600;
		background: var(--button-primary-bg, var(--color-accent));
		color: var(--button-primary-color, var(--color-accent-contrast));
		border: var(--login-passkey-border, none);
		border-radius: var(--login-passkey-radius, var(--radius-control, var(--radius-md)));
		cursor: pointer;
		transition:
			opacity var(--transition-fast),
			transform var(--transition-fast),
			box-shadow var(--transition-fast);
		letter-spacing: 0;
		box-shadow: var(
			--login-passkey-shadow,
			0 4px 16px color-mix(in srgb, var(--color-accent) 28%, transparent)
		);
	}

	.passkey-btn:hover:not(:disabled) {
		opacity: 0.9;
		transform: translateY(-1px);
		box-shadow: var(
			--login-passkey-hover-shadow,
			0 8px 24px color-mix(in srgb, var(--color-accent) 32%, transparent)
		);
	}

	.passkey-btn:active:not(:disabled) {
		transform: translateY(0);
		box-shadow: 0 2px 8px color-mix(in srgb, var(--color-accent) 22%, transparent);
	}

	.passkey-btn:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}

	.login-hint {
		margin: 24px 0 0;
		color: var(--color-text-subtle);
		font-size: 0.8rem;
		line-height: 1.6;
	}

	@media (max-width: 520px) {
		.login-container {
			padding: 16px;
		}

		.login-card {
			padding: var(--login-card-mobile-padding, 36px 24px);
		}

		.login-title {
			font-size: var(--login-brand-mobile-size, 1.85rem);
			overflow-wrap: anywhere;
		}
	}
</style>
