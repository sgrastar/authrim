<script lang="ts">
	import { t } from '$lib/i18n/i18n.svelte';
	import {
		failureOf,
		FIELD_TYPES,
		type Cardinality,
		type FieldType,
		type Schema,
		type SchemaSettingClient
	} from '$lib/api/schema-setting';
	import CheckRow from '$lib/ui/patterns/CheckRow.svelte';
	import FormDialog from '$lib/ui/patterns/FormDialog.svelte';
	import SelectRow from '$lib/ui/patterns/SelectRow.svelte';
	import TextAreaRow from '$lib/ui/patterns/TextAreaRow.svelte';
	import TextRow from '$lib/ui/patterns/TextRow.svelte';
	import InfoTip from '$lib/ui/primitives/InfoTip.svelte';
	import { FAILURE_KEY, KEY_PROBLEM_KEY, TYPE_KEY } from './labels';
	import RulesEditor from './RulesEditor.svelte';
	import {
		checkKey,
		checkLabel,
		checkLength,
		checkRules,
		DESCRIPTION_MAX,
		emptyRulesForm,
		rulesFromForm
	} from './schema-validation';

	/**
	 * Adding an attribute of the tenant's own. What the API would refuse (a key that is reserved or
	 * already used, a label that is empty, rules that make no sense) is found here first, and said
	 * field by field: the API only answers "the field format is invalid".
	 */
	interface Props {
		client: SchemaSettingClient;
		tenantId: string;
		open: boolean;
		oncancel: () => void;
		oncreated: (schema: Schema) => void;
	}

	let { client, tenantId, open, oncancel, oncreated }: Props = $props();

	let key = $state('');
	let label = $state('');
	let type = $state<FieldType>('string');
	let cardinality = $state<Cardinality>('single');
	let isPii = $state(false);
	let isRequired = $state(false);
	let description = $state('');
	let rules = $state(emptyRulesForm());
	let showOnRegistration = $state(false);

	let reserved = $state<ReadonlySet<string>>(new Set());
	let taken = $state<ReadonlySet<string>>(new Set());
	let submitted = $state(false);
	let busy = $state(false);
	let error = $state('');

	// Starting over each time it opens, and fetching what the checks need: which names are
	// reserved and which keys the active attributes use. If that cannot be read, the API judges.
	$effect(() => {
		if (!open) return;
		key = '';
		label = '';
		type = 'string';
		cardinality = 'single';
		isPii = false;
		isRequired = false;
		description = '';
		rules = emptyRulesForm();
		showOnRegistration = false;
		submitted = false;
		error = '';
		void (async () => {
			try {
				const [names, active] = await Promise.all([
					client.reservedNames(tenantId),
					client.list(tenantId, { isActive: true, limit: 100 })
				]);
				reserved = new Set(names);
				taken = new Set(active.schemas.map((schema) => schema.fieldKey));
			} catch {
				// Leave the sets as they are.
			}
		})();
	});

	const keyProblem = $derived(checkKey(key, { reserved, taken }));
	const labelProblem = $derived(checkLabel(label));
	const descriptionProblem = $derived(checkLength(description, DESCRIPTION_MAX));
	const rulesProblems = $derived(checkRules(type, rules));
	const valid = $derived(
		!keyProblem && !labelProblem && !descriptionProblem && Object.keys(rulesProblems).length === 0
	);

	/** A problem is shown once something was typed in the field, or the form was submitted. */
	const keyMessage = $derived(
		keyProblem && (key !== '' || submitted) ? t(KEY_PROBLEM_KEY[keyProblem], { key }) : undefined
	);
	const labelMessage = $derived(
		labelProblem && (label !== '' || submitted)
			? t(labelProblem === 'empty' ? 'ss.label.empty' : 'ss.label.too_long')
			: undefined
	);

	async function submit() {
		submitted = true;
		if (!valid) return;
		busy = true;
		error = '';
		try {
			const created = await client.create(tenantId, {
				fieldKey: key,
				label: label.trim(),
				type,
				cardinality,
				isPii,
				isRequired,
				...(description.trim() ? { description: description.trim() } : {}),
				validation: rulesFromForm(type, rules),
				showOnRegistration
			});
			oncreated(created);
		} catch (failure) {
			error = t(FAILURE_KEY[failureOf(failure).kind]);
		} finally {
			busy = false;
		}
	}
</script>

<FormDialog
	{open}
	title={t('ss.create.title')}
	submitLabel={t('ss.create.submit')}
	{busy}
	{error}
	onsubmit={submit}
	{oncancel}
>
	<TextRow
		label={t('ss.field.key')}
		hint={t('ss.field.keyHint')}
		required
		bind:value={key}
		error={keyMessage}
		spellcheck={false}
		autocomplete="off"
	/>
	<TextRow label={t('ss.field.label')} required bind:value={label} error={labelMessage} />
	<SelectRow
		label={t('ss.field.type')}
		value={type}
		onchange={(value) => (type = value as FieldType)}
		options={FIELD_TYPES.map((value) => ({ value, label: t(TYPE_KEY[value]) }))}
	/>
	<SelectRow
		label={t('ss.field.cardinality')}
		info={t('ss.field.cardinalityHint')}
		value={cardinality}
		onchange={(value) => (cardinality = value as Cardinality)}
		options={[
			{ value: 'single', label: t('ss.card.single') },
			{ value: 'multi', label: t('ss.card.multi') }
		]}
	/>
	<CheckRow
		label={t('ss.col.pii')}
		text={t('ss.field.pii')}
		description={t('ss.field.piiHint')}
		bind:checked={isPii}
	/>
	<CheckRow
		label={t('ss.col.required')}
		text={t('ss.field.required')}
		info={t('ss.field.requiredHint')}
		bind:checked={isRequired}
	/>
	<TextAreaRow
		label={t('ss.field.description')}
		bind:value={description}
		error={descriptionProblem ? t('ss.description.too_long') : undefined}
	/>
	<CheckRow
		label={t('ss.section.registration')}
		text={t('ss.reg.show')}
		info={t('ss.reg.lead')}
		bind:checked={showOnRegistration}
	/>
	<h3 class="section">
		{t('ss.rules.title')}
		<InfoTip label="{t('common.moreInfo')}: {t('ss.rules.title')}" text={t('ss.rules.lead')} />
	</h3>
	<RulesEditor {type} bind:form={rules} problems={submitted ? rulesProblems : {}} />
</FormDialog>

<style>
	.section {
		display: flex;
		align-items: center;
		gap: 6px;
		margin: 0;
		font-size: var(--fs-label);
		font-weight: var(--fw-semibold);
	}
</style>
