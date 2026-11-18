<script lang="ts" generics="T extends ImportForm">
	import { untrack } from 'svelte';
	import { SAML_METADATA_MAX_BYTES, type SamlMetadataClient } from '#lib/api/saml-providers.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import Disclosure from '#lib/ui/patterns/Disclosure.svelte';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import DetailItem from '#lib/ui/patterns/DetailItem.svelte';
	import DetailList from '#lib/ui/patterns/DetailList.svelte';
	import FileDrop from '#lib/ui/patterns/FileDrop.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import SegmentedControl from '#lib/ui/primitives/SegmentedControl.svelte';
	import TextArea from '#lib/ui/primitives/TextArea.svelte';
	import TextField from '#lib/ui/primitives/TextField.svelte';
	import { entityIdProblem, httpsUrlProblem, type ImportForm } from './connection-model';
	import { boundedMetadataXml } from './metadata-draft';

	let {
		form = $bindable(),
		partner,
		preview,
		allowManual = true
	}: {
		form: T;
		partner: 'service' | 'provider';
		preview?: SamlMetadataClient['preview'];
		allowManual?: boolean;
	} = $props();
	let files = $state<File[]>(untrack(() => (form.metadata?.file ? [form.metadata.file] : [])));
	let controller: AbortController | undefined;
	let generation = 0;
	let xmlTimer: ReturnType<typeof setTimeout> | undefined;
	const previewState = $derived(form.metadata);
	const addressLabel = $derived(t(partner === 'service' ? 'sf.ours.acsUrl' : 'sf.ours.ssoUrl'));
	const urlProblem = $derived(form.metadataUrl ? httpsUrlProblem(form.metadataUrl) : undefined);

	function cancel() {
		clearTimeout(xmlTimer);
		generation++;
		controller?.abort();
		if (form.metadata) form.metadata.pending = false;
	}
	function checkXmlSize(xml: string) {
		try {
			boundedMetadataXml(xml);
		} catch {
			throw new Error(t('sf.metadata.tooLarge'));
		}
	}

	async function read() {
		if (!preview || form.importMode === 'manual') return;
		cancel();
		const turn = generation;
		const mode = form.importMode;
		const url = form.metadataUrl;
		const file = files[0];
		const pastedXml = form.metadataXml;
		form.metadata ??= { pending: false, error: '' };
		const draft = form.metadata;
		draft.pending = true;
		draft.error = '';
		// A failed retry keeps the last successful preview for the same source.
		controller = new AbortController();
		const signal = controller.signal;
		try {
			let input;
			if (mode === 'url') input = { metadataUrl: url };
			else if (mode === 'xml') {
				checkXmlSize(pastedXml ?? '');
				input = { metadataXml: pastedXml ?? '' };
			} else {
				if (!file) throw new Error(t('sf.metadata.chooseFile'));
				if (file.size > SAML_METADATA_MAX_BYTES) throw new Error(t('sf.metadata.tooLarge'));
				const xml = await file.text();
				checkXmlSize(xml);
				input = { metadataXml: xml };
			}
			if (signal.aborted || turn !== generation) return;
			const result = await preview(input, partner === 'service' ? 'saml_sp' : 'saml_idp', signal);
			if (
				signal.aborted ||
				turn !== generation ||
				form.metadata !== draft ||
				form.importMode !== mode ||
				(mode === 'url'
					? form.metadataUrl !== url
					: mode === 'xml'
						? form.metadataXml !== pastedXml
						: files[0] !== file)
			)
				return;
			if (result.providerType !== (partner === 'service' ? 'saml_sp' : 'saml_idp'))
				throw new Error(
					t(partner === 'service' ? 'sf.metadata.wrongRoleSp' : 'sf.metadata.wrongRoleIdp')
				);
			checkXmlSize(result.metadataXml);
			draft.preview = result;
			draft.sourceXml = pastedXml;
		} catch (error) {
			if (signal.aborted || turn !== generation) return;
			draft.error = error instanceof Error ? error.message : t('sf.metadata.failed');
		} finally {
			if (turn === generation) draft.pending = false;
		}
	}

	let previous = untrack(() => ({
		mode: form.importMode,
		url: form.metadataUrl,
		xml: form.metadataXml,
		file: files[0]
	}));
	$effect(() => {
		const mode = form.importMode;
		const url = form.metadataUrl;
		const xml = form.metadataXml;
		const file = files[0];
		if (
			mode === previous.mode &&
			url === previous.url &&
			xml === previous.xml &&
			file === previous.file
		)
			return;
		previous = { mode, url, xml, file };
		untrack(() => {
			cancel();
			form.metadata = { pending: false, error: '', ...(file ? { file } : {}) };
			form.fileName = file?.name ?? '';
			if (mode === 'file' && file) void read();
			if (mode === 'xml' && xml?.trim()) xmlTimer = setTimeout(() => void read(), 250);
		});
	});
	$effect(() => () => cancel());
