<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import { ApiError, ConflictError } from '#lib/api/api-error.js';
	import {
		IDENTIFIER_NAME,
		type SaltEncoding,
		type SaltResult
	} from '#lib/api/identifier-materials.js';
	import SecretField from '../primitives/SecretField.svelte';
	import SegmentedControl from '../primitives/SegmentedControl.svelte';
	import TextField from '../primitives/TextField.svelte';
	import ConfirmDialog from './ConfirmDialog.svelte';
	import FormDialog from './FormDialog.svelte';
	import { useIdentifierMaterials } from './identifier-materials-context';

	/**
	 * Imports a salt from another identity provider under a name a persistent identifier step
	 * refers to. The salt is typed as the IdP held it (text) or as bytes (Base64), is never shown
	 * again and never comes back from the server; only its fingerprint does. The same salt again
	 * changes nothing. A different one under a name already used asks first, naming the
	 * fingerprint of the one kept, and replaces it only on a yes.
	 */
	interface Props {
		open: boolean;
		/** The name to start with (the salt the step has chosen). */
		name?: string;
		/** The salt was kept (or already was): its name, fingerprint and what happened. */
		onimported: (result: SaltResult) => void;
		oncancel: () => void;
	}

	let { open, name: initialName = '', onimported, oncancel }: Props = $props();

	const client = useIdentifierMaterials();
	let gone = false;
	const reads = new AbortController();
	onDestroy(() => {
		gone = true;
		reads.abort();
	});

	let name = $state('');
	let value = $state('');
	let encoding = $state<SaltEncoding>('utf8');
	let busy = $state(false);
	let error = $state('');
	let nameError = $state('');
	let valueError = $state('');
	/** A different salt is kept under the name: its fingerprint, asked about before replacing. */
	let replacing = $state<{ fingerprint: string } | null>(null);

	// Each time it opens: the name it was given, nothing typed, nothing said.
	/** Counted up each time it opens, so the secret field is made new (hidden again). */
	let session = $state(0);

	$effect(() => {
		if (!open) {
			// Closed: nothing typed stays in memory, and the next opening starts hidden.
			value = '';
			replacing = null;
			return;
		}
		session = untrack(() => session) + 1;
		name = initialName;
		value = '';
		encoding = 'utf8';
		error = nameError = valueError = '';
		replacing = null;
	});

	function cancel() {
		value = '';
		replacing = null;
		oncancel();
	}

	function failure(cause: unknown): string {
		if (cause instanceof ApiError) {
			if (cause.forbidden) return t('pid.error.forbidden');
			if (cause.status === 400) return t('pid.salt.error.invalid');
		}
		return t('pid.salt.error.generic');
	}

	function done(result: SaltResult) {
		value = '';
		onimported(result);
	}

	async function submit() {
		if (busy) return;
		nameError = valueError = error = '';
		const kept = name.trim();
		if (!kept) nameError = t('pid.error.name');
		else if (!IDENTIFIER_NAME.test(kept)) nameError = t('pid.nameHint');
		if (!value) valueError = t('pid.salt.error.value');
		if (nameError || valueError) return;
		busy = true;
		try {
			const result = await client.importSalt(kept, { value, encoding });
			if (!gone) done(result);
		} catch (cause) {
			if (gone) return;
			if (cause instanceof ConflictError) {
				// A different salt is kept (or the tenant has no room): the list says which. A list
				// that cannot be read says so instead (the same button tries again).
				let held: { fingerprint: string } | undefined;
				try {
					held = (await client.salts(reads.signal)).find((salt) => salt.name === kept);
				} catch (lookup) {
					if (gone) return;
					error =
						lookup instanceof ApiError && lookup.forbidden
							? t('pid.error.forbidden')
							: t('pid.salt.error.lookup');
					return;
				}
				if (gone) return;
				if (held) replacing = { fingerprint: held.fingerprint };
				else error = t('pid.salt.error.limit');
			} else {
				error = failure(cause);
			}
		} finally {
			if (!gone) busy = false;
		}
	}

	async function replace() {
		if (busy || !replacing) return;
		const { fingerprint } = replacing;
		busy = true;
		try {
			const result = await client.importSalt(name.trim(), {
				value,
				encoding,
				replaceFingerprint: fingerprint
			});
			if (gone) return;
			done(result);
			replacing = null;
		} catch (cause) {
			if (gone) return;
			// Changed meanwhile, or refused: back to the form with the reason.
			replacing = null;
			error = failure(cause);
		} finally {
			if (!gone) busy = false;
		}
	}
</script>

<FormDialog
	open={open && !replacing}
	title={t('pid.salt.title')}
	submitLabel={t('pid.salt.submit')}
	{busy}
	{error}
	onsubmit={submit}
	oncancel={cancel}
>
	<TextField
		label={t('pid.salt.name')}
		bind:value={name}
		hint={t('pid.nameHint')}
		error={nameError}
		required
		spellcheck="false"
		autocomplete="off"
		dir="ltr"
	/>
	{#key session}
		<SecretField label={t('pid.salt.value')} bind:value error={valueError} required />
	{/key}
	<SegmentedControl
		label={t('pid.salt.encoding')}
		hideLabel={false}
		bind:value={encoding}
		options={[
			{ value: 'utf8', label: t('pid.salt.enc.utf8') },
			{ value: 'base64', label: t('pid.salt.enc.base64') }
		]}
	/>
</FormDialog>

<ConfirmDialog
	open={open && replacing !== null}
	title={t('pid.salt.replaceTitle', { name: name.trim() })}
	body={t('pid.salt.replaceBody', { fingerprint: replacing?.fingerprint ?? '' })}
	confirmLabel={t('pid.salt.replaceConfirm')}
	tone="danger"
	{busy}
	onconfirm={replace}
	oncancel={() => (replacing = null)}
/>
