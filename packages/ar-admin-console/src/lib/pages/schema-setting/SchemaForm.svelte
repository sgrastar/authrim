<script lang="ts">
	import { tick } from 'svelte';
	import { t } from '$lib/i18n/i18n.svelte';
	import {
		FIELD_TYPES,
		type Cardinality,
		type FieldType,
		type Schema
	} from '$lib/api/schema-setting';
	import Card from '$lib/ui/patterns/Card.svelte';
	import CheckRow from '$lib/ui/patterns/CheckRow.svelte';
	import FieldRow from '$lib/ui/patterns/FieldRow.svelte';
	import RowStack from '$lib/ui/patterns/RowStack.svelte';
	import SelectRow from '$lib/ui/patterns/SelectRow.svelte';
	import TextAreaRow from '$lib/ui/patterns/TextAreaRow.svelte';
	import TextRow from '$lib/ui/patterns/TextRow.svelte';
	import Button from '$lib/ui/primitives/Button.svelte';
	import type { Draft } from '$lib/ui/save/draft.svelte';
	import { SaveStopped } from '$lib/ui/save/save-scope';
	import SaveScope from '$lib/ui/save/SaveScope.svelte';
	import { problemsOf, type EditForm } from './edit-model';
	import { TYPE_KEY } from './labels';
	import RulesEditor from './RulesEditor.svelte';

	/**
	 * The settings of one attribute, confirmed with Save. What is wrong is said field by field
	 * once the field was changed, or once Save was pressed; Save then goes to the first of them
	 * and sends nothing.
	 */
	interface Props {
		draft: Draft<EditForm>;
		schema: Schema;
		/** Nothing can be changed: no permission, or the attribute is busy or failed. */
		frozen: boolean;
		/** The key, label, type and value count are locked as well (a base attribute). */
		identityLocked: boolean;
		canWrite: boolean;
		/** The attribute is at rest, so its key can be changed. */
		settled: boolean;
		/** Save was pressed with something wrong; the problems show even on untouched fields. */
		attempted?: boolean;
		/** Sends the change; throws to keep it unsaved. */
		onsave: (value: EditForm) => Promise<void>;
		onrename: () => void;
		onstate?: (state: { dirty: boolean; saving: boolean }) => void;
	}

	let {
		draft,
		schema,
		frozen,
		identityLocked,
		canWrite,
		settled,
		attempted = $bindable(false),
		onsave,
		onrename,
		onstate
	}: Props = $props();

	const problems = $derived(problemsOf(draft.value));
	const shows = (path: string) => attempted || draft.changed(path);
	const say = (problem: string | undefined, key: Parameters<typeof t>[0]) =>
		problem ? t(key) : undefined;

	async function save(value: EditForm) {
		if (Object.keys(problemsOf(value)).length > 0) {
			// Say what is wrong, field by field, and take the admin to the first one.
			attempted = true;
			await tick();
			document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
			throw new SaveStopped();
		}
		await onsave(value);
	}
</script>

