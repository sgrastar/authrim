<script lang="ts">
	import { t } from '$lib/i18n/i18n.svelte';
	import type { LayoutPart, LayoutRow } from '../builder/layout-model';
	import OptionListEditor from '../builder/OptionListEditor.svelte';
	import Callout from '../patterns/Callout.svelte';
	import Card from '../patterns/Card.svelte';
	import DetailItem from '../patterns/DetailItem.svelte';
	import DetailList from '../patterns/DetailList.svelte';
	import EmptyState from '../patterns/EmptyState.svelte';
	import Checkbox from '../primitives/Checkbox.svelte';
	import SegmentedControl from '../primitives/SegmentedControl.svelte';
	import Link from '../primitives/Link.svelte';
	import Select from '../primitives/Select.svelte';
	import SelectMenu, { type MenuOption } from '../primitives/SelectMenu.svelte';
	import TextArea from '../primitives/TextArea.svelte';
	import TextField from '../primitives/TextField.svelte';
	import { valueAt } from '../save/draft.svelte';
	import { provideSaveScope, useChangeMark } from '../save/save-scope';
	import { sample } from './sample';
	import {
		ACCOUNT_KINDS,
		CONDITION_KINDS,
		CHOICE_KINDS,
		INPUT_KINDS,
		LABEL_KINDS,
		METHODS,
		SCHEMA_FIELDS,
		SCHEMA_TYPES_FOR,
		fieldFits,
		schemaChoices,
		type SchemaField,
		partName,
		setting,
		type DisplayCondition,
		type PartSettings
	} from './screen-parts';

	/**
	 * Storybook demo: the settings of the selected part (or row), with the same parameters as
	 * the legacy screen editor. Fields carry SaveScope `field` paths, so changes are marked.
	 */
	interface Props {
		part?: LayoutPart | null;
		settings?: PartSettings | null;
		/** Whether the part's label differs from the saved one (found by id, not position). */
		labelChanged?: boolean;
		row?: LayoutRow | null;
		rowCondition?: DisplayCondition | null;
		rowNumber?: number;
		oncolumns?: (count: number) => void;
		/** The part or row is new since saving: the canvas marks it, not every field here. */
		isNew?: boolean;
	}

	let {
		part = $bindable(null),
		settings = $bindable(null),
		labelChanged = false,
		row = null,
		rowCondition = $bindable(null),
		rowNumber = 0,
		oncolumns,
		isNew = false
	}: Props = $props();

	// A new part has no saved settings: compare its fields with themselves, so none is marked.
	const outer = useChangeMark();
	provideSaveScope({
		original(field) {
			if (isNew && part && settings && field.startsWith(`settings.${part.id}.`)) {
				return valueAt({ settings: { [part.id]: settings } }, field);
			}
			if (isNew && row && rowCondition && field.startsWith(`rowSettings.${row.id}.`)) {
				return valueAt({ rowSettings: { [row.id]: rowCondition } }, field);
			}
			return outer.original(field);
		}
	});

	const methodOptions = $derived(METHODS.map(([value, key]) => ({ value, label: setting(key) })));
	const conditionOptions = $derived([
		{ value: 'always', label: setting('condAlways') },
		{ value: 'feature_enabled', label: setting('condFeature') },
		{ value: 'hidden', label: setting('condHidden') }
	]);
	/**
	 * Attributes by key and type. Those the part cannot store in stay listed, disabled and
	 * grouped after the rest, so the schema reads complete and the reason is visible.
	 * TODO(api): comes from the Identity Schema (active attributes incl. the fixed profile
	 * keys: field_key, field_type, cardinality, enum value count).
	 */
	function fieldOptions(kind: string): MenuOption[] {
		const row = (f: SchemaField, fits: boolean): MenuOption => ({
			value: f.key,
			label: f.key,
			badge: f.type,
			mono: true,
			disabled: !fits,
			group: setting(fits ? 'usable' : 'unusable'),
			description: f.choices?.length
				? setting('choicesN').replace('{n}', String(f.choices.length))
				: undefined
		});
		return [
			...SCHEMA_FIELDS.filter((f) => fieldFits(kind, f)).map((f) => row(f, true)),
			...SCHEMA_FIELDS.filter((f) => !fieldFits(kind, f)).map((f) => row(f, false))
		];
	}

	const storeHint = (kind: string) =>
		CHOICE_KINDS.has(kind)
			? setting('storeChoices')
			: setting('storeTypes').replace('{types}', (SCHEMA_TYPES_FOR[kind] ?? []).join(' / '));
