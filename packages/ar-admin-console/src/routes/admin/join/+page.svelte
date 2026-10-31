<script lang="ts">
	import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
	import {
		adminInvitationEnrollmentAPI,
		enrollmentErrorKey
	} from '$lib/api/admin-invitation-enrollment';
	import { t, type MessageKey } from '$lib/i18n/i18n.svelte';
	import DisplayMenu from '$lib/shell/DisplayMenu.svelte';
	import LanguageSwitch from '$lib/shell/LanguageSwitch.svelte';
	import Button from '$lib/ui/primitives/Button.svelte';
	import TextField from '$lib/ui/primitives/TextField.svelte';
	import Callout from '$lib/ui/patterns/Callout.svelte';
	import Form from '$lib/ui/patterns/Form.svelte';
	import AuthLayout from '$lib/ui/templates/AuthLayout.svelte';

	type Invitation = {
		email: string;
		name: string | null;
		role: string;
		ip_restriction_enabled: boolean;
	};

	let email = $state('');
	let code = $state('');
	let enrollmentToken = $state('');
	let invitation = $state<Invitation | null>(null);
	let checking = $state(false);
	let enrolling = $state(false);
	let completed = $state(false);
	let errorKey = $state<MessageKey | null>(null);

	async function redeem(event: SubmitEvent) {
		event.preventDefault();
		if (!email.trim() || !code.trim()) return;
		checking = true;
		errorKey = null;
		try {
			const response = await adminInvitationEnrollmentAPI.redeem(email.trim(), code.trim());
			enrollmentToken = response.enrollment_token;
			invitation = response.invitation;
		} catch (cause) {
			errorKey = enrollmentErrorKey(cause);
		} finally {
			checking = false;
		}
	}

	/** Register a passkey for this host, prove it once, then activate the administrator. */
	async function enroll() {
		if (!enrollmentToken) return;
		enrolling = true;
		errorKey = null;
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
			errorKey = enrollmentErrorKey(cause);
		} finally {
			enrolling = false;
		}
	}
</script>

<svelte:head><title>{t('join.title')} — {t('app.brand')}</title></svelte:head>

<AuthLayout
	title={completed ? t('join.done.title') : t('join.title')}
	subtitle={completed ? t('join.done.body') : invitation ? undefined : t('join.subtitle')}
	busy={enrolling || checking}
>
	{#if errorKey}
		<Callout tone="danger" live>{t(errorKey)}</Callout>
	{/if}
	{#if completed}
		<Button variant="primary" icon="arrowIn" block href="/admin">{t('join.open')}</Button>
	{:else if invitation}
		<Callout>{t('join.invitedAs', { email: invitation.email, role: invitation.role })}</Callout>
		{#if invitation.ip_restriction_enabled}
			<Callout tone="warning">{t('join.ipRestricted')}</Callout>
		{/if}
		<Button variant="primary" icon="fingerprint" block loading={enrolling} onclick={enroll}>
			{enrolling ? t('join.creating') : t('join.createPasskey')}
		</Button>
	{:else}
		<Form onsubmit={redeem}>
			<TextField
				label={t('join.email')}
				type="email"
				autocomplete="email"
				required
				bind:value={email}
			/>
			<TextField
				label={t('join.code')}
				autocomplete="one-time-code"
				spellcheck="false"
				required
				bind:value={code}
			/>
			<Button variant="primary" type="submit" block loading={checking}>
				{checking ? t('join.checking') : t('join.check')}
			</Button>
		</Form>
	{/if}
	{#snippet footer()}
		<LanguageSwitch />
		<DisplayMenu />
	{/snippet}
</AuthLayout>
