<script lang="ts">
	import { t } from '#lib/i18n/i18n.svelte.js';
	import type { FederationCertificate } from '#lib/api/federation-sources.js';
	import Button from '#lib/ui/primitives/Button.svelte';
	import TextArea from '#lib/ui/primitives/TextArea.svelte';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import FileDrop from '#lib/ui/patterns/FileDrop.svelte';
	import { certificateFromPem, fingerprintDisplay } from './federation-model';

	/**
	 * The certificates a federation's metadata is signed with: pasted or uploaded as PEM, each
	 * shown with its SHA-256 fingerprint worked out in the browser. The fingerprint is the
	 * check: the federation publishes it, so compare the two before saving. Shared by the wizard
	 * and the federation's own page.
	 */
	interface Props {
		certificates: FederationCertificate[];
		disabled?: boolean;
	}
	let { certificates = $bindable(), disabled = false }: Props = $props();

	let pasted = $state('');
	let files = $state<File[]>([]);
	let error = $state('');

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

	$effect(() => {
		const [file] = files;
		if (!file) return;
		files = [];
		void file.text().then((text) => add(text));
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
					<div>
						<span class="certs__name">{t('sf.fed.cert.fingerprint')}</span>
						<code class="certs__print" dir="ltr"
							>{fingerprintDisplay(certificate.fingerprintSha256)}</code
						>
					</div>
					{#if !disabled}
						<Button size="sm" variant="ghost" onclick={() => remove(certificate.id)}
							>{t('sf.fed.cert.remove')}</Button
						>
					{/if}
				</li>
			{/each}
		</ul>
		<Callout tone="info">{t('sf.fed.cert.compare')}</Callout>
	{/if}
	{#if !disabled}
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
		<FileDrop label={t('sf.fed.cert.file')} accept=".pem,.crt,.cer,.txt" bind:files />
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

	.certs__name {
		display: block;
		color: var(--text-secondary);
		font-size: var(--fs-small);
	}

	.certs__print {
		overflow-wrap: anywhere;
		font-size: var(--fs-small);
	}

	.certs__actions {
		display: flex;
	}
</style>