<SaveScope {draft} onsave={save} {onstate}>
	<Card title={t('ss.section.identity')}>
		<RowStack ruled>
			<FieldRow label={t('ss.field.key')} plain align="text">
				<span class="key">
					<code>{schema.fieldKey}</code>
					{#if canWrite && settled && !schema.isSystem}
						<Button size="sm" variant="secondary" disabled={draft.dirty} onclick={onrename}
							>{t('ss.rename.action')}</Button
						>
					{/if}
				</span>
			</FieldRow>
			<TextRow
				label={t('ss.field.label')}
				required
				bind:value={draft.value.label}
				field="label"
				disabled={identityLocked}
				error={shows('label')
					? say(problems.label, problems.label === 'empty' ? 'ss.label.empty' : 'ss.label.too_long')
					: undefined}
			/>
			<SelectRow
				label={t('ss.field.type')}
				value={draft.value.type}
				field="type"
				disabled={identityLocked}
				onchange={(value) => (draft.value.type = value as FieldType)}
				options={FIELD_TYPES.map((value) => ({ value, label: t(TYPE_KEY[value]) }))}
			/>
			<SelectRow
				label={t('ss.field.cardinality')}
				info={t('ss.field.cardinalityHint')}
				value={draft.value.cardinality}
				field="cardinality"
				disabled={identityLocked}
				onchange={(value) => (draft.value.cardinality = value as Cardinality)}
				options={[
					{ value: 'single', label: t('ss.card.single') },
					{ value: 'multi', label: t('ss.card.multi') }
				]}
			/>
			<FieldRow label={t('ss.col.pii')} info={t('ss.locked.pii')} plain align="text">
				{t(schema.isPii ? 'ss.pii.yes' : 'ss.pii.no')}
			</FieldRow>
			<CheckRow
				label={t('ss.col.required')}
				text={t('ss.field.required')}
				info={t('ss.field.requiredHint')}
				bind:checked={draft.value.isRequired}
				field="isRequired"
				disabled={frozen}
			/>
			<CheckRow
				label={t('ss.field.active')}
				text={t('ss.field.active')}
				info={t('ss.field.activeHint')}
				bind:checked={draft.value.isActive}
				field="isActive"
				disabled={frozen}
			/>
			<TextAreaRow
				label={t('ss.field.description')}
				bind:value={draft.value.description}
				field="description"
				disabled={frozen}
				error={shows('description')
					? say(problems.description, 'ss.description.too_long')
					: undefined}
			/>
		</RowStack>
	</Card>

	<Card title={t('ss.rules.title')} info={t('ss.rules.lead')}>
		<RulesEditor
			type={draft.value.type}
			bind:form={draft.value.rules}
			fieldPath="rules"
			problems={shows('rules') ? (problems.rules ?? {}) : {}}
			disabled={frozen}
		/>
	</Card>

	<Card title={t('ss.section.advanced')}>
		<RowStack ruled>
			<CheckRow
				label={t('ss.field.searchable')}
				text={t('ss.field.searchable')}
				bind:checked={draft.value.isSearchable}
				field="isSearchable"
				disabled={frozen}
			/>
			<CheckRow
				label={t('ss.field.exportable')}
				text={t('ss.field.exportable')}
				bind:checked={draft.value.isExportable}
				field="isExportable"
				disabled={frozen}
			/>
		</RowStack>
	</Card>

	<Card title={t('ss.section.registration')} info={t('ss.reg.lead')}>
		<RowStack ruled>
			<CheckRow
				label={t('ss.reg.show')}
				text={t('ss.reg.show')}
				bind:checked={draft.value.showOnRegistration}
				field="showOnRegistration"
				disabled={frozen}
			/>
			{#if draft.value.showOnRegistration}
				<CheckRow
					label={t('ss.reg.required')}
					text={t('ss.reg.required')}
					bind:checked={draft.value.registrationRequired}
					field="registrationRequired"
					disabled={frozen}
				/>
				<TextRow
					label={t('ss.reg.order')}
					inputmode="numeric"
					bind:value={draft.value.registrationOrder}
					field="registrationOrder"
					disabled={frozen}
					error={shows('registrationOrder')
						? say(problems.registrationOrder, 'ss.reg.orderInvalid')
						: undefined}
				/>
				<TextRow
					label={t('ss.reg.placeholder')}
					bind:value={draft.value.registrationPlaceholder}
					field="registrationPlaceholder"
					disabled={frozen}
				/>
			{:else}
				<p class="muted">{t('ss.reg.showFirst')}</p>
			{/if}
		</RowStack>
	</Card>
</SaveScope>

<style>
	/* A key is an identifier: monospace, at body size. */
	code {
		font-family: var(--font-mono);
		font-size: var(--fs-body);
	}

	.key {
		display: inline-flex;
		flex-wrap: wrap;
		gap: 12px;
		align-items: center;
	}

	.muted {
		margin: 0;
		color: var(--text-secondary);
		font-size: var(--fs-small);
	}
</style>
