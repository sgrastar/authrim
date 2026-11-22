<script lang="ts">
	import { t } from '#lib/i18n/i18n.svelte.js';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import ChoiceCards from '#lib/ui/patterns/ChoiceCards.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import TextField from '#lib/ui/primitives/TextField.svelte';
	import KeyringPresentationPanel from './KeyringPresentationPanel.svelte';
	import {
		secondFactorPrompt,
		type SecondFactorPromptState
	} from './second-factor-prompt.svelte.js';

	/**
	 * The second-factor question of a step-up, for admins with more than a security key: a security
	 * key, Keyring or an authenticator app (its 6-digit code is typed here). Mounted once in the
	 * root layout; `prompt` is replaceable for stories and tests.
	 */
	interface Props {
		prompt?: SecondFactorPromptState;
	}

	let { prompt = secondFactorPrompt }: Props = $props();

	let dialog = $state<HTMLDialogElement>();
	let choice = $state('keyring');
	let code = $state('');
	const uid = $props.id();

	const options = $derived([
		...(prompt.hasKeyring
			? [
					{
						value: 'keyring',
						label: t('kp.prompt.keyring'),
						description: t('kp.prompt.keyringHint'),
						icon: 'deviceMobile' as const
					}
				]
			: []),
		...(prompt.hasSecurityKey
			? [
					{
						value: 'security_key',
						label: t('kp.prompt.securityKey'),
						description: t('kp.prompt.securityKeyHint'),
						icon: 'key' as const
					}
				]
			: []),
		...(prompt.hasTotp
			? [
					{
						value: 'totp',
						label: t('kp.prompt.totp'),
						description: t('kp.prompt.totpHint'),
						icon: 'lock' as const
					}
				]
			: [])
	]);

	// The first way offered is the one preselected, and a code typed before is never kept.
	$effect(() => {
		if (prompt.open) {
			choice = options[0]?.value ?? 'keyring';
			code = '';
		}
	});

	const failureText = $derived(
		prompt.totpFailure === 'invalid'
			? t('kp.totp.error.invalid')
			: prompt.totpFailure === 'rate_limited'
				? t('kp.totp.error.rateLimited')
				: prompt.totpFailure === 'not_allowed'
					? t('kp.totp.error.notAllowed')
					: prompt.totpFailure === 'unavailable'
						? t('kp.totp.error.unavailable')
						: ''
	);

	$effect(() => {
		if (!dialog) return;
		if (prompt.open && !dialog.open) dialog.showModal();
		if (!prompt.open && dialog.open) dialog.close();
	});

	function proceed() {
		if (choice === 'security_key') prompt.chooseSecurityKey();
		else if (choice === 'totp') prompt.chooseTotp();
		else prompt.chooseKeyring();
	}

	function submit() {
		if (code.trim()) void prompt.submitTotp(code);
	}
</script>

<dialog
	bind:this={dialog}
	class="dialog"
	aria-labelledby="{uid}-title"
	oncancel={(event) => {
		event.preventDefault();
		prompt.cancel();
	}}
>
	<h2 id="{uid}-title">{t('kp.prompt.title')}</h2>
	<p>
		{prompt.flow
			? t('kp.prompt.keyringDesc')
			: prompt.totpStep
				? t('kp.prompt.totpDesc')
				: t('kp.prompt.desc')}
	</p>
	<div class="dialog__body">
		{#if prompt.flow}
			<KeyringPresentationPanel
				flow={prompt.flow}
				onretry={() => prompt.retry()}
				onqr={() => prompt.useQr()}
			/>
		{:else if prompt.totpStep}
			<TextField
				label={t('kp.totp.label')}
				bind:value={code}
				inputmode="numeric"
				autocomplete="one-time-code"
				maxlength={7}
				placeholder="123456"
				disabled={prompt.totpBusy}
				onkeydown={(event) => {
					if (event.key === 'Enter') {
						event.preventDefault();
						submit();
					}
				}}
			/>
			{#if failureText}
				<Callout tone="danger" live>{failureText}</Callout>
			{/if}
		{:else if prompt.open}
			<ChoiceCards
				label={t('kp.prompt.choose')}
				hideLabel
				columns={1}
				bind:value={choice}
				{options}
			/>
		{/if}
	</div>
	<div class="dialog__actions">
		{#if (prompt.flow || prompt.totpStep) && prompt.canGoBack}
			<Button variant="ghost" onclick={() => prompt.back()}>{t('kp.prompt.back')}</Button>
		{/if}
		<Button variant="ghost" onclick={() => prompt.cancel()}>{t('common.cancel')}</Button>
		{#if prompt.totpStep}
			<Button variant="primary" loading={prompt.totpBusy} disabled={!code.trim()} onclick={submit}>
				{t('kp.totp.verify')}
			</Button>
		{:else if !prompt.flow}
			<Button variant="primary" onclick={proceed}>{t('kp.prompt.continue')}</Button>
		{/if}
	</div>
</dialog>

<style>
	.dialog {
		width: min(560px, calc(100vw - 32px));
		padding: var(--dialog-pad-y) var(--dialog-pad-x);
		border: 1px solid var(--border);
		border-radius: var(--radius-panel);
		background: var(--bg-card);
		color: var(--text-primary);
		box-shadow: var(--shadow-lg);
	}

	.dialog[open] {
		animation: dialog-in 160ms cubic-bezier(0.2, 0.9, 0.3, 1) both;
	}

	.dialog::backdrop {
		background: var(--scrim);
	}

	h2 {
		margin: 0 0 6px;
		font-size: var(--fs-title);
		font-weight: var(--fw-semibold);
	}

	p {
		margin: 0;
		font-size: var(--fs-body);
		line-height: var(--lh-body);
		color: var(--text-secondary);
	}

	.dialog__body {
		display: grid;
		gap: var(--space-field);
		margin: 16px 0 20px;
	}

	.dialog__actions {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
	}

	@keyframes dialog-in {
		from {
			opacity: 0;
			transform: translateY(8px) scale(0.98);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.dialog[open] {
			animation: none;
		}
	}
</style>
