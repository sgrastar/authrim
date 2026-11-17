<script lang="ts">
	import { untrack } from 'svelte';
	import type {
		SamlMetadataClient,
		SamlMetadataImportResult,
		SamlProviderKind
	} from '#lib/api/saml-providers.js';
	import { ApiError } from '#lib/api/api-error.js';
	import { StepUpCancelledError } from '#lib/api/admin-step-up.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import Disclosure from '#lib/ui/patterns/Disclosure.svelte';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import ConfirmDialog from '#lib/ui/patterns/ConfirmDialog.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import MetadataImport from './MetadataImport.svelte';
	import { emptyAnswers, type ImportForm } from './connection-model';
	import { metadataInput } from './metadata-draft';

	let {
		client,
		id,
		kind,
		updatedAt,
		metadataUrl = '',
		canPreview,
		canImport,
		busy = false,
		settingsDirty = false,
		mappingDirty = false,
		dirty = $bindable(false),
		pending = $bindable(false),
		onimported
	}: {
		client: SamlMetadataClient;
		id: string;
		kind: SamlProviderKind;
		updatedAt: string;
		metadataUrl?: string;
		canPreview: boolean;
		canImport: boolean;
		busy?: boolean;
		settingsDirty?: boolean;
		mappingDirty?: boolean;
		dirty?: boolean;
		pending?: boolean;
		onimported: (result: SamlMetadataImportResult) => void;
	} = $props();
	let form = $state<ImportForm>(
		untrack(() => ({ ...emptyAnswers().sp, importMode: 'url', metadataUrl }))
	);
	let importing = $state(false);
	let asking = $state(false);
	let failure = $state('');
	let saved = $state(false);
	let revision = $state(0);
	// Freeze the reviewed document and loaded version before confirmation and step-up.
	let confirmation:
		| { expectedUpdatedAt: string; metadataXml?: string; metadataUrl?: string }
		| undefined;
	const ready = $derived.by(() => {
		try {
			return !!metadataInput(form);
		} catch {
			return false;
		}
	});
	$effect(() => {
		dirty = !!form.metadata?.preview || !!form.metadata?.file || form.metadataUrl !== metadataUrl;
		pending = importing || !!form.metadata?.pending;
	});
	function requestImport() {
		if (!canImport || !canPreview || busy || mappingDirty || pending || !ready) return;
		const input = metadataInput(form);
		if (!input) return;
		confirmation = { ...input, expectedUpdatedAt: updatedAt };
		asking = true;
	}
	async function persist() {
		asking = false;
		if (!confirmation || !canImport || !canPreview || busy || mappingDirty || pending) return;
		const input = confirmation;
		confirmation = undefined;
		importing = true;
		failure = '';
		saved = false;
		try {
			const result = await client.importMetadata(id, input);
			onimported(result);
			form = { ...emptyAnswers().sp, importMode: 'url', metadataUrl: result.metadataUrl ?? '' };
			revision++;
			saved = true;
		} catch (error) {
			failure = t(
				error instanceof StepUpCancelledError
					? 'settings.stepUpCancelled'
					: error instanceof ApiError && error.status === 409
						? 'sf.live.conflict'
						: 'common.saveFailed'
			);
		} finally {
			importing = false;
		}
	}
</script>

<Disclosure title={t('sf.metadata.title')}>
	{#if !canImport || !canPreview}<Callout tone="info">{t('sf.metadata.permissions')}</Callout>
	{:else}
		<fieldset class="metadata-fields" disabled={busy || importing}>
			<legend class="sr-only">{t('sf.metadata.title')}</legend>
			{#key revision}
				<MetadataImport
					bind:form
					live
					partner={kind === 'saml_sp' ? 'service' : 'provider'}
					preview={client.preview}
					allowManual={false}
				/>
			{/key}
			{#if mappingDirty}<Callout tone="info">{t('sf.metadata.mappingDirty')}</Callout>{/if}
			{#if failure}<Callout tone="warning" live>{failure}</Callout>{/if}
			{#if saved}<Callout tone="info" live>{t('sf.live.saved')}</Callout>{/if}
			<div>
				<Button
					onclick={requestImport}
					loading={importing}
					disabled={!ready || busy || mappingDirty || pending}>{t('sf.metadata.confirm')}</Button
				>
				<Button
					variant="secondary"
					disabled={busy || pending || !dirty}
					onclick={() => {
						form = { ...emptyAnswers().sp, importMode: 'url', metadataUrl };
						revision++;
						failure = '';
						saved = false;
					}}>{t('sf.metadata.discard')}</Button
				>
			</div>
		</fieldset>
	{/if}
</Disclosure>
<ConfirmDialog
	open={asking}
	title={t('sf.metadata.confirm')}
	body={t(settingsDirty ? 'sf.metadata.dirtyConfirm' : 'sf.metadata.confirmBody')}
	confirmLabel={t('sf.metadata.confirm')}
	onconfirm={persist}
	oncancel={() => {
		asking = false;
		confirmation = undefined;
	}}
/>

<style>
	.metadata-fields {
		display: grid;
		gap: var(--space-field);
		min-width: 0;
		margin: 0;
		padding: 0;
		border: 0;
	}
</style>
