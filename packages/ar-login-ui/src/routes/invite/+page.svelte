<script lang="ts">
	import { Input, Card, Alert } from '$lib/components';
	import { onMount } from 'svelte';

	// ---------------------------------------------------------------------------
	// State
	// ---------------------------------------------------------------------------
	let token = $state('');
	let tenantName = $state('');
	let invitedEmail = $state<string | null>(null);

	let email = $state('');
	let loading = $state(true);
	let submitting = $state(false);
	let error = $state('');
	let sent = $state(false);

	// ---------------------------------------------------------------------------
	// Lifecycle
	// ---------------------------------------------------------------------------
	onMount(async () => {
		const params = new URLSearchParams(window.location.search);
		const t = params.get('token');

		if (!t) {
			error = 'Invalid invitation link. No token provided.';
			loading = false;
			return;
		}

		token = t;
		await validateToken(t);
	});

	async function validateToken(t: string) {
		loading = true;
		error = '';
		try {
			const res = await fetch(`/api/v1/invitations/validate?token=${encodeURIComponent(t)}`);
			if (!res.ok) {
				const data = await res.json().catch(() => ({}));
				error =
					(data as { error?: string; message?: string }).message ||
					'This invitation link is invalid or has expired.';
				loading = false;
				return;
			}
			const data = (await res.json()) as {
				invitation_id: string;
				tenant_name: string;
				invited_email: string | null;
			};
			tenantName = data.tenant_name;
			invitedEmail = data.invited_email;
			if (invitedEmail) {
				email = invitedEmail;
			}
		} catch {
			error = 'Failed to validate invitation. Please try again.';
		} finally {
			loading = false;
		}
	}

	async function handleSubmit(e: Event) {
		e.preventDefault();
		error = '';

		if (!email) {
			error = 'Email address is required.';
			return;
		}
		if (invitedEmail && email.toLowerCase() !== invitedEmail.toLowerCase()) {
			error = 'This invitation is for a different email address.';
			return;
		}

		submitting = true;
		try {
			// Redirect to signup with invite context
			const qs = `invite_token=${encodeURIComponent(token)}&email=${encodeURIComponent(email)}&tenant=${encodeURIComponent(tenantName)}`;
			window.location.href = `/signup?${qs}`;
		} catch {
			error = 'An error occurred. Please try again.';
			submitting = false;
		}
	}
</script>

<svelte:head>
	<title>Invitation - {tenantName || 'Authrim'}</title>
	<meta name="referrer" content="no-referrer" />
</svelte:head>

<div class="invite-page">
	<Card>
		{#if loading}
			<div class="loading-state">
				<div class="spinner" aria-label="Loading..."></div>
				<p>Validating your invitation...</p>
			</div>
		{:else if error && !tenantName}
			<div class="error-state">
				<div class="error-icon">✕</div>
				<h2>Invalid Invitation</h2>
				<p>{error}</p>
			</div>
		{:else if sent}
			<div class="success-state">
				<div class="success-icon">✓</div>
				<h2>Check your email</h2>
				<p>We've sent a verification code to <strong>{email}</strong>.</p>
			</div>
		{:else}
			<div class="invite-content">
				<div class="invite-header">
					<h2>You're invited to <strong>{tenantName}</strong></h2>
					<p>Accept your invitation by signing up with your email address.</p>
				</div>

				{#if error}
					<Alert variant="error">{error}</Alert>
				{/if}

				<form onsubmit={handleSubmit}>
					<div class="form-field">
						<Input
							type="email"
							label="Email address"
							bind:value={email}
							placeholder="you@example.com"
							disabled={!!invitedEmail}
							required
						/>
						{#if invitedEmail}
							<p class="field-hint">This invitation is for this specific email address.</p>
						{/if}
					</div>

					<button type="submit" class="submit-btn" disabled={submitting}>
						{submitting ? 'Loading...' : 'Continue'}
					</button>
				</form>
			</div>
		{/if}
	</Card>
</div>

<style>
	.invite-page {
		display: flex;
		align-items: center;
		justify-content: center;
		min-height: 100vh;
		padding: 1rem;
	}

	.loading-state,
	.error-state,
	.success-state {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 1rem;
		padding: 2rem;
		text-align: center;
	}

	.spinner {
		width: 2rem;
		height: 2rem;
		border: 3px solid var(--color-border, #e5e7eb);
		border-top-color: var(--color-primary, #4f46e5);
		border-radius: 50%;
		animation: spin 0.8s linear infinite;
	}

	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}

	.error-icon,
	.success-icon {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 3rem;
		height: 3rem;
		border-radius: 50%;
		font-size: 1.25rem;
		font-weight: bold;
	}

	.error-icon {
		background-color: var(--color-error-bg, #fee2e2);
		color: var(--color-error, #dc2626);
	}

	.success-icon {
		background-color: var(--color-success-bg, #dcfce7);
		color: var(--color-success, #16a34a);
	}

	.invite-content {
		padding: 1.5rem;
	}

	.invite-header {
		margin-bottom: 1.5rem;
	}

	.invite-header h2 {
		font-size: 1.25rem;
		margin-bottom: 0.5rem;
	}

	.invite-header p {
		color: var(--color-text-muted, #6b7280);
		font-size: 0.9rem;
	}

	.form-field {
		margin-bottom: 1rem;
	}

	.field-hint {
		font-size: 0.8rem;
		color: var(--color-text-muted, #6b7280);
		margin-top: 0.25rem;
	}

	.submit-btn {
		width: 100%;
		padding: 0.625rem 1.25rem;
		background: var(--primary, #4f46e5);
		color: #fff;
		border: none;
		border-radius: 0.375rem;
		font-size: 0.875rem;
		font-weight: 500;
		cursor: pointer;
		transition: opacity 0.15s;
		margin-top: 0.5rem;
	}

	.submit-btn:hover:not(:disabled) {
		opacity: 0.9;
	}

	.submit-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
</style>
