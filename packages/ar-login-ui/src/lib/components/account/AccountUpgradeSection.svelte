<script lang="ts">
	/** Runs guest registration (email code or passkey) against the account API for the widget. */
	import { onMount, untrack } from 'svelte';
	import { startRegistration, type RegistrationResponseJSON } from '@simplewebauthn/browser';
	import { accountAPI, type GuestUpgradeAttempt, type GuestUpgradeStatus } from '$lib/api/account';
	import AccountUpgradeWidget from './widgets/AccountUpgradeWidget.svelte';
	import type { AccountWidgetHeadingLevel } from './widgets/types';

	let {
		onCompleted = async () => {},
		onExistingLogin,
		title = '',
		headingLevel = 2,
		initialStatus = null
	}: {
		onCompleted?: () => Promise<unknown>;
		onExistingLogin?: () => Promise<void>;
		initialStatus?: GuestUpgradeStatus | null;
		title?: string;
		headingLevel?: AccountWidgetHeadingLevel;
	} = $props();

	let status = $state<GuestUpgradeStatus | null>(untrack(() => initialStatus));
	let attempt = $state<GuestUpgradeAttempt | null>(null);
	let busy = $state(false);
	let error = $state(false);
	let collision = $state(false);
	let pending = $state(false);
	let completed = $state(false);
	let proof: { code?: string; passkey_response?: RegistrationResponseJSON } = {};

	async function refresh() {
		const result = await accountAPI.getGuestUpgrade();
		if (result.data) {
			const recovered =
				status?.registration_state === 'guest' && result.data.registration_state === 'registered';
			status = result.data;
			if (recovered && !completed) {
				completed = true;
				await onCompleted();
			}
		}
	}

	onMount(() => {
		void refresh();
	});

	async function finish() {
		if (!attempt) return;
		busy = true;
		error = false;
		collision = false;
		try {
			const result = await accountAPI.completeGuestUpgrade(attempt, proof);
			if (result.error) {
				collision = result.error.error === 'identity_already_registered';
				error = !collision;
			} else if (result.data?.success) {
				completed = true;
				attempt = null;
				proof = {};
				await onCompleted();
			} else pending = true;
			await refresh();
		} catch {
			error = true;
		} finally {
			busy = false;
		}
	}

	async function begin(method: 'email' | 'passkey', email?: string) {
		if (busy) return;
		busy = true;
		error = false;
		collision = false;
		pending = false;
		try {
			const result = await accountAPI.startGuestUpgrade(method, email);
			if (!result.data) {
				error = true;
				return;
			}
			attempt = result.data;
			if (method === 'passkey') {
				if (!attempt.options) {
					error = true;
					return;
				}
				proof = { passkey_response: await startRegistration({ optionsJSON: attempt.options }) };
				await finish();
			}
			await refresh();
		} catch {
			attempt = null;
			proof = {};
			error = true;
		} finally {
			busy = false;
		}
	}

	async function confirm(code: string) {
		if (busy) return;
		proof = { code };
		await finish();
	}

	function reset() {
		attempt = null;
		proof = {};
		pending = false;
		error = false;
		collision = false;
	}

	async function existingLogin() {
		if (!onExistingLogin) return;
		busy = true;
		try {
			await onExistingLogin();
		} catch {
			error = true;
			collision = false;
		} finally {
			busy = false;
		}
	}
</script>

<AccountUpgradeWidget
	{status}
	{completed}
	attemptMethod={attempt?.method ?? null}
	{busy}
	{error}
	{collision}
	{pending}
	{title}
	{headingLevel}
	onStartEmail={(email) => begin('email', email)}
	onStartPasskey={() => begin('passkey')}
	onConfirmCode={confirm}
	onChangeMethod={reset}
	onRetry={() => (attempt ? finish() : refresh())}
	onExistingLogin={onExistingLogin ? existingLogin : undefined}
/>
