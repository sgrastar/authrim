<script lang="ts">
	import { untrack } from 'svelte';
	import type {
		SourceKind,
		SourceProfile,
		SourceProfileSaved,
		SourceProfilesClient
	} from '#lib/api/source-profiles.js';
	import { t, type MessageKey } from '#lib/i18n/i18n.svelte.js';
	import { profileKeyFor } from '#lib/pages/service-flows/destination-profile/destination-profile-model.js';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import Checkbox from '#lib/ui/primitives/Checkbox.svelte';
	import ColumnBrowser, { type BrowserItem } from '#lib/ui/patterns/ColumnBrowser.svelte';
	import EditableTable, { type EditColumn } from '#lib/ui/patterns/EditableTable.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import SegmentedControl from '#lib/ui/primitives/SegmentedControl.svelte';
	import Select from '#lib/ui/primitives/Select.svelte';
	import TextField from '#lib/ui/primitives/TextField.svelte';
	import {
		SOURCE_VALUE_TYPES,
		emptySourceForm,
		emptySourceRow,
		sourceFormFromSchema,
		sourceProblems,
		sourceSchemaFromForm,
		type SourceForm
	} from './source-profile-model';
	import { scimSourceTemplates, type SourceTemplate } from './source-templates';

	/**
	 * Makes or changes an input source: a title that can be changed, a way to start (a template for
	 * SCIM, a copy of an existing one, or nothing) and the attributes (columns) as a table edited in
	 * place. One save writes, reviews and switches the profile on.
	 */
	interface Props {
		kind: SourceKind;
		tenantId: string;
		client: SourceProfilesClient;
		/** The tenant's existing input sources of this kind (the ones that can be copied). */
		profiles: readonly SourceProfile[];
		/** Set: this one is changed; absent: a new one is made. */
		profile?: SourceProfile;
		/** Whether there is something unsaved or a save is under way (for leaving the page). */
		onstate?: (state: { dirty: boolean; saving: boolean }) => void;
		onsaved: (saved: SourceProfileSaved) => void;
		oncancel: () => void;
	}
	let { kind, tenantId, client, profiles, profile, onstate, onsaved, oncancel }: Props = $props();

	const plain = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
	const editing = untrack(() => profile !== undefined);
	type Method = 'existing' | 'template' | 'manual';
	let method = $state<Method>(untrack(() => (kind === 'scim' ? 'template' : 'manual')));
	const version = (row: SourceProfile) => row.activeVersion ?? row.version;
	let form = $state<SourceForm>(
		untrack(() => {
			const latest = profile?.version?.schema;
			return profile && latest
				? sourceFormFromSchema(kind, profile.displayName, plain(latest))
				: emptySourceForm(kind);
		})
	);
	let invalidRows = $state(false);
	let saving = $state(false);
	const initial = untrack(() => JSON.stringify(form));
	$effect(() => onstate?.({ dirty: JSON.stringify(form) !== initial, saving }));
	let failure = $state('');
	let draftReason = $state<string | null>(null);
	let writtenId = $state('');
	let advanced = $state(false);

	let filledName = '';
	function fillName(name: string) {
		if (!form.displayName.trim() || form.displayName === filledName) form.displayName = name;
		filledName = name;
	}

	const templates = $derived(kind === 'scim' ? scimSourceTemplates : []);
	function categoryKey(category: string): MessageKey {
		return category === 'Workforce' ? 'sf.dp.category.workforce' : 'sf.dp.category.general';
	}
	const groups = $derived(
		[...new Set(templates.map((template) => template.category))].map((category) => ({
			id: category,
			label: t(categoryKey(category)),
			icon: category === 'Workforce' ? ('building' as const) : ('gear' as const)
		}))
	);
	const items = $derived<(BrowserItem & { template: SourceTemplate })[]>(
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
	let used = $state('');

	function templateText(template: SourceTemplate): string {
		const key = `sf.sp.tpl.${template.id.replace('template_source_', '')}` as MessageKey;
		const text = t(key);
		return text === key ? template.description : text;
	}
	function useTemplate(template: SourceTemplate) {
		const next = sourceFormFromSchema(kind, '', plain(template.schema));
		form.rows = next.rows;
		form.rest = next.rest;
		fillName(template.displayName);
		used = template.displayName;
	}
	function copyExisting(id: string) {
		const source = profiles.find((row) => row.id === id);
		const schema = source ? version(source)?.schema : undefined;
		if (!source || !schema) return;
		const next = sourceFormFromSchema(kind, '', plain(schema));
		form.rows = next.rows;
		form.rest = next.rest;
		fillName(t('sf.dp.existing.copy', { name: source.displayName }));
	}

	const problems = $derived(sourceProblems(form));
	const blocked = $derived(problems.length > 0 || invalidRows);
	const options = (values: readonly string[]) => values.map((value) => ({ value, label: value }));
	const columns = $derived<EditColumn[]>([
		{
			key: 'key',
			label: t(kind === 'scim' ? 'sf.dp.col.attribute' : 'sf.sp.col.header'),
			kind: 'text',
			mono: true,
			required: true,
			unique: true,
			width: '26%'
		},
		{ key: 'label', label: t('sf.dp.col.label'), kind: 'text', width: '18%' },
		{
			key: 'valueType',
			label: t('sf.dp.col.type'),
			kind: 'select',
			options: options(SOURCE_VALUE_TYPES),
			width: '9rem'
		},
		{ key: 'required', label: t('sf.dp.col.required'), kind: 'checkbox', width: '6rem' },
		{
			key: 'mappingRequired',
			label: t('sf.sp.col.mappingRequired'),
			kind: 'checkbox',
			width: '8rem'
		},
		...(advanced
			? ([
					{
						key: 'classification',
						label: t('sf.dp.col.classification'),
						kind: 'select',
						options: options(['internal', 'public', 'pii', 'regulated', 'secret']),
						width: '9rem'
					},
					{
						key: 'multiplicity',
						label: t('sf.dp.col.multiplicity'),
						kind: 'select',
						options: options(['single', 'multi']),
						width: '8rem'
					},
					{ key: 'nullable', label: t('sf.dp.col.nullable'), kind: 'checkbox', width: '6rem' }
				] satisfies EditColumn[])
			: [])
	]);

	async function save() {
		if (blocked || saving) return;
		saving = true;
		failure = '';
		draftReason = null;
		try {
			const saved = await client.save(tenantId, {
				id: profile?.id ?? (writtenId || undefined),
				sourceType: kind,
				displayName: form.displayName.trim(),
				profileKey: profile || writtenId ? undefined : profileKeyFor(form.displayName),
				schema: plain(sourceSchemaFromForm(form))
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
		...(kind === 'scim' ? [{ value: 'template', label: t('sf.dp.method.template') }] : []),
		{ value: 'manual', label: t('sf.dp.method.manual') }
	]);
	const copyOptions = $derived(
		profiles
			.filter((row) => version(row)?.schema)
			.map((row) => ({ value: row.id, label: row.displayName }))
	);
</script>

<div class="editor">
	<h3 class="editor__title">{t(editing ? 'sf.sp.title.edit' : 'sf.sp.title.new')}</h3>
	<TextField
		label={t('sf.sp.name')}
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
						<span class="template__kind">{t('sf.sp.template.kind')}</span>
						<strong>{item.template.displayName}</strong>
						<p class="template__text">{templateText(item.template)}</p>
						<dl class="template__facts">
							<dt>{t('sf.dp.template.version')}</dt>
							<dd>{item.template.version}</dd>
							<dt>{t('sf.dp.template.updated')}</dt>
							<dd>{item.template.updatedAt}</dd>
						</dl>
						{#if previewing === item.id}
							<p class="template__names">
								{sourceFormFromSchema(kind, '', item.template.schema)
									.rows.map((row) => row.key)
									.join(', ')}
							</p>
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
				<Callout tone="info">{t('sf.sp.existing.none')}</Callout>
			{:else}
				<Select
					label={t('sf.sp.existing.choose')}
					placeholder={t('mc.ro.choose')}
					options={copyOptions}
					onchange={copyExisting}
				/>
			{/if}
		{/if}
	{/if}

	<div class="table">
		<div class="table__tools">
			<Checkbox bind:checked={advanced}>{t('sf.dp.advanced')}</Checkbox>
		</div>
		<EditableTable
			label={t(kind === 'scim' ? 'sf.sp.table.scim' : 'sf.sp.table.csv')}
			{columns}
			bind:rows={form.rows}
			makeRow={emptySourceRow}
			rowName={(row) => row.key}
			addLabel={t(kind === 'scim' ? 'sf.dp.addAttribute' : 'sf.sp.addColumn')}
			bind:invalid={invalidRows}
		/>
	</div>

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
		</Callout>
	{/if}
	<div class="editor__actions">
		<Button onclick={save} loading={saving} disabled={blocked}>{t('sf.dp.save')}</Button>
		<Button variant="secondary" onclick={oncancel} disabled={saving}>{t('common.cancel')}</Button>
	</div>
</div>

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

	.editor__problems {
		margin: 0;
		padding-inline-start: 1.2em;
	}

	.editor__actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-related);
	}

	.table {
		display: grid;
		gap: var(--space-related);
	}

	.table__tools {
		display: flex;
		justify-content: flex-end;
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
