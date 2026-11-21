<script lang="ts">
	import { untrack } from 'svelte';
	import type {
		DestinationProfileSaved,
		DestinationProfilesClient
	} from '#lib/api/destination-profiles.js';
	import { servingVersion, type MappingDestinationProfile } from '#lib/api/mapping-set.js';
	import { t, type MessageKey } from '#lib/i18n/i18n.svelte.js';
	import ColumnBrowser, { type BrowserItem } from '#lib/ui/patterns/ColumnBrowser.svelte';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import ConfirmDialog from '#lib/ui/patterns/ConfirmDialog.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import SegmentedControl from '#lib/ui/primitives/SegmentedControl.svelte';
	import Select from '#lib/ui/primitives/Select.svelte';
	import TextField from '#lib/ui/primitives/TextField.svelte';
	import {
		NAME_ID_FORMATS,
		NAME_ID_SOURCES,
		emptyProfileForm,
		formFromSchema,
		profileKeyFor,
		profileProblems,
		schemaFromForm,
		type ProfileForm
	} from './destination-profile-model';
	import ProfileTable from './ProfileTable.svelte';
	import { templatesFor } from './templates';
	import type { DestinationProtocol, DestinationTemplate } from './templates/types';

	/**
	 * Makes or changes an output source (what Authrim sends to an app or service) from a service
	 * flow: a title that can be changed, a way to start (a template, a copy of an existing one, or
	 * nothing), and the attributes (claims) as a table edited in place. A save is one action; the
	 * profile is switched on with it. Changing one that mapping sets already send into asks first,
	 * naming them, because the change reaches them at once.
	 */
	interface Props {
		protocol: DestinationProtocol;
		tenantId: string;
		client: DestinationProfilesClient;
		/** The tenant's existing profiles of this kind (the ones that can be copied). */
		profiles: readonly MappingDestinationProfile[];
		/** Set: this profile is changed; absent: a new one is made. */
		profile?: MappingDestinationProfile;
		/** Names of what sends into the profile now (mapping sets), asked about before a change. */
		usedBy?: readonly string[];
		/** What sends into the profile could not be fully checked: treated as in use. */
		usageUnknown?: boolean;
		/** Whether there is something unsaved or a save is under way (for leaving the page). */
		onstate?: (state: { dirty: boolean; saving: boolean }) => void;
		onsaved: (saved: DestinationProfileSaved) => void;
		oncancel: () => void;
	}
	let {
		protocol,
		tenantId,
		client,
		profiles,
		profile,
		usedBy = [],
		usageUnknown = false,
		onstate,
		onsaved,
		oncancel
	}: Props = $props();

	/** A copy that is plain data (a reactive value cannot be structurally cloned). */
	const plain = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

	type Method = 'existing' | 'template' | 'manual';
	const editing = untrack(() => profile !== undefined);
	let method = $state<Method>('template');
	let form = $state<ProfileForm>(
		untrack(() =>
			profile?.version
				? formFromSchema(protocol, profile.displayName, plain(profile.version.schema))
				: emptyProfileForm(protocol)
		)
	);
	// A profile written by an earlier try of this save (its review or switching on stopped): the
	// next save changes it rather than making another.
	let writtenId = $state('');
	const initial = untrack(() => JSON.stringify(form));
	$effect(() => onstate?.({ dirty: JSON.stringify(form) !== initial, saving }));
	let invalidRows = $state(false);
	let saving = $state(false);
	let failure = $state('');
	let draftReason = $state<string | null>(null);
	let confirming = $state(false);

	// What the title was last filled with by a template or a copy: a title the person has
	// changed is left alone when another is picked.
	let filledName = '';
	function fillName(name: string) {
		if (!form.displayName.trim() || form.displayName === filledName) form.displayName = name;
		filledName = name;
	}

	const templates = $derived(templatesFor(protocol));
	const groups = $derived(
		[...new Set(templates.map((template) => template.category))].map((category) => ({
			id: category,
			label: t(categoryKey(category)),
			icon:
				category === 'General settings'
					? ('gear' as const)
					: category === 'Vendor specific'
						? ('building' as const)
						: ('book' as const)
		}))
	);
	/** The template's description in the current language (the catalogue's own English when there is none). */
	function templateText(template: DestinationTemplate): string {
		const key = `sf.dp.tpl.${template.id.replace('template_destination_', '')}` as MessageKey;
		const text = t(key);
		return text === key ? template.description : text;
	}
	function categoryKey(category: string): MessageKey {
		return category === 'General settings'
			? 'sf.dp.category.general'
			: category === 'Vendor specific'
				? 'sf.dp.category.vendor'
				: 'sf.dp.category.academic';
	}
	const items = $derived<(BrowserItem & { template: DestinationTemplate })[]>(
		templates.map((template) => ({
			id: template.id,
			groupId: template.category,
			label: template.displayName,
			template
		}))
	);
	let groupId = $state('');
	let itemId = $state('');
	let previewing = $state('');

	function useTemplate(template: DestinationTemplate) {
		const next = formFromSchema(protocol, form.displayName, plain(template.schema));
		form.nameIdFormat = next.nameIdFormat;
		form.nameIdSource = next.nameIdSource;
		form.rows = next.rows;
		form.rest = next.rest;
		fillName(template.displayName);
		used = template.displayName;
	}
	let used = $state('');

	function copyExisting(id: string) {
		const source = profiles.find((row) => row.id === id);
		const version = source ? servingVersion(source) : null;
		if (!source || !version) return;
		const next = formFromSchema(protocol, '', plain(version.schema));
		form.nameIdFormat = next.nameIdFormat;
		form.nameIdSource = next.nameIdSource;
		form.rows = next.rows;
		form.rest = next.rest;
		fillName(t('sf.dp.existing.copy', { name: source.displayName }));
	}

	const problems = $derived(profileProblems(form));
	const blocked = $derived(problems.length > 0 || invalidRows);

	function attributeNames(template: DestinationTemplate): string[] {
		return formFromSchema(protocol, '', template.schema).rows.map((row) => row.key);
	}

	function requestSave() {
		if (blocked || saving) return;
		if (editing && (usedBy.length > 0 || usageUnknown)) confirming = true;
		else void save();
	}
	async function save() {
		confirming = false;
		saving = true;
		failure = '';
		draftReason = null;
		try {
			const saved = await client.save(tenantId, {
				id: profile?.id ?? (writtenId || undefined),
				destinationType: protocol,
				displayName: form.displayName.trim(),
				profileKey: profile || writtenId ? undefined : profileKeyFor(form.displayName),
				schema: plain(schemaFromForm(form))
			});
			writtenId = saved.profile.id;
			if (saved.active) onsaved(saved);
			else draftReason = saved.reason ?? '';
		} catch (error) {
			failure = error instanceof Error && error.message ? error.message : t('sf.dp.saveFailed');
		} finally {
			saving = false;
		}
	}

	const methodOptions = $derived([
		{ value: 'existing', label: t('sf.dp.method.existing') },
		{ value: 'template', label: t('sf.dp.method.template') },
		{ value: 'manual', label: t('sf.dp.method.manual') }
	]);
	const formatOptions = $derived(
		NAME_ID_FORMATS.map((value) => ({
			value,
			label: t(`sf.dp.nameIdFormat.${nameIdFormatKey(value)}` as MessageKey)
		}))
	);
	const sourceOptions = $derived(
		NAME_ID_SOURCES.map((value) => ({
			value,
			label: t(`sf.dp.nameIdSource.${value}` as MessageKey)
		}))
	);
	function nameIdFormatKey(value: string): string {
		return value.endsWith('emailAddress') ? 'email' : (value.split('-format:')[1] ?? value);
	}
	const copyOptions = $derived(
		profiles
			.filter((row) => servingVersion(row))
			.map((row) => ({ value: row.id, label: row.displayName }))
	);
