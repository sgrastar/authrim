<script lang="ts">
	import type { LauncherGroup, LauncherVisibilityMode } from '#lib/api/launchers.js';
	import { t, type MessageKey } from '#lib/i18n/i18n.svelte.js';
	import Card from '#lib/ui/patterns/Card.svelte';
	import CheckRow from '#lib/ui/patterns/CheckRow.svelte';
	import EditableTable from '#lib/ui/patterns/EditableTable.svelte';
	import EntityPicker, { type PickerItem } from '#lib/ui/patterns/EntityPicker.svelte';
	import FieldRow from '#lib/ui/patterns/FieldRow.svelte';
	import RowStack from '#lib/ui/patterns/RowStack.svelte';
	import RadioGroup from '#lib/ui/primitives/RadioGroup.svelte';
	import { audienceLabel, operatorLabel } from './launcher-copy';
	import {
		ATTRIBUTE_KEY_PATTERN,
		ATTRIBUTE_OPERATORS,
		LIMITS,
		type AttributeRuleRow,
		type LauncherEditorValue,
		type ProblemField
	} from './launcher-model';

	/**
	 * Who sees a launcher on their account page: whether it is shown at all, then everyone, the
	 * users or groups picked here, or users whose attributes match the rules (all of them, or any).
	 * Users are found by searching; groups are the tenant's active groups.
	 */
	interface Props {
		value: LauncherEditorValue;
		groups: readonly LauncherGroup[];
		searchUsers: (query: string, signal: AbortSignal) => Promise<PickerItem[]>;
		errors: Partial<Record<ProblemField, MessageKey>>;
		disabled?: boolean;
	}

	let { value = $bindable(), groups, searchUsers, errors, disabled = false }: Props = $props();

	const error = (field: ProblemField) => (errors[field] ? t(errors[field]) : undefined);
	const modes: readonly LauncherVisibilityMode[] = ['everyone', 'users', 'groups', 'attributes'];
	const modeOptions = $derived(modes.map((mode) => ({ value: mode, label: audienceLabel(mode) })));

	async function searchGroups(query: string): Promise<PickerItem[]> {
		const text = query.trim().toLocaleLowerCase();
		return groups
			.filter(
				(group) =>
					!text ||
					group.display_name.toLocaleLowerCase().includes(text) ||
					group.group_key.toLocaleLowerCase().includes(text)
			)
			.slice(0, 50)
			.map((group) => ({
				value: group.id,
				label: group.display_name,
				description: group.group_key
			}));
	}

	const ruleColumns = $derived([
		{
			key: 'attribute_key',
			label: t('ln.field.ruleKey'),
			kind: 'text' as const,
			mono: true,
			required: true,
			width: '36%',
			validate: (key: string) =>
				ATTRIBUTE_KEY_PATTERN.test(key.trim()) ? undefined : t('ln.error.ruleKey')
		},
		{
			key: 'operator',
			label: t('ln.field.ruleOperator'),
			kind: 'select' as const,
			width: '24%',
			options: ATTRIBUTE_OPERATORS.map((operator) => ({
				value: operator,
				label: operatorLabel(operator)
			}))
		},
		{
			key: 'attribute_value',
			label: t('ln.field.ruleValue'),
			kind: 'text' as const,
			validate: (text: string, row: Record<string, unknown>) =>
				row.operator === 'exists' || text.trim()
					? text.trim().length > LIMITS.ruleValue
						? t('ln.error.ruleValueTooLong')
						: undefined
					: t('ln.error.ruleValue')
		}
	]);
	const newRule = (): AttributeRuleRow => ({
		id: crypto.randomUUID(),
		attribute_key: '',
		operator: 'equals',
		attribute_value: ''
	});
</script>

<Card title={t('ln.card.audience')}>
	<RowStack>
		<CheckRow
			label={t('ln.field.show')}
			text={t('ln.field.enabled')}
			field="enabled"
			{disabled}
			bind:checked={value.enabled}
		/>

		<FieldRow label={t('ln.field.audience')} align="text" plain>
			<RadioGroup
				label={t('ln.field.audience')}
				hideLabel
				options={modeOptions}
				field="audience"
				{disabled}
				bind:value={value.audience}
			/>
		</FieldRow>

		{#if value.audience === 'users'}
			<EntityPicker
				label={t('ln.field.users')}
				placeholder={t('ln.field.usersPlaceholder')}
				search={searchUsers}
				max={LIMITS.subjects}
				required
				field="users"
				error={error('users')}
				{disabled}
				bind:items={value.users}
			/>
		{:else if value.audience === 'groups'}
			<EntityPicker
				label={t('ln.field.groups')}
				placeholder={t('ln.field.groupsPlaceholder')}
				search={searchGroups}
				max={LIMITS.subjects}
				required
				field="groups"
				error={error('groups')}
				{disabled}
				bind:items={value.groups}
			/>
		{:else if value.audience === 'attributes'}
			<FieldRow label={t('ln.field.match')} align="text" plain>
				<RadioGroup
					label={t('ln.field.match')}
					hideLabel
					orientation="horizontal"
					options={[
						{ value: 'all', label: t('ln.field.matchAll') },
						{ value: 'any', label: t('ln.field.matchAny') }
					]}
					field="attributeMatch"
					{disabled}
					value={value.attributeMatch}
					onchange={(next) => (value.attributeMatch = next === 'any' ? 'any' : 'all')}
				/>
			</FieldRow>
			<div class="audience-fields__rules">
				<EditableTable
					label={t('ln.field.rules')}
					columns={ruleColumns}
					makeRow={newRule}
					addLabel={t('ln.field.ruleAdd')}
					hint={t('ln.field.rulesHint')}
					field="rules"
					bind:rows={value.rules}
				/>
				{#if errors.rules && value.rules.length === 0}
					<p class="audience-fields__error" role="alert">{t(errors.rules)}</p>
				{/if}
			</div>
		{/if}
	</RowStack>
</Card>

<style>
	.audience-fields__rules {
		display: grid;
		gap: var(--space-related);
		min-inline-size: 0;
	}

	.audience-fields__error {
		margin: 0;
		color: var(--danger);
		font-size: var(--fs-caption);
	}
</style>
