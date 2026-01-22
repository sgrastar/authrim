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

			// Step 4: Update auth store with user info
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

<div style="max-width: 400px; margin: 100px auto; padding: 20px; text-align: center;">
	<h1 style="margin-bottom: 30px;">Admin Login</h1>

	{#if error}
		<div
			style="background-color: #fee2e2; border: 1px solid #ef4444; color: #b91c1c; padding: 12px; border-radius: 6px; margin-bottom: 20px;"
		>
			{error}
		</div>
	{/if}

	<button
		onclick={handlePasskeyLogin}
		disabled={loading}
		style="
			width: 100%;
			padding: 12px 24px;
			font-size: 16px;
			background-color: {loading ? '#9ca3af' : '#2563eb'};
			color: white;
			border: none;
			border-radius: 6px;
			cursor: {loading ? 'not-allowed' : 'pointer'};
		"
	>
		{#if loading}
			Authenticating...
		{:else}
			Login with Passkey
		{/if}
	</button>

	<p style="margin-top: 20px; color: #6b7280; font-size: 14px;">
		Only administrators with registered Passkeys can access this area.
	</p>
</div>
