<script lang="ts">
	import { goto } from '$app/navigation';
	import { startAuthentication } from '@simplewebauthn/browser';
	import { adminAuthAPI, getAuthErrorMessage } from '$lib/api/admin-auth';
	import { adminAuth } from '$lib/stores/admin-auth.svelte';

	let error = $state('');
	let loading = $state(false);

	async function handlePasskeyLogin() {
		error = '';
		loading = true;

		try {
			// Step 1: Get WebAuthn login options from server
			const { options, challengeId } = await adminAuthAPI.getLoginOptions();

			// Step 2: Perform WebAuthn authentication (browser prompt)
			const credential = await startAuthentication({ optionsJSON: options });

			// Step 3: Verify credential with server
			const result = await adminAuthAPI.verifyLogin(challengeId, credential);

			// Step 4: Update auth store with user info. Session credentials stay in HttpOnly cookies.
			adminAuth.setAuthenticated({
				userId: result.userId,
				email: result.user.email || '',
				name: result.user.name || undefined,
				roles: ['admin'] // Roles will be fetched on next session check
			});

			// Step 5: Redirect to admin dashboard
			goto('/admin');
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
	<title>Admin Login - Authrim</title>
</svelte:head>

<div class="login-page">
	<!-- Background watermark -->
	<div class="bg-watermark" aria-hidden="true">Authrim</div>

	<div class="login-container">
		<div class="login-card">
			<div class="login-header">
				<h1 class="login-title">Authrim</h1>
				<p class="login-subtitle">Admin Panel</p>
			</div>

			{#if error}
				<div class="error-message">
					<i class="i-ph-warning-circle w-4 h-4 flex-shrink-0"></i>
					<span>{error}</span>
				</div>
			{/if}

			<button class="passkey-btn" onclick={handlePasskeyLogin} disabled={loading}>
				{#if loading}
					<i class="i-ph-circle-notch animate-spin w-5 h-5"></i>
					<span>Authenticating...</span>
				{:else}
					<i class="i-ph-fingerprint w-5 h-5"></i>
					<span>Login with Passkey</span>
				{/if}
			</button>

			<p class="login-hint">Only administrators with registered Passkeys can access this area.</p>
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
	}

	.bg-watermark {
		position: fixed;
		top: -16%;
		left: -5%;
		font-family: Didot, 'Didot LT STD', 'Palatino Linotype', Palatino, 'Book Antiqua', serif;
		font-size: clamp(26rem, 25vw, 28rem);
		font-weight: 300;
		color: var(--text-primary);
		opacity: 0.04;
		letter-spacing: 0.1em;
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
		background: var(--bg-card);
		border: 1px solid var(--border-glass);
		border-radius: var(--radius-xl);
		padding: 48px 40px;
		box-shadow: var(--shadow-xl);
		backdrop-filter: var(--blur-md);
		text-align: center;
	}

	.login-header {
		margin-bottom: 40px;
	}

	.login-title {
		font-family: Didot, 'Didot LT STD', 'Palatino Linotype', Palatino, 'Book Antiqua', serif;
		font-size: 2.25rem;
		font-weight: 300;
		color: var(--text-primary);
		letter-spacing: 0.3em;
		margin: 0 0 10px 0.3em; /* letter-spacing分だけ右にオフセット */
		line-height: 1.2;
	}

	.login-subtitle {
		font-size: 0.875rem;
		color: var(--text-secondary);
		margin: 0;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		font-weight: 500;
	}

	.error-message {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		background: var(--danger-light);
		border: 1px solid rgba(239, 68, 68, 0.3);
		color: var(--danger);
		padding: 12px 16px;
		border-radius: var(--radius-md);
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
		background: var(--gradient-primary);
		color: #fff;
		border: none;
		border-radius: var(--radius-md);
		cursor: pointer;
		transition:
			opacity var(--transition-fast),
			transform var(--transition-fast),
			box-shadow var(--transition-fast);
		letter-spacing: -0.01em;
		box-shadow: 0 4px 16px var(--primary-glow);
	}

	.passkey-btn:hover:not(:disabled) {
		opacity: 0.9;
		transform: translateY(-1px);
		box-shadow: 0 8px 24px var(--primary-glow);
	}

	.passkey-btn:active:not(:disabled) {
		transform: translateY(0);
		box-shadow: 0 2px 8px var(--primary-glow);
	}

	.passkey-btn:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}

	.login-hint {
		margin: 24px 0 0;
		color: var(--text-muted);
		font-size: 0.8rem;
		line-height: 1.6;
	}
</style>
