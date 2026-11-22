<script lang="ts">
	import { untrack } from 'svelte';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import type { FederationCertificate } from '#lib/api/federation-sources.js';
	import Button from '#lib/ui/primitives/Button.svelte';
	import SegmentedControl from '#lib/ui/primitives/SegmentedControl.svelte';
	import TextArea from '#lib/ui/primitives/TextArea.svelte';
	import TextField from '#lib/ui/primitives/TextField.svelte';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import FileDrop from '#lib/ui/patterns/FileDrop.svelte';
	import { certificateFingerprints } from '../authentication/saml-local/local-signing-model';
	import {
		certificateFromPem,
		fingerprintDisplay,
		fingerprintGroups,
		pemFromFileBytes
	} from './federation-model';

	/**
	 * The certificates a federation's metadata is signed with, added by reading an https address,
	 * by pasting PEM or from a file (PEM or DER): one way at a time, picked above the field. Each is shown with its SHA-256 and SHA-1
	 * fingerprints worked out in the browser from the certificate itself. The fingerprint is the
	 * check: the federation publishes it (SHA-256 today; SHA-1 is how older lists give it), so
	 * compare before saving. Shared by the wizard and the federation's own page.
	 */
	interface Props {
		certificates: FederationCertificate[];
		disabled?: boolean;
		/** Reads a certificate from an https address and gives its PEM; absent: no URL field. */
		readUrl?: (url: string) => Promise<string>;
	}
	let { certificates = $bindable(), disabled = false, readUrl }: Props = $props();

	/** How a certificate is added now: only that way's fields are shown. */
	type Method = 'url' | 'paste' | 'file';
	// Without an address reader the first way is pasting.
	let method = $state<Method>(untrack(() => (readUrl ? 'url' : 'paste')));
	const methods = $derived([
		...(readUrl ? [{ value: 'url', label: t('sf.fed.cert.mode.url') }] : []),
		{ value: 'paste', label: t('sf.fed.cert.mode.paste') },
		{ value: 'file', label: t('sf.fed.cert.mode.file') }
	]);

	let pasted = $state('');
	let files = $state<File[]>([]);
	let error = $state('');
	let url = $state('');
	let urlError = $state('');
	let reading = $state(false);
	/** The SHA-1 of each certificate, worked out here (the stored form keeps only SHA-256). */
	let sha1 = $state<Record<string, string>>({});

	$effect(() => {
		for (const certificate of certificates) {
			if (sha1[certificate.id] !== undefined) continue;
			sha1[certificate.id] = '';
			void certificateFingerprints(certificate.certificate).then((prints) => {
				if (prints) sha1[certificate.id] = prints.sha1;
			});
		}
	});

	async function add(text: string): Promise<boolean> {
		const certificate = await certificateFromPem(text);
		if (!certificate) {
			error = t('sf.fed.cert.invalid');
			return false;
		}
		error = '';
		if (
			!certificates.some((existing) => existing.fingerprintSha256 === certificate.fingerprintSha256)
		)
			certificates = [...certificates, certificate];
		return true;
	}

	async function addPasted() {
		if (await add(pasted)) pasted = '';
	}

	async function readFromUrl() {
		if (!readUrl || !url.trim() || reading) return;
		reading = true;
		urlError = '';
		try {
			if (await add(await readUrl(url.trim()))) url = '';
			else urlError = t('sf.fed.cert.urlFailed');
		} catch {
			urlError = t('sf.fed.cert.urlFailed');
		} finally {
			reading = false;
		}
	}

	$effect(() => {
		const [file] = files;
		if (!file) return;
		files = [];
		void file.arrayBuffer().then((buffer) => add(pemFromFileBytes(new Uint8Array(buffer))));
	});

	function remove(id: string) {
		certificates = certificates.filter((certificate) => certificate.id !== id);
	}
</script>