</script>

<SegmentedControl
	label={t(partner === 'service' ? 'sf.import.how.service' : 'sf.import.how.provider')}
	value={form.importMode}
	onchange={(value) => {
		if (value === 'url' || value === 'xml' || value === 'file' || value === 'manual')
			form.importMode = value;
	}}
	options={[
		{ value: 'url', label: t('sf.ours.metadataUrl'), disabled: !preview },
		{ value: 'xml', label: t('sf.import.mode.xml'), disabled: !preview },
		{ value: 'file', label: t('sf.import.mode.file'), disabled: !preview },
		...(allowManual ? [{ value: 'manual', label: t('sf.import.mode.manual') }] : [])
	]}
/>
{#if form.importMode === 'url'}
	<TextField
		label={t('sf.ours.metadataUrl')}
		hint={t('sf.metadata.urlHint')}
		error={urlProblem}
		bind:value={form.metadataUrl}
	/>
	<div>
		<Button
			variant="secondary"
			disabled={!preview || !form.metadataUrl || !!urlProblem}
			loading={previewState?.pending}
			onclick={read}>{t('sf.import.read')}</Button
		>
	</div>
{:else if form.importMode === 'xml'}
	<TextArea
		label={t('sf.import.mode.xml')}
		hint={t('sf.metadata.xmlHint')}
		mono
		bind:value={form.metadataXml}
	/>
{:else if form.importMode === 'file'}
	<FileDrop
		label={t('sf.import.file')}
		accept=".xml,application/xml,text/xml"
		maxBytes={SAML_METADATA_MAX_BYTES}
		bind:files
	/>
	{#if files.length}<div>
			<Button variant="secondary" loading={previewState?.pending} onclick={read}
				>{t('sf.import.read')}</Button
			>
		</div>{/if}
{:else}
	<TextField
		label={t('sf.row.entityId')}
		error={form.entityId ? entityIdProblem(form.entityId) : undefined}
		bind:value={form.entityId}
	/>
	<TextField
		label={addressLabel}
		error={form.acsUrl ? httpsUrlProblem(form.acsUrl) : undefined}
		bind:value={form.acsUrl}
	/>
{/if}
{#if previewState?.error}<Callout tone="warning" live>{previewState.error}</Callout>{/if}
{#if form.importMode !== 'manual' && previewState?.preview}
	<Callout tone="info" title={t('sf.import.found')}>
		<DetailList columns={1} size="sm">
			<DetailItem label={t('sf.row.entityId')}>{previewState.preview.entityId}</DetailItem>
			<DetailItem label={addressLabel}>{previewState.preview.address}</DetailItem>
			<DetailItem label={t('sf.ours.signingCert')}>
				{#if previewState.preview.certificates.length}
					{t('sf.metadata.certificates', { count: previewState.preview.certificates.length })}
					{#each previewState.preview.certificateSummaries ?? [] as summary (summary)}<p>
							<code>{summary}</code>
						</p>{/each}
					<Disclosure title={t('sf.ours.signingCert')}>
						{#each previewState.preview.certificates as certificate (certificate)}<pre>{certificate}</pre>{/each}
					</Disclosure>
				{:else}{t('sf.metadata.noCertificate')}{/if}
			</DetailItem>
		</DetailList>
		<p>{t('sf.metadata.previewOnly')}</p>
	</Callout>
{/if}

<style>
	pre {
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		font-size: var(--fs-small);
	}
</style>
