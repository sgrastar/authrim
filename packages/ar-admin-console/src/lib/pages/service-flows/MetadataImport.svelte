<script lang="ts" generics="T extends ImportForm">
	import { untrack } from 'svelte';
	import { t } from '$lib/i18n/i18n.svelte';
	import Callout from '$lib/ui/patterns/Callout.svelte';
	import DetailItem from '$lib/ui/patterns/DetailItem.svelte';
	import DetailList from '$lib/ui/patterns/DetailList.svelte';
	import FileDrop from '$lib/ui/patterns/FileDrop.svelte';
	import Button from '$lib/ui/primitives/Button.svelte';
	import SegmentedControl from '$lib/ui/primitives/SegmentedControl.svelte';
	import TextField from '$lib/ui/primitives/TextField.svelte';
	import {
		dummyMetadata,
		entityIdProblem,
		httpsUrlProblem,
		type ImportForm,
		type ImportMode
	} from './connection-model';

	/**
	 * Giving Authrim the other side's SAML details: a metadata address, a file, or by hand.
	 * The same for a service that signs in through Authrim and for a provider Authrim signs in
	 * through; only the words for the partner and for its sign-in address differ. Reading an
	 * address only pretends.
	 */
	interface Props {
		form: T;
		/** What the other side is called: "service" or "provider". */
		partner: 'service' | 'provider';
	}

	let { form = $bindable(), partner }: Props = $props();

	let files = $state<File[]>([]);
	let fetching = $state(false);
	const found = $derived(dummyMetadata(form.metadataUrl));
	const urlProblem = $derived(form.metadataUrl ? httpsUrlProblem(form.metadataUrl) : undefined);
	const addressLabel = $derived(t(partner === 'service' ? 'sf.ours.acsUrl' : 'sf.ours.ssoUrl'));

	/** Which read is the current one: a read for an address that has since changed is dropped. */
	let reads = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	function fetchMetadata() {
		const read = ++reads;
		const url = form.metadataUrl;
		fetching = true;
		clearTimeout(timer);
		timer = setTimeout(() => {
			if (read !== reads || form.metadataUrl !== url) return;
			form.fetched = true;
			fetching = false;
		}, 500);
	}

	// A step is built again each time it is reached, so these follow a change, not the first run:
	// coming back to it keeps what was read and which file was chosen.
	let picked = false;
	$effect(() => {
		if (files.length > 0) {
			picked = true;
			form.fileName = files[0].name;
		} else if (picked) {
			picked = false;
			form.fileName = '';
		}
	});

	let lastUrl = untrack(() => form.metadataUrl);
	$effect(() => {
		const url = form.metadataUrl;
		if (url === lastUrl) return;
		lastUrl = url;
		// Whatever was being read belongs to the old address.
		reads++;
		clearTimeout(timer);
		fetching = false;
		form.fetched = false;
	});

	// A read that is still waiting when this goes away is dropped with it.
	$effect(() => () => clearTimeout(timer));

	// The test passed for the details that were there then: other details need a new one.
	let lastDetails = untrack(() => details());
	function details() {
		return [form.importMode, form.metadataUrl, form.fileName, form.entityId, form.acsUrl].join('|');
	}
	$effect(() => {
		const now = details();
		if (now === lastDetails) return;
		lastDetails = now;
		if ('tested' in form) (form as { tested?: boolean }).tested = false;
	});
</script>

<SegmentedControl
	label={t(partner === 'service' ? 'sf.import.how.service' : 'sf.import.how.provider')}
	value={form.importMode}
	onchange={(value) => (form.importMode = value as ImportMode)}
	options={[
		{ value: 'url', label: t('sf.ours.metadataUrl') },
		{ value: 'file', label: t('sf.import.mode.file') },
		{ value: 'manual', label: t('sf.import.mode.manual') }
	]}
/>
{#if form.importMode === 'url'}
	<TextField
		label={t('sf.ours.metadataUrl')}
		placeholder={`https://${partner}.example/saml/metadata`}
		hint={t('sf.import.urlHint')}
		error={urlProblem}
		bind:value={form.metadataUrl}
	/>
	<div>
		<Button
			variant="secondary"
			disabled={!form.metadataUrl || !!urlProblem}
			loading={fetching}
			onclick={fetchMetadata}>{t('sf.import.read')}</Button
		>
	</div>
	{#if form.fetched}
		<Callout tone="info" title={t('sf.import.found')}>
			<DetailList columns={1} size="sm">
				<DetailItem label={t('sf.row.entityId')}>{found.entityId}</DetailItem>
				<DetailItem label={addressLabel}>{found.acsUrl}</DetailItem>
				<DetailItem label={t('sf.ours.signingCert')}>{found.certificate}</DetailItem>
			</DetailList>
		</Callout>
	{/if}
{:else if form.importMode === 'file'}
	<FileDrop label={t('sf.import.file')} accept=".xml,application/xml,text/xml" bind:files />
	{#if form.fileName && files.length === 0}
		{@const [before, after] = t('sf.import.usingFile').split('{file}')}
		<p class="lead">{before}<code>{form.fileName}</code>{after}</p>
	{/if}
{:else}
	<TextField
		label={t('sf.row.entityId')}
		placeholder={`https://${partner}.example/saml`}
		error={form.entityId ? entityIdProblem(form.entityId) : undefined}
		bind:value={form.entityId}
	/>
	<TextField
		label={addressLabel}
		placeholder={`https://${partner}.example/saml/${partner === 'service' ? 'acs' : 'sso'}`}
		error={form.acsUrl ? httpsUrlProblem(form.acsUrl) : undefined}
		bind:value={form.acsUrl}
	/>
{/if}

<style>
	.lead {
		margin: 0;
		color: var(--text-secondary);
	}
</style>
