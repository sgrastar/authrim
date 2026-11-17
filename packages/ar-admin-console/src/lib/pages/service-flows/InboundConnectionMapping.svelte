<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import type { InboundMappingClient, InboundMappingDocument } from '#lib/api/inbound-mapping.js';
	import type { FieldCatalogEntry } from '@authrim/ar-lib-field-mapping/contract';
	import { InboundMappingState } from './inbound-mapping.svelte.js';
	import MappingEditor from '#lib/ui/patterns/MappingEditor.svelte';
	import Card from '#lib/ui/patterns/Card.svelte';
	import Disclosure from '#lib/ui/patterns/Disclosure.svelte';
	import ConfirmDialog from '#lib/ui/patterns/ConfirmDialog.svelte';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import BusyScope from '#lib/ui/busy/BusyScope.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import Select from '#lib/ui/primitives/Select.svelte';
	import TextField from '#lib/ui/primitives/TextField.svelte';
	import TextArea from '#lib/ui/primitives/TextArea.svelte';
	import ToggleRow from '#lib/ui/patterns/ToggleRow.svelte';
	import LoadingState from '#lib/ui/patterns/LoadingState.svelte';
	let {
		client,
		kind,
		id,
		readonly = false,
		disabled = false,
		dirty = $bindable(false),
		pending = $bindable(false),
		bindingStatus = $bindable('loading'),
		settingsRevision = 0,
		onsaved
	}: {
		client: InboundMappingClient;
		kind: 'op' | 'idp';
		id: string;
		readonly?: boolean;
		disabled?: boolean;
		dirty?: boolean;
		pending?: boolean;
		bindingStatus?: 'loading' | 'configured' | 'unconfigured' | 'failed';
		settingsRevision?: number;
		onsaved: (document: InboundMappingDocument) => void;
	} = $props();
	const shared = untrack(() => new InboundMappingState(client, kind, id));
	let invalid = $state(false);
	let reload = $state(false);
	let sourcePath = $state('');
	let sourceMulti = $state(false);
	let sample = $state(
		untrack(() =>
			kind === 'op'
				? '{"sub":"synthetic-subject","email":"sample@example.test","name":"Sample Person"}'
				: '{"saml.subject":{"nameId":"synthetic-subject"},"saml.attribute":{"mail":"sample@example.test","name":"Sample Person"}}'
		)
	);
	let observedRevision = untrack(() => settingsRevision);
	$effect(() => {
		dirty = shared.dirty;
		pending = shared.pending;
		bindingStatus =
			shared.phase === 'failed'
				? 'failed'
				: shared.document
					? shared.document.configured
						? 'configured'
						: 'unconfigured'
					: 'loading';
	});
	$effect(() => {
		if (settingsRevision !== observedRevision) {
			observedRevision = settingsRevision;
			void shared.refreshRevision();
		}
	});
	onMount(() => {
		void shared.load();
		return () => shared.dispose();
	});
	function addSource() {
		const namespace = kind === 'op' ? 'oidc.userinfo' : 'saml.attribute';
		const path = sourcePath.trim();
		if (
			!path ||
			path.length > 512 ||
			shared.form.value.sources.some(
				(field) => field.namespace === namespace && field.path === path
			)
		)
			return;
		const field: FieldCatalogEntry = {
			id: `inbound.source.${namespace}:${path}`,
			namespace,
			path,
			cardinality: sourceMulti ? 'multi' : 'single',
			valueType: 'string',
			classification: 'pii',
			targetType: 'canonical'
		};
		shared.form.value.sources.push(field);
		sourcePath = '';
		sourceMulti = false;
	}
	async function save() {
		const result = await shared.save();
		if (result) onsaved(result);
	}
</script>

<Card title={t('sf.maps.in.title')} description={t('sf.maps.in.description')}>
	{#if shared.phase === 'loading'}<LoadingState label={t('common.loading')} />
	{:else if shared.phase === 'failed'}<Callout tone="warning"
			>{t('mc.loadFailed')}
			<Button onclick={() => shared.load()}>{t('common.retry')}</Button></Callout
		>
	{:else if shared.document && shared.context}
		{#if shared.document.legacyMappingPresent && !shared.document.configured}<Callout tone="info"
				>{t('cm.in.legacy')}</Callout
			>{/if}
		{#if shared.readonlyReason}<Callout tone="warning">{t('cm.readonly')}</Callout>
			<pre>{JSON.stringify(shared.document.content.rules, null, 2)}</pre>{/if}
		{#if shared.error}<Callout tone="warning" live
				>{t(shared.phase === 'conflict' ? 'cm.conflict' : 'mc.actionFailed')}
				{#if shared.phase === 'conflict'}<Button onclick={() => (reload = true)}
						>{t('cm.reload')}</Button
					>{/if}</Callout
			>{/if}
		{#if shared.phase === 'saved' && !shared.dirty}<Callout tone="info" live
				>{t('cm.saved')}</Callout
			>{/if}
		<BusyScope busy={readonly || disabled || shared.pending || shared.readonlyReason}>
			<MappingEditor
				label={t('sf.maps.in.label')}
				direction="inbound"
				allowIdentifiers={false}
				sources={shared.context.sources}
				targets={shared.context.targets}
				bind:mappings={shared.form.value.mappings}
				bind:invalid
			/>
			<Disclosure title={t('cm.in.schema')}>
				<p>{t('cm.in.schemaHelp')}</p>
				{#each shared.form.value.sources as field (field.id)}
					<Select
						label={`${field.namespace} · ${field.path}`}
						value={field.cardinality}
						options={[
							{ value: 'single', label: t('cm.in.single') },
							{ value: 'multi', label: t('cm.in.multiple') }
						]}
						onchange={(value) => {
							field.cardinality = value === 'multi' ? 'multi' : 'single';
						}}
						disabled={field.namespace === 'saml.subject' ||
							(field.namespace === 'oidc.userinfo' && field.path === 'email_verified')}
					/>
				{/each}
				<TextField label={t('cm.in.source')} bind:value={sourcePath} />
				<ToggleRow label={t('cm.in.multi')} bind:checked={sourceMulti} />
				<Button onclick={addSource} disabled={!sourcePath.trim()}>{t('cm.in.add')}</Button>
			</Disclosure>
		</BusyScope>
		<Disclosure title={t('cm.in.preview')}>
			<BusyScope busy={disabled || shared.pending || shared.readonlyReason}>
				<TextArea label={t('cm.in.sample')} bind:value={sample} />
				<Button
					onclick={() => shared.evaluate(sample)}
					disabled={invalid || !shared.form.value.mappings.length}
					loading={shared.phase === 'previewing'}>{t('cm.in.evaluate')}</Button
				>
			</BusyScope>
			{#if shared.preview}<pre aria-live="polite">{JSON.stringify(
						shared.preview,
						null,
						2
					)}</pre>{/if}
		</Disclosure>
		{#if !readonly}<Button
				onclick={save}
				variant="primary"
				loading={shared.phase === 'saving'}
				disabled={disabled ||
					shared.pending ||
					shared.readonlyReason ||
					invalid ||
					!shared.form.value.mappings.length ||
					(!shared.dirty && shared.document.configured)}>{t('common.save')}</Button
			>{/if}
	{/if}
</Card>
<ConfirmDialog
	open={reload}
	title={t('sf.live.reloadTitle')}
	body={t('sf.live.reloadBody')}
	confirmLabel={t('cm.reload')}
	onconfirm={() => {
		reload = false;
		void shared.load();
	}}
	oncancel={() => (reload = false)}
/>

<style>
	pre {
		overflow: auto;
		max-height: 24rem;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
</style>
