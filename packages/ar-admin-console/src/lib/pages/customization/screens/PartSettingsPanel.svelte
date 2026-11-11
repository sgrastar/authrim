<script lang="ts">
	import { t } from '#lib/i18n/i18n.svelte.js';
	import type { LayoutPart, LayoutRow } from '#lib/ui/builder/layout-model.js';
	import OptionListEditor from '#lib/ui/builder/OptionListEditor.svelte';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import Card from '#lib/ui/patterns/Card.svelte';
	import DetailItem from '#lib/ui/patterns/DetailItem.svelte';
	import DetailList from '#lib/ui/patterns/DetailList.svelte';
	import EmptyState from '#lib/ui/patterns/EmptyState.svelte';
	import Checkbox from '#lib/ui/primitives/Checkbox.svelte';
	import Link from '#lib/ui/primitives/Link.svelte';
	import SegmentedControl from '#lib/ui/primitives/SegmentedControl.svelte';
	import Select from '#lib/ui/primitives/Select.svelte';
	import SelectMenu, { type MenuOption } from '#lib/ui/primitives/SelectMenu.svelte';
	import TextArea from '#lib/ui/primitives/TextArea.svelte';
	import TextField from '#lib/ui/primitives/TextField.svelte';
	import { valueAt } from '#lib/ui/save/draft.svelte.js';
	import { provideSaveScope, useChangeMark } from '#lib/ui/save/save-scope.js';
	import { methodName, partName, setting } from './screen-copy';
	import {
		ACCOUNT_KINDS,
		CONDITION_KINDS,
		CHOICE_KINDS,
		INPUT_KINDS,
		LABEL_KINDS,
		LINK_ACTIONS,
		METHODS,
		SCHEMA_TYPES_FOR,
		fieldFits,
		type ChoiceSource,
		type DisplayCondition,
		type LinkAction,
		type PartSettings,
		type SchemaField
	} from './screen-model';

	/**
	 * The settings of the part (or row) selected in the screen builder. Fields carry SaveScope
	 * `field` paths, so changes are marked. A part linked to an attribute picks it from the
	 * Identity Schema (`schemaFields`). Existing unlinked fields keep their saved values until an
	 * attribute is chosen here; the answer configuration is hidden while its UX is reconsidered.
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
		/** The tenant's attributes a part can be linked to. */
		schemaFields?: readonly SchemaField[];
		/** An enum attribute's choices, by key. */
		choices?: ChoiceSource;
		/** Where the Identity Schema is edited. */
		schemaHref?: string;
		/** Shown, not edited (a built-in screen, or no permission to change it). */
		readonly?: boolean;
		/**
		 * The part is a legacy yes/no question saved in that form: its label is the question and
		 * its placeholder the text beside the box, as the Login UI shows them.
		 */
		legacyYesNo?: boolean;
		/**
		 * A link can leave the screen by a way out (next, back, skip, an exit): any screen of a flow.
		 * Not on the account page, which is not a flow: a link there opens a URL only.
		 */
		exitsAllowed?: boolean;
	}

	let {
		part = $bindable(null),
		settings = $bindable(null),
		labelChanged = false,
		row = null,
		rowCondition = $bindable(null),
		rowNumber = 0,
		oncolumns,
		isNew = false,
		schemaFields = [],
		choices = () => [],
		schemaHref,
		readonly = false,
		legacyYesNo = false,
		exitsAllowed = true
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

	const methodOptions = $derived(METHODS.map((value) => ({ value, label: methodName(value) })));
	const conditionOptions = $derived([
		{ value: 'always', label: setting('condAlways') },
		{ value: 'feature_enabled', label: setting('condFeature') },
		{ value: 'hidden', label: setting('condHidden') }
	]);
	/**
	 * Attributes by key and type. Those the part cannot store in stay listed, disabled and
	 * grouped after the rest, so the schema reads complete and the reason is visible.
	 */
	function fieldOptions(kind: string): MenuOption[] {
		const row = (f: SchemaField, fits: boolean): MenuOption => ({
			value: f.key,
			label: f.key,
			badge: f.type,
			mono: true,
			disabled: !fits,
			group: setting(fits ? 'usable' : 'unusable'),
			description: f.choices?.length ? setting('choicesN', { n: f.choices.length }) : undefined
		});
		return [
			...schemaFields.filter((f) => fieldFits(kind, f)).map((f) => row(f, true)),
			...schemaFields.filter((f) => !fieldFits(kind, f)).map((f) => row(f, false))
		];
	}

	const storeHint = (kind: string) =>
		CHOICE_KINDS.has(kind)
			? setting('storeChoices')
			: setting('storeTypes', { types: (SCHEMA_TYPES_FOR[kind] ?? []).join(' / ') });
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
	<Card title={t('sc.editor.partSettings')} description={partName(part.kind)}>
		<fieldset class="fields" disabled={readonly}>
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
				<Checkbox checked disabled>
					{setting('linkDb')}
				</Checkbox>
				<SelectMenu
					field="{path}.field"
					label={setting('identity')}
					options={fieldOptions(part.kind)}
					hint={storeHint(part.kind)}
					value={settings.linked ? settings.field : ''}
					onchange={(field) => {
						settings!.linked = true;
						settings!.field = field;
					}}
				/>
				{#if part.kind === 'checkbox' && legacyYesNo && settings.linked}
					<TextField
						field="{path}.placeholder"
						label={setting('checkboxText')}
						hint={setting('checkboxTextHint')}
						bind:value={settings.placeholder}
					/>
				{:else if part.kind === 'identity_field'}
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
					<!-- Linked: the values belong to the schema, shared by every screen and the API. -->
					<div class="schema-choices">
						<p class="schema-choices__title">{setting('schemaChoices')}</p>
						<ul>
							{#each choices(settings.field) as choice (choice.value)}
								<li><span>{choice.label}</span><code>{choice.value}</code></li>
							{/each}
						</ul>
						<p class="schema-choices__note">{setting('schemaChoicesNote')}</p>
						{#if schemaHref}
							<Link href={schemaHref} standalone>{setting('editInSchema')}</Link>
						{/if}
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
				<Select
					field="{path}.linkAction"
					label={setting('linkAction')}
					hint={setting(`linkActionHint.${settings.linkAction}`)}
					bind:value={
						() => settings?.linkAction ?? 'url',
						(value) =>
							settings &&
							(settings.linkAction = LINK_ACTIONS.includes(value as LinkAction)
								? (value as LinkAction)
								: 'url')
					}
					options={(exitsAllowed ? LINK_ACTIONS : (['url'] as const)).map((action) => ({
						value: action,
						label: setting(`linkAction.${action}`)
					}))}
				/>
				{#if settings.linkAction === 'url'}
					<TextField
						field="{path}.href"
						label={setting('href')}
						hint={setting('hrefHint')}
						type="url"
						placeholder="https://"
						bind:value={settings.href}
					/>
				{:else if settings.linkAction === 'exit'}
					<TextField
						field="{path}.linkExit"
						label={setting('linkExit')}
						hint={setting('linkExitHint')}
						required
						placeholder="social"
						bind:value={settings.linkExit}
					/>
				{/if}
				<SegmentedControl
					label={setting('linkStyle')}
					hideLabel={false}
					size="sm"
					field="{path}.linkStyle"
					bind:value={
						() => settings?.linkStyle ?? 'text',
						(value) => settings && (settings.linkStyle = value === 'button' ? 'button' : 'text')
					}
					options={[
						{ value: 'text', label: setting('linkStyleText') },
						{ value: 'button', label: setting('linkStyleButton') }
					]}
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
		</fieldset>
	</Card>
{:else if row && rowCondition}
	<Card title={setting('rowSettings')} description={t('builder.row', { n: rowNumber })}>
		<fieldset class="fields" disabled={readonly}>
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
		</fieldset>
	</Card>
{:else}
	<Card title={t('sc.editor.partSettings')}>
		<EmptyState icon="list" title={t('sc.editor.noSelection')} />
	</Card>
{/if}

<style>
	.fields {
		display: grid;
		gap: var(--space-field);
		/* A fieldset only to turn every control off at once: no frame of its own. */
		min-inline-size: 0;
		margin: 0;
		padding: 0;
		border: 0;
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
