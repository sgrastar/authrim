<script lang="ts">
	/**
	 * Registering an authenticator app as a second factor: the QR code to scan, the same secret
	 * for an app that cannot scan (shown only now), and the code the app then shows. A wrong code
	 * keeps the dialog open for another try. The enrollment itself (the step-up, the secret, the
	 * check) is the client's; this only shows it.
	 */
	import type { TotpEnrollment } from '#lib/api/second-factors.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import FormDialog from '#lib/ui/patterns/FormDialog.svelte';
	import SecretField from '#lib/ui/primitives/SecretField.svelte';
	import TextField from '#lib/ui/primitives/TextField.svelte';

	interface Props {
		/** The secret waiting for a code; the dialog is open while there is one. */
		enrollment: TotpEnrollment | null;
		busy?: boolean;
		/** Why the last code was not accepted. */
		error?: string;
		onsubmit: (code: string) => void;
		oncancel: () => void;
	}

	let { enrollment, busy = false, error, onsubmit, oncancel }: Props = $props();

	let code = $state('');
	let qrDataUrl = $state('');

	// A new secret starts with an empty code.
	$effect(() => {
		if (enrollment) code = '';
	});

	// The QR library is only needed while a QR is on screen, so it is loaded on demand.
	$effect(() => {
		const value = enrollment?.otpauthUri;
		if (!value) {
			qrDataUrl = '';
			return;
		}
		import('qrcode')
			.then(({ toDataURL }) =>
				toDataURL(value, { margin: 2, width: 200, errorCorrectionLevel: 'M' })
			)
			.then((url) => {
				if (enrollment?.otpauthUri === value) qrDataUrl = url;
			})
			.catch(() => {
				if (enrollment?.otpauthUri === value) qrDataUrl = '';
			});
	});
</script>

<FormDialog
	open={enrollment !== null}
	title={t('sk.totp.title')}
	description={t('sk.totp.body')}
	submitLabel={t('sk.totp.confirm')}
	{busy}
	{error}
	onsubmit={() => {
		if (code.trim()) onsubmit(code);
	}}
	{oncancel}
>
	<div class="qr">
		{#if qrDataUrl}
			<img src={qrDataUrl} width="200" height="200" alt={t('sk.totp.qrAlt')} />
		{/if}
	</div>
	<SecretField
		label={t('sk.totp.secret')}
		mode="show"
		once
		value={enrollment?.secret ?? ''}
		hint={t('sk.totp.secretHint')}
	/>
	<TextField
		label={t('sk.totp.code')}
		bind:value={code}
		inputmode="numeric"
		autocomplete="one-time-code"
		maxlength={7}
		placeholder="123456"
	/>
	<Callout>{t('sk.totp.weaker')}</Callout>
</FormDialog>

<style>
	.qr {
		display: grid;
		place-items: center;
		min-height: 200px;
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
	}

	.qr img {
		display: block;
		border-radius: var(--radius-md);
	}
</style>
