<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { startRegistration } from '@simplewebauthn/browser';
	import { adminSetupAPI, SetupError, getSetupErrorMessage } from '$lib/api/setup';

	// State
	let status: 'loading' | 'ready' | 'registering' | 'success' | 'error' = $state('loading');
	let error = $state('');
	let user: { id: string; email: string; name: string | null } | null = $state(null);
	let token = $state('');

	onMount(async () => {
		// Get token from URL
		token = $page.url.searchParams.get('token') || '';

		if (!token) {
			status = 'error';
			error = 'No setup token provided. Please use the link from the initial setup.';
			return;
		}

		// Verify token
		try {
			const result = await adminSetupAPI.verifyToken(token);
			if (result.valid && result.user) {
				user = result.user;
				status = 'ready';
			} else {
				status = 'error';
				error = 'Invalid setup token.';
			}
		} catch (err) {
			status = 'error';
			error = getSetupErrorMessage(err);
		}
	});

	async function handlePasskeyRegistration() {
		if (!token || !user) return;

		status = 'registering';
		error = '';

		try {
			// Get current origin's hostname as RP ID
			const rpId = window.location.hostname;
			const origin = window.location.origin;

			// Step 1: Get passkey registration options
			const { options, challenge_id } = await adminSetupAPI.getPasskeyOptions(token, rpId);

			// Step 2: Perform WebAuthn registration (browser prompt)
			const credential = await startRegistration({ optionsJSON: options });

			// Step 3: Complete registration
			const result = await adminSetupAPI.completePasskeyRegistration(
				token,
				challenge_id,
				credential,
				origin
			);

			if (result.success) {
				status = 'success';
				// Redirect to login after 3 seconds
				setTimeout(() => {
					goto('/admin/login');
				}, 3000);
			} else {
				throw new SetupError('registration_failed', 'Passkey registration failed.');
			}
		} catch (err) {
			console.error('Passkey registration error:', err);
			status = 'ready'; // Allow retry
			error = getSetupErrorMessage(err);
		}
	}
</script>

<svelte:head>
	<title>Complete Setup - Authrim Admin</title>
</svelte:head>

