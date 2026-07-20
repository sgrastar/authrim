<script lang="ts">
	import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
	import {
		adminInvitationEnrollmentAPI,
		AdminInvitationEnrollmentError
	} from '$lib/api/admin-invitation-enrollment';
	import { adminBrandStore } from '$lib/stores/admin-brand.svelte';
	import { LL } from '$i18n/i18n-svelte';

	type InvitationSummary = {
		email: string;
		name: string | null;
		role: string;
		ip_restriction_enabled: boolean;
	};

	let email = $state('');
	let code = $state('');
	let enrollmentToken = $state('');
	let invitation: InvitationSummary | null = $state(null);
	let checking = $state(false);
	let enrolling = $state(false);
	let completed = $state(false);
	let error = $state('');

	function enrollmentErrorMessage(cause: unknown): string {
		if (!(cause instanceof AdminInvitationEnrollmentError)) {
			return $LL.admin_join_error_generic();
		}

		switch (cause.code) {
			case 'invalid_invitation':
				return $LL.admin_join_error_invalid_invitation();
			case 'invitation_expired':
			case 'invitation_role_expired':
				return $LL.admin_join_error_invitation_expired();
			case 'ip_not_allowed':
				return $LL.admin_join_error_ip_not_allowed();
			case 'invalid_origin':
				return $LL.admin_join_error_invalid_origin();
			case 'passkey_registration_failed':
			case 'passkey_authentication_failed':
			case 'missing_credential_data':
				return $LL.admin_join_error_passkey();
			case 'invitation_activation_conflict':
			case 'invalid_enrollment':
				return $LL.admin_join_error_conflict();
			default:
				return $LL.admin_join_error_generic();
		}
	}

	async function redeemInvitation() {
		if (!email.trim() || !code.trim()) return;
		checking = true;
		error = '';
		try {
			const response = await adminInvitationEnrollmentAPI.redeem(email.trim(), code.trim());
			enrollmentToken = response.enrollment_token;
			invitation = response.invitation;
		} catch (cause) {
			error = enrollmentErrorMessage(cause);
		} finally {
			checking = false;
		}
	}

	async function createAndVerifyPasskey() {
		if (!enrollmentToken) return;
		enrolling = true;
		error = '';
		try {
			const registration = await adminInvitationEnrollmentAPI.registrationOptions(
				enrollmentToken,
				window.location.hostname
			);
			const passkey = await startRegistration({ optionsJSON: registration.options });
			const authentication = await adminInvitationEnrollmentAPI.register(
				enrollmentToken,
				registration.challenge_id,
				passkey,
				window.location.origin
			);
			const credential = await startAuthentication({ optionsJSON: authentication.options });
			await adminInvitationEnrollmentAPI.activate(
				enrollmentToken,
				authentication.challenge_id,
				credential
			);
			completed = true;
			enrollmentToken = '';
		} catch (cause) {
			error = enrollmentErrorMessage(cause);
		} finally {
			enrolling = false;
		}
	}

	function openDashboard() {
		window.location.assign('/admin');
	}
</script>

<svelte:head>
	<title>{$LL.admin_join_head_title()}</title>
</svelte:head>