</script>

{#snippet conditionFields(condition: DisplayCondition, path: string)}
	<Select
		field="{path}.mode"
		label={setting('condition')}
		options={conditionOptions}
		bind:value={condition.mode}
	/>
	{#if condition.mode === 'feature_enabled'}
		<Select
			field="{path}.feature"
			label={setting('feature')}
			options={methodOptions}
			bind:value={condition.feature}
		/>
	{/if}
{/snippet}

{#if part && settings}
	{@const path = `settings.${part.id}`}
	<Card title={sample('partSettings')} description={partName(part.kind)}>
		<div class="fields">
			<DetailList size="sm">
				<DetailItem label={setting('internalId')}><code>{part.id}</code></DetailItem>
			</DetailList>
			<TextField
				label={part.kind === 'divider' ? setting('dividerLabel') : setting('label')}
				hint={part.kind === 'divider' ? setting('dividerHint') : undefined}
				changed={labelChanged}
				bind:value={part.label}
			/>
			{#if LABEL_KINDS.has(part.kind)}
				<Checkbox
					field="{path}.showLabel"
					info={setting('showLabelInfo')}
					bind:checked={settings.showLabel}
				>
					{setting('showLabel')}
				</Checkbox>
			{/if}
			{#if CONDITION_KINDS.has(part.kind)}
				{@render conditionFields(settings.condition, `${path}.condition`)}
			{/if}

			{#if INPUT_KINDS.has(part.kind)}
				<Checkbox field="{path}.linked" info={setting('linkDbDesc')} bind:checked={settings.linked}>
					{setting('linkDb')}
				</Checkbox>
				<SelectMenu
					field="{path}.field"
					label={setting('identity')}
					options={fieldOptions(part.kind)}
					hint={settings.linked ? storeHint(part.kind) : undefined}
					disabled={!settings.linked}
					bind:value={settings.field}
				/>
				{#if part.kind === 'identity_field'}
					<TextField
						field="{path}.placeholder"
						label={setting('placeholder')}
						bind:value={settings.placeholder}
					/>
				{:else if part.kind === 'select'}
					<TextField
						field="{path}.placeholder"
						label={setting('selectPlaceholder')}
						hint={setting('selectPlaceholderHint')}
						bind:value={settings.placeholder}
					/>
				{/if}
				{#if CHOICE_KINDS.has(part.kind) && settings.linked}
					<!-- Linked: the values belong to the schema, shared by every screen and the API.
					     TODO(api): the link opens the attribute in the Identity Schema editor. -->
					<div class="schema-choices">
						<p class="schema-choices__title">{setting('schemaChoices')}</p>
						<ul>
							{#each schemaChoices(settings.field) as choice (choice.value)}
								<li><span>{choice.label}</span><code>{choice.value}</code></li>
							{/each}
						</ul>
						<p class="schema-choices__note">{setting('schemaChoicesNote')}</p>
						<Link href="#identity-schema" standalone>{setting('editInSchema')}</Link>
					</div>
				{:else if CHOICE_KINDS.has(part.kind)}
					<OptionListEditor field="{path}.options" bind:options={settings.options} />
				{/if}
				<TextArea
					field="{path}.helpText"
					label={setting('helpText')}
					rows={2}
					bind:value={settings.helpText}
				/>
				<Checkbox field="{path}.required" bind:checked={settings.required}>
					{setting('required')}
				</Checkbox>
				{#if settings.linked && settings.field === 'email'}
					<Callout>{setting('requiredBySchema')}</Callout>
				{/if}
			{:else if part.kind === 'auth_widget'}
				<Select
					field="{path}.method"
					label={setting('authMethod')}
					options={methodOptions}
					bind:value={settings.method}
				/>
				{#if settings.method === 'external_idp'}
					<Checkbox field="{path}.actionText" bind:checked={settings.actionText}>
						{setting('actionText')}
					</Checkbox>
				{/if}
			{:else if part.kind === 'code_input_widget'}
				<Select
					field="{path}.codeMode"
					label={setting('codeType')}
					options={[
						{ value: 'auto', label: setting('codeAuto') },
						{ value: 'mail_otp', label: setting('methodMailOtp') },
						{ value: 'totp', label: setting('methodTotp') }
					]}
					bind:value={settings.codeMode}
				/>
				<TextArea
					field="{path}.text"
					label={setting('description')}
					rows={3}
					bind:value={settings.text}
				/>
			{:else if part.kind === 'consent_widget'}
				<TextArea
					field="{path}.text"
					label={setting('description')}
					rows={3}
					bind:value={settings.text}
				/>
				<Checkbox field="{path}.required" bind:checked={settings.required}>
					{setting('required')}
				</Checkbox>
			{:else if part.kind === 'heading'}
				<TextArea
					field="{path}.text"
					label={setting('supporting')}
					rows={2}
					bind:value={settings.text}
				/>
			{:else if part.kind === 'text'}
				<TextArea field="{path}.text" label={setting('body')} rows={4} bind:value={settings.text} />
			{:else if part.kind === 'link'}
				<TextField
					field="{path}.href"
					label={setting('href')}
					hint={setting('hrefHint')}
					type="url"
					placeholder="https://"
					bind:value={settings.href}
				/>
			{:else if part.kind === 'security_verification'}
				<TextField field="{path}.text" label={setting('body')} bind:value={settings.text} />
				<Select
					field="{path}.timing"
					label={setting('captcha')}
					options={[
						{ value: 'initial', label: setting('captchaInitial') },
						{ value: 'submit', label: setting('captchaSubmit') }
					]}
					bind:value={settings.timing}
				/>
			{:else if ACCOUNT_KINDS.has(part.kind)}
				<Callout>{setting('widgetNote')}</Callout>
			{/if}
		</div>
	</Card>
{:else if row && rowCondition}
	<Card title={setting('rowSettings')} description={t('builder.row', { n: rowNumber })}>
		<div class="fields">
			<SegmentedControl
				label={setting('rowColumns')}
				hideLabel={false}
				size="sm"
				value={String(row.columns.length)}
				options={[1, 2, 3].map((count) => ({
					value: String(count),
					label: t('builder.columnsN', { n: count })
				}))}
				onchange={(value) => oncolumns?.(Number(value))}
			/>
			{@render conditionFields(rowCondition, `rowSettings.${row.id}`)}
		</div>
	</Card>
{:else}
	<Card title={sample('partSettings')}>
		<EmptyState icon="list" title={sample('noSelection')} />
	</Card>
{/if}

<style>
	.fields {
		display: grid;
		gap: var(--space-field);
	}

	code {
		font-family: var(--font-mono);
		font-size: var(--fs-caption);
		overflow-wrap: anywhere;
	}

	/* Read-only: what the schema allows, as a quiet list. */
	.schema-choices {
		display: grid;
		gap: 6px;
	}

	.schema-choices__title {
		margin: 0;
		color: var(--text-secondary);
		font-size: var(--fs-label);
		font-weight: var(--fw-semibold);
	}

	.schema-choices ul {
		margin: 0;
		padding: 0;
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-control);
		background: var(--bg-subtle);
		list-style: none;
	}

	.schema-choices li {
		display: flex;
		justify-content: space-between;
		gap: 12px;
		padding: 6px 10px;
		font-size: var(--fs-body);
	}

	.schema-choices li + li {
		border-top: 1px solid var(--border-subtle);
	}

	.schema-choices li code {
		color: var(--text-secondary);
	}

	.schema-choices__note {
		margin: 0;
		color: var(--text-muted);
		font-size: var(--fs-caption);
	}
</style>