<div class="setup-container">
	<div class="setup-card">
		<!-- Logo -->
		<div class="logo">
			<svg viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
				<circle cx="50" cy="50" r="45" fill="url(#grad)" />
				<path d="M35 55 L50 40 L65 55 L50 70 Z" fill="white" />
				<defs>
					<linearGradient id="grad" x1="0%" y1="0%" x2="100%" y2="100%">
						<stop offset="0%" style="stop-color:#667eea" />
						<stop offset="100%" style="stop-color:#764ba2" />
					</linearGradient>
				</defs>
			</svg>
		</div>

		{#if status === 'loading'}
			<h1>Verifying Setup Token...</h1>
			<div class="loading">
				<div class="spinner"></div>
				<p>Please wait while we verify your setup token.</p>
			</div>
		{:else if status === 'error'}
			<h1 class="error-title">Setup Error</h1>
			<div class="error-box">
				{error}
			</div>
			<div class="recovery-info">
				<p>If your setup token has expired, you can generate a new one using the CLI:</p>
				<code>npx @authrim/setup admin-passkey --env &lt;env&gt;</code>
			</div>
		{:else if status === 'ready'}
			<h1>Complete Admin Setup</h1>
			<p class="subtitle">Register your Passkey to enable login to Admin UI.</p>

			{#if user}
				<div class="user-info">
					<div class="info-row">
						<span class="label">Email:</span>
						<span class="value">{user.email}</span>
					</div>
					{#if user.name}
						<div class="info-row">
							<span class="label">Name:</span>
							<span class="value">{user.name}</span>
						</div>
					{/if}
					<div class="info-row">
						<span class="label">Role:</span>
						<span class="value">System Administrator</span>
					</div>
				</div>
			{/if}

			{#if error}
				<div class="error-box small">
					{error}
				</div>
			{/if}

			<button class="btn primary" onclick={handlePasskeyRegistration}>
				<svg
					class="btn-icon"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
				>
					<rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
					<circle cx="12" cy="16" r="1" />
					<path d="M7 11V7a5 5 0 0 1 10 0v4" />
				</svg>
				Register Passkey
			</button>

			<p class="hint">
				You can use a hardware security key (like YubiKey), fingerprint, face recognition, or a
				password manager like 1Password.
			</p>
		{:else if status === 'registering'}
			<h1>Registering Passkey...</h1>
			<div class="loading">
				<div class="spinner"></div>
				<p>Follow your browser prompts to complete registration.</p>
			</div>
		{:else if status === 'success'}
			<div class="success-icon">✓</div>
			<h1 class="success-title">Passkey Registered!</h1>
			<p class="subtitle">Your Passkey has been successfully registered.</p>

			{#if user}
				<div class="user-info success">
					<div class="info-row">
						<span class="label">Email:</span>
						<span class="value">{user.email}</span>
					</div>
					<div class="info-row">
						<span class="label">Status:</span>
						<span class="value">Ready to login</span>
					</div>
				</div>
			{/if}

			<p class="redirect-notice">Redirecting to login page in 3 seconds...</p>

			<a href="/admin/login" class="btn primary">Go to Login</a>
		{/if}

		<div class="footer">Powered by Authrim</div>
	</div>
</div>

<style>
	.setup-container {
		min-height: 100vh;
		display: flex;
		justify-content: center;
		align-items: center;
		background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
		padding: 20px;
	}

	.setup-card {
		background: white;
		padding: 2.5rem;
		border-radius: 16px;
		box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
		width: 100%;
		max-width: 420px;
		text-align: center;
	}

	.logo {
		margin-bottom: 1.5rem;
	}

	.logo svg {
		width: 48px;
		height: 48px;
	}

	h1 {
		color: #333;
		margin: 0 0 0.5rem 0;
		font-size: 1.5rem;
	}

	h1.error-title {
		color: #dc2626;
	}

	h1.success-title {
		color: #059669;
	}

	.subtitle {
		color: #666;
		margin-bottom: 1.5rem;
		font-size: 0.95rem;
	}

	.user-info {
		background: #f8fafc;
		border: 1px solid #e2e8f0;
		border-radius: 12px;
		padding: 1rem;
		margin-bottom: 1.5rem;
		text-align: left;
	}

	.user-info.success {
		background: #f0fdf4;
		border-color: #bbf7d0;
	}

	.info-row {
		display: flex;
		justify-content: space-between;
		padding: 0.5rem 0;
		border-bottom: 1px solid #e2e8f0;
	}

	.info-row:last-child {
		border-bottom: none;
	}

	.user-info.success .info-row {
		border-color: #dcfce7;
	}

	.label {
		color: #64748b;
		font-weight: 500;
	}

	.value {
		color: #334155;
	}

	.user-info.success .value {
		color: #166534;
	}

	.btn {
		width: 100%;
		padding: 1rem;
		border: none;
		border-radius: 8px;
		font-size: 1rem;
		font-weight: 600;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.5rem;
		text-decoration: none;
		transition:
			transform 0.2s,
			box-shadow 0.2s;
	}

	.btn.primary {
		background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
		color: white;
	}

	.btn.primary:hover {
		transform: translateY(-2px);
		box-shadow: 0 8px 20px rgba(102, 126, 234, 0.4);
	}

	.btn-icon {
		width: 20px;
		height: 20px;
	}

	.hint {
		color: #94a3b8;
		font-size: 0.85rem;
		margin-top: 1rem;
		line-height: 1.5;
	}

	.loading {
		padding: 2rem 0;
	}

	.spinner {
		width: 40px;
		height: 40px;
		border: 3px solid #e2e8f0;
		border-top-color: #667eea;
		border-radius: 50%;
		animation: spin 0.8s linear infinite;
		margin: 0 auto 1rem;
	}

	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}

	.error-box {
		background: #fef2f2;
		border: 1px solid #fecaca;
		color: #b91c1c;
		padding: 1rem;
		border-radius: 8px;
		margin-bottom: 1.5rem;
		text-align: left;
		line-height: 1.5;
	}

	.error-box.small {
		font-size: 0.9rem;
		padding: 0.75rem;
	}

	.recovery-info {
		background: #f8fafc;
		border-radius: 8px;
		padding: 1rem;
		text-align: left;
	}

	.recovery-info p {
		color: #64748b;
		font-size: 0.9rem;
		margin: 0 0 0.75rem 0;
	}

	.recovery-info code {
		display: block;
		background: #1e293b;
		color: #94a3b8;
		padding: 0.75rem 1rem;
		border-radius: 6px;
		font-size: 0.85rem;
		word-break: break-all;
	}

	.success-icon {
		width: 64px;
		height: 64px;
		background: linear-gradient(135deg, #10b981 0%, #059669 100%);
		border-radius: 50%;
		display: flex;
		align-items: center;
		justify-content: center;
		color: white;
		font-size: 2rem;
		margin: 0 auto 1rem;
	}

	.redirect-notice {
		color: #94a3b8;
		font-size: 0.9rem;
		margin: 1rem 0;
	}

	.footer {
		margin-top: 2rem;
		color: #999;
		font-size: 0.85rem;
	}
</style>