</script>

<div class="editor">
	<h3 class="editor__title">{t(editing ? 'sf.dp.title.edit' : 'sf.dp.title.new')}</h3>
	<TextField
		label={t('sf.dp.name')}
		hint={t('sf.dp.nameHint')}
		required
		bind:value={form.displayName}
	/>

	{#if !editing}
		<SegmentedControl label={t('sf.dp.method')} options={methodOptions} bind:value={method} />
		{#if method === 'template'}
			<ColumnBrowser label={t('sf.dp.templates')} {groups} {items} bind:groupId bind:itemId>
				{#snippet detail(item)}
					<div class="template">
						<span class="template__kind">{t(`sf.dp.template.kind.${protocol}`)}</span>
						<strong>{item.template.displayName}</strong>
						<p class="template__text">{templateText(item.template)}</p>
						<dl class="template__facts">
							<dt>{t('sf.dp.template.version')}</dt>
							<dd>{item.template.version}</dd>
							<dt>{t('sf.dp.template.updated')}</dt>
							<dd>{item.template.updatedAt}</dd>
						</dl>
						{#if previewing === item.id}
							<p class="template__names">{attributeNames(item.template).join(', ')}</p>
						{/if}
						<div class="template__actions">
							<Button
								variant="secondary"
								size="sm"
								onclick={() => (previewing = previewing === item.id ? '' : item.id)}
								>{t(
									previewing === item.id ? 'sf.dp.template.hidePreview' : 'sf.dp.template.preview'
								)}</Button
							>
							<Button size="sm" onclick={() => useTemplate(item.template)}
								>{t('sf.dp.template.use')}</Button
							>
						</div>
					</div>
				{/snippet}
			</ColumnBrowser>
			{#if used}<Callout tone="info" live>{t('sf.dp.template.used', { name: used })}</Callout>{/if}
		{:else if method === 'existing'}
			{#if copyOptions.length === 0}
				<Callout tone="info">{t('sf.dp.existing.none')}</Callout>
			{:else}
				<Select
					label={t('sf.dp.existing.choose')}
					placeholder={t('mc.ro.choose')}
					options={copyOptions}
					onchange={copyExisting}
				/>
			{/if}
		{/if}
	{/if}

	{#if protocol === 'saml'}
		<p class="editor__hint">{t('sf.dp.nameId.hint')}</p>
		<div class="editor__nameid">
			<Select
				label={t('sf.dp.nameId.format')}
				options={formatOptions}
				bind:value={form.nameIdFormat}
			/>
			<Select
				label={t('sf.dp.nameId.source')}
				options={sourceOptions}
				bind:value={form.nameIdSource}
			/>
		</div>
	{/if}
	<ProfileTable {protocol} bind:rows={form.rows} bind:invalid={invalidRows} />

	{#if problems.length > 0 && (form.rows.length > 0 || form.displayName.trim())}
		<Callout tone="info">
			<ul class="editor__problems">
				{#each problems as problem (problem.key)}<li>{problem.message}</li>{/each}
			</ul>
		</Callout>
	{/if}
	{#if failure}<Callout tone="danger" live>{failure}</Callout>{/if}
	{#if draftReason !== null}
		<Callout tone="warning" live title={t('sf.dp.draft.title')}>
			{t('sf.dp.draft.body')}
			{#if draftReason}<code>{draftReason}</code>{/if}
			{#if profile?.lifecycleState === 'active'}<p class="editor__warn">
					{t('sf.dp.draft.editWarning')}
				</p>{/if}
		</Callout>
	{/if}
	<div class="editor__actions">
		<Button onclick={requestSave} loading={saving} disabled={blocked}>{t('sf.dp.save')}</Button>
		<Button variant="secondary" onclick={oncancel} disabled={saving}>{t('common.cancel')}</Button>
	</div>
</div>

<ConfirmDialog
	open={confirming}
	title={t('sf.dp.impact.title')}
	body={usedBy.length > 0
		? t('sf.dp.impact.body', { names: usedBy.join(', ') })
		: t('sf.dp.impact.unknown')}
	confirmLabel={t('sf.dp.impact.confirm')}
	onconfirm={() => void save()}
	oncancel={() => (confirming = false)}
/>

<style>
	.editor {
		display: grid;
		gap: var(--space-field);
		min-width: 0;
	}

	.editor__title {
		margin: 0;
		font-size: var(--fs-heading-sm, var(--fs-body));
	}

	.editor__hint {
		margin: 0;
		color: var(--text-secondary);
		font-size: var(--fs-small);
	}

	.editor__nameid {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-grid);
	}

	.editor__warn {
		margin: 6px 0 0;
	}

	.editor__problems {
		margin: 0;
		padding-inline-start: 1.2em;
	}

	.editor__actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-related);
	}

	.template {
		display: grid;
		gap: 8px;
	}

	.template__kind {
		color: var(--text-muted);
		font-size: var(--fs-small);
		letter-spacing: 0.04em;
		text-transform: uppercase;
	}

	.template__text {
		margin: 0;
		color: var(--text-secondary);
		font-size: var(--fs-small);
	}

	.template__facts {
		display: grid;
		grid-template-columns: auto 1fr;
		gap: 4px 16px;
		margin: 0;
		font-size: var(--fs-small);
	}

	.template__facts dt {
		color: var(--text-secondary);
	}

	.template__facts dd {
		margin: 0;
		text-align: end;
	}

	.template__names {
		margin: 0;
		font-size: var(--fs-small);
		overflow-wrap: anywhere;
	}

	.template__actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-related);
	}
</style>