<div class="certs">
	{#if certificates.length > 0}
		<ul class="certs__list" aria-label={t('sf.fed.cert.listLabel')}>
			{#each certificates as certificate (certificate.id)}
				<li class="certs__item">
					<div class="certs__prints">
						<span class="certs__name">{t('sf.fed.cert.fingerprint')}</span>
						<code class="certs__print" dir="ltr"
							>{#each fingerprintGroups(fingerprintDisplay(certificate.fingerprintSha256)) as group (group)}<span
									class="certs__group">{group}</span
								><wbr />{/each}</code
						>
						{#if sha1[certificate.id]}
							<span class="certs__name">{t('sf.fed.cert.fingerprintSha1')}</span>
							<code class="certs__print" dir="ltr"
								>{#each fingerprintGroups(sha1[certificate.id]) as group (group)}<span
										class="certs__group">{group}</span
									><wbr />{/each}</code
							>
						{/if}
					</div>
					{#if !disabled}
						<Button
							size="sm"
							variant="ghost"
							aria-label="{t('sf.fed.cert.remove')} ({fingerprintDisplay(
								certificate.fingerprintSha256
							).slice(0, 23)}…)"
							onclick={() => remove(certificate.id)}>{t('sf.fed.cert.remove')}</Button
						>
					{/if}
				</li>
			{/each}
		</ul>
		<Callout tone="info">{t('sf.fed.cert.compare')}</Callout>
	{/if}
	{#if !disabled}
		<p class="certs__lead">{t('sf.fed.cert.required')}</p>
		<SegmentedControl
			label={t('sf.fed.cert.mode.label')}
			options={methods}
			value={method}
			onchange={(value) => {
				if (value !== 'url' && value !== 'paste' && value !== 'file') return;
				method = value;
				// What went wrong with one way is not shown under another.
				error = '';
				urlError = '';
			}}
		/>
		{#if method === 'url' && readUrl}
			<TextField
				label={t('sf.fed.cert.url')}
				hint={t('sf.fed.cert.urlHint')}
				placeholder="https://federation.example/signer.cer"
				type="url"
				error={urlError || undefined}
				bind:value={url}
			/>
			<div class="certs__actions">
				<Button variant="secondary" disabled={!url.trim() || reading} onclick={readFromUrl}
					>{reading ? t('sf.fed.cert.urlReading') : t('sf.fed.cert.urlRead')}</Button
				>
			</div>
		{:else if method === 'paste'}
			<TextArea
				label={t('sf.fed.cert.paste')}
				hint={t('sf.fed.cert.pasteHint')}
				mono
				rows={5}
				error={error || undefined}
				bind:value={pasted}
			/>
			<div class="certs__actions">
				<Button variant="secondary" disabled={!pasted.trim()} onclick={addPasted}
					>{t('sf.fed.cert.add')}</Button
				>
			</div>
		{:else if method === 'file'}
			<FileDrop label={t('sf.fed.cert.file')} accept=".pem,.crt,.cer,.der,.txt" bind:files />
			<p class="certs__lead">{t('sf.fed.cert.fileHint')}</p>
			{#if error}<p class="certs__error" role="alert">{error}</p>{/if}
		{/if}
	{/if}
</div>

<style>
	.certs {
		display: grid;
		gap: var(--space-grid);
	}

	.certs__list {
		display: grid;
		gap: 8px;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.certs__item {
		display: flex;
		gap: var(--space-grid);
		align-items: center;
		justify-content: space-between;
		padding: 8px 12px;
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-md);
	}

	.certs__prints {
		display: grid;
		gap: 2px;
		min-width: 0;
	}

	.certs__lead {
		margin: 0;
		color: var(--text-secondary);
		font-size: var(--fs-small);
	}

	.certs__name {
		display: block;
		color: var(--text-secondary);
		font-size: var(--fs-small);
	}

	.certs__print {
		font-size: var(--fs-small);
	}

	/* A run of bytes stays whole; a long fingerprint breaks only between runs. */
	.certs__group {
		white-space: nowrap;
	}

	.certs__actions {
		display: flex;
	}

	.certs__error {
		margin: 0;
		color: var(--danger);
		font-size: var(--fs-small);
	}
</style>