<div class="join-page">
	<div class="bg-watermark" aria-hidden="true">{adminBrandStore.name}</div>
	<main class="join-container">
		<section class="join-card" aria-labelledby="join-title">
			<header>
				{#if adminBrandStore.logoUrl}
					<img
						class="join-logo"
						src={adminBrandStore.logoUrl}
						alt={adminBrandStore.logoAlt}
						loading="eager"
					/>
				{/if}
				<p class="product-name">{adminBrandStore.name}</p>
				<h1 id="join-title">{$LL.admin_join_title()}</h1>
				<p class="description">{$LL.admin_join_description()}</p>
			</header>

			{#if error}
				<div class="message error" role="alert">
					<i class="i-ph-warning-circle"></i>
					<span>{error}</span>
				</div>
			{/if}

			{#if completed}
				<div class="message success" role="status">
					<i class="i-ph-check-circle"></i>
					<span>{$LL.admin_join_success()}</span>
				</div>
				<button type="button" class="primary-button" onclick={openDashboard}>
					{$LL.admin_join_open_dashboard()}
				</button>
			{:else if invitation}
				<div class="invitation-summary">
					<strong>{invitation.email}</strong>
					<span>{$LL.admin_join_role({ role: invitation.role })}</span>
					{#if invitation.ip_restriction_enabled}
						<span class="ip-notice">
							<i class="i-ph-shield-check"></i>
							{$LL.admin_join_ip_restricted()}
						</span>
					{/if}
				</div>
				<p class="passkey-explanation">{$LL.admin_join_passkey_explanation()}</p>
				<button
					type="button"
					class="primary-button"
					onclick={createAndVerifyPasskey}
					disabled={enrolling}
				>
					<i class={enrolling ? 'i-ph-circle-notch animate-spin' : 'i-ph-fingerprint'}></i>
					{enrolling ? $LL.admin_join_creating_passkey() : $LL.admin_join_create_passkey()}
				</button>
			{:else}
				<form
					onsubmit={(event) => {
						event.preventDefault();
						void redeemInvitation();
					}}
				>
					<label for="join-email">{$LL.admin_join_email()}</label>
					<input id="join-email" type="email" autocomplete="email" bind:value={email} required />
					<label for="join-code">{$LL.admin_join_code()}</label>
					<input
						id="join-code"
						type="text"
						autocomplete="one-time-code"
						inputmode="text"
						spellcheck="false"
						placeholder={$LL.admin_join_code_placeholder()}
						bind:value={code}
						required
					/>
					<button type="submit" class="primary-button" disabled={checking}>
						{checking ? $LL.admin_join_checking() : $LL.admin_join_continue()}
					</button>
				</form>
			{/if}

			{#if !completed}
				<a class="login-link" href="/admin/login">{$LL.admin_join_login_link()}</a>
			{/if}
		</section>
	</main>
</div>

<style>
	.join-page {
		position: relative;
		min-height: 100vh;
		display: grid;
		place-items: center;
		overflow: hidden;
		background: var(--color-bg-page);
		color: var(--color-text);
	}

	.bg-watermark {
		position: fixed;
		top: -16%;
		left: -5%;
		font-family: var(--font-brand, var(--font-display));
		font-size: clamp(20rem, 25vw, 28rem);
		font-weight: var(--brand-weight, 300);
		color: var(--color-text);
		opacity: var(--login-watermark-opacity, 0.04);
		letter-spacing: var(--brand-letter-spacing, 0.1em);
		white-space: nowrap;
		pointer-events: none;
		user-select: none;
	}

	.join-container {
		position: relative;
		z-index: 1;
		width: min(100%, 500px);
		padding: 24px;
	}

	.join-card {
		padding: 40px;
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-panel, var(--radius-xl));
		box-shadow: var(--shadow-panel, var(--shadow-xl));
	}

	header {
		margin-bottom: 28px;
		text-align: center;
	}

	.join-logo {
		display: block;
		width: 56px;
		height: 56px;
		object-fit: contain;
		margin: 0 auto 14px;
	}

	.product-name {
		margin: 0 0 18px;
		font-family: var(--font-brand, var(--font-display));
		font-weight: 500;
		letter-spacing: var(--brand-letter-spacing, 0.15em);
	}

	h1 {
		margin: 0;
		font-size: 1.65rem;
		line-height: 1.25;
	}

	.description,
	.passkey-explanation {
		margin: 10px 0 0;
		color: var(--color-text-muted);
		line-height: 1.6;
	}

	form {
		display: grid;
		gap: 10px;
	}

	label {
		margin-top: 6px;
		font-size: 0.85rem;
		font-weight: 600;
	}

	input {
		width: 100%;
		box-sizing: border-box;
		padding: 12px 14px;
		color: var(--color-text);
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-control, var(--radius-md));
		font: inherit;
	}

	input:focus-visible {
		outline: 2px solid var(--color-accent);
		outline-offset: 2px;
	}

	.primary-button {
		width: 100%;
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 10px;
		margin-top: 14px;
		padding: 13px 20px;
		color: var(--color-accent-contrast);
		background: var(--color-accent);
		border: 0;
		border-radius: var(--radius-control, var(--radius-md));
		font: inherit;
		font-weight: 650;
		cursor: pointer;
	}

	.primary-button:disabled {
		opacity: 0.6;
		cursor: wait;
	}

	.message {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		padding: 12px 14px;
		margin-bottom: 18px;
		border: 1px solid;
		border-radius: var(--radius-control, var(--radius-md));
		font-size: 0.875rem;
	}

	.message.error {
		color: var(--color-danger);
		background: color-mix(in srgb, var(--color-danger) 10%, var(--color-surface));
		border-color: color-mix(in srgb, var(--color-danger) 35%, var(--color-border));
	}

	.message.success {
		color: var(--color-success);
		background: color-mix(in srgb, var(--color-success) 10%, var(--color-surface));
		border-color: color-mix(in srgb, var(--color-success) 35%, var(--color-border));
	}

	.invitation-summary {
		display: grid;
		gap: 6px;
		padding: 14px;
		background: var(--color-bg-subtle, var(--color-bg-page));
		border-radius: var(--radius-control, var(--radius-md));
	}

	.ip-notice {
		display: flex;
		align-items: center;
		gap: 6px;
		color: var(--color-text-muted);
		font-size: 0.82rem;
	}

	.login-link {
		display: block;
		margin-top: 24px;
		color: var(--color-text-muted);
		font-size: 0.85rem;
		text-align: center;
	}

	@media (max-width: 520px) {
		.join-container {
			padding: 16px;
		}

		.join-card {
			padding: 30px 22px;
		}
	}
</style>
