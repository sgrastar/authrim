<script lang="ts">
	import type { ConditionTypeInfo } from '#lib/api/end-user-policies.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import FieldRow from '#lib/ui/patterns/FieldRow.svelte';
	import EntityPicker from '#lib/ui/patterns/EntityPicker.svelte';
	import JsonField from '#lib/ui/patterns/JsonField.svelte';
	import ListField from '#lib/ui/patterns/ListField.svelte';
	import TextRow from '#lib/ui/patterns/TextRow.svelte';
	import ToggleRow from '#lib/ui/patterns/ToggleRow.svelte';
	import Badge from '#lib/ui/primitives/Badge.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import NumberField from '#lib/ui/primitives/NumberField.svelte';
	import {
		numberOf,
		paramKind,
		toFieldsMode,
		toJsonMode,
		type ConditionDraft,
		type ConditionProblem
	} from './policy-model';
	import type { PickerSearch } from './user-picker';

	/**
	 * One condition of a rule, drawn from what the API says about its type: a field per
	 * parameter, by the parameter's declared type (text, number, switch, a list of values, a group
	 * or several groups picked from the tenant's groups). A condition the editor cannot draw is a
	 * JSON box; an admin can also switch any condition to JSON, and back while it fits.
	 */
	interface Props {
		draft: ConditionDraft;
		/** What the API says about the condition's type; absent for a type it does not list. */
		info: ConditionTypeInfo | undefined;
		/** Problems by parameter name (`''`: the whole condition), shown once the admin tried to save. */
		problems?: Record<string, ConditionProblem>;
		searchGroups: PickerSearch;
		onremove: () => void;
	}

	let { draft = $bindable(), info, problems, searchGroups, onremove }: Props = $props();

	/** The last switch back to fields was refused: the JSON is not a condition the fields can draw. */
	let notFields = $state(false);

	const problemText = (name: string) => {
		const problem = problems?.[name];
		return problem ? t(problem) : undefined;
	};
	const title = $derived(info?.label ?? draft.type);
	const drawable = $derived(info !== undefined && info.params.every((param) => paramKind(param)));
</script>

<div class="condition">
	<header class="head">
		<div class="titles">
			<strong>{title}</strong>
			<Badge>{draft.type}</Badge>
		</div>
		<div class="tools">
			{#if draft.mode === 'fields' && info}
				<Button size="sm" variant="ghost" icon="braces" onclick={() => toJsonMode(draft, info)}>
					{t('pol.cond.asJson')}
				</Button>
			{:else if drawable}
				<Button size="sm" variant="ghost" onclick={() => (notFields = !toFieldsMode(draft, info))}>
					{t('pol.cond.asFields')}
				</Button>
			{/if}
			<Button size="sm" variant="ghost" icon="trash" onclick={onremove}>
				{t('pol.cond.remove')}
			</Button>
		</div>
	</header>
	{#if info?.description}<p class="muted">{info.description}</p>{/if}

	{#if draft.mode === 'json' || !info}
		{#if !info}<p class="muted">{t('pol.cond.unknownType')}</p>{/if}
		<JsonField label={t('pol.cond.jsonLabel')} rows={6} bind:value={draft.json} />
		{#if problems?.['']}<p class="problem" role="alert">{problemText('')}</p>{/if}
		{#if notFields}<p class="problem" role="alert">{t('pol.cond.cannotFields')}</p>{/if}
	{:else if info.params.length === 0}
		<p class="muted">{t('pol.cond.noParams')}</p>
	{:else}
		{#each info.params as param (param.name)}
			{@const kind = paramKind(param)}
			{@const error = problemText(param.name)}
			{#if kind === 'string'}
				<TextRow
					label={param.label}
					required={param.required}
					{error}
					bind:value={draft.text[param.name]}
				/>
			{:else if kind === 'number'}
				<FieldRow label={param.label} required={param.required} plain>
					<NumberField
						label={param.label}
						hideLabel
						decimal
						required={param.required}
						{error}
						bind:value={
							() => numberOf(draft.text[param.name] ?? ''),
							(value) => (draft.text[param.name] = value === null ? '' : String(value))
						}
					/>
				</FieldRow>
			{:else if kind === 'boolean'}
				<ToggleRow label={param.label} bind:checked={draft.flags[param.name]} />
			{:else if kind === 'strings' || kind === 'numbers'}
				<FieldRow label={param.label} required={param.required} plain>
					<div class="stack">
						<ListField
							label={param.label}
							mono={kind === 'numbers'}
							raw
							validate={kind === 'numbers'
								? (value) => (numberOf(value) === null ? t('pol.cond.number') : undefined)
								: undefined}
							bind:values={draft.lists[param.name]}
						/>
						{#if error}<p class="problem" role="alert">{error}</p>{/if}
					</div>
				</FieldRow>
			{:else if kind === 'group'}
				<FieldRow label={param.label} required={param.required} plain>
					<EntityPicker
						label={param.label}
						placeholder={t('az.picker.groupPlaceholder')}
						multiple={false}
						search={searchGroups}
						{error}
						bind:items={draft.groups[param.name]}
					/>
				</FieldRow>
			{:else if kind === 'groups'}
				<FieldRow label={param.label} required={param.required} plain>
					<EntityPicker
						label={param.label}
						placeholder={t('az.picker.groupPlaceholder')}
						search={searchGroups}
						{error}
						bind:items={draft.groups[param.name]}
					/>
				</FieldRow>
			{/if}
		{/each}
	{/if}
</div>

<style>
	.condition {
		display: grid;
		gap: var(--space-related);
		padding: var(--box-pad);
		border: 1px solid var(--border);
		border-radius: var(--radius-control);
	}

	.head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-related);
	}

	.titles {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
	}

	.tools {
		display: flex;
		gap: 4px;
	}

	.muted {
		margin: 0;
		color: var(--text-muted);
		font-size: var(--fs-body);
	}

	.problem {
		margin: 0;
		color: var(--danger);
		font-size: var(--fs-small);
	}

	.stack {
		display: grid;
		gap: 4px;
	}
</style>
