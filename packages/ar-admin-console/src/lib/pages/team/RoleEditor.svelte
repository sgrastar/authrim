<script lang="ts">
	import type { Snippet } from 'svelte';
	import { isExactMatchOnlyAdminPermission } from '@authrim/ar-lib-core/types/admin-user';
	import { hasPermission, type AdminAccess } from '#lib/access/access.js';
	import type { PermissionChoice } from '#lib/api/admin-roles.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import Card from '#lib/ui/patterns/Card.svelte';
	import CheckboxGroup from '#lib/ui/patterns/CheckboxGroup.svelte';
	import FieldRow from '#lib/ui/patterns/FieldRow.svelte';
	import RowStack from '#lib/ui/patterns/RowStack.svelte';
	import TextAreaRow from '#lib/ui/patterns/TextAreaRow.svelte';
	import TextRow from '#lib/ui/patterns/TextRow.svelte';
	import Checkbox from '#lib/ui/primitives/Checkbox.svelte';
	import NumberField from '#lib/ui/primitives/NumberField.svelte';
	import { groupPermissions, type RoleDraft } from './role-model';

	/**
	 * The editable part of a custom role: its display name and description, its rank and its
	 * permissions. The permissions offered are the ones the admin holds (the API refuses others),
	 * and the ones the role has already, so nothing it has is hidden.
	 */
	interface Props {
		draft: RoleDraft;
		permissions: readonly PermissionChoice[];
		/** Who is editing: the permissions they hold are the ones they can give. */
		access: AdminAccess;
		/** The rank field's problem, if any. */
		rankError?: string;
		/** The permissions' problem, if any. */
		permissionsError?: string;
		/** The name row, for a new role (set once). */
		name?: Snippet;
		/** The role it takes permissions from too (shown; not changed here). */
		inheritsFrom?: string | null;
		/** True while the rank holds something that is not a number that fits. */
		rankInvalid?: boolean;
		/** The permissions the role had when loaded: offered even after they are unticked. */
		savedPermissions?: readonly string[];
	}

	let {
		draft = $bindable(),
		permissions,
		access,
		rankError,
		permissionsError,
		name,
		inheritsFrom = null,
		rankInvalid = $bindable(false),
		savedPermissions = []
	}: Props = $props();

	// The API's list, and what the role has that is not on it (`admin:users:*`…), so nothing it
	// holds is hidden and every permission can be taken away.
	const known = $derived(new Set(permissions.map((permission) => permission.key)));
	const offered = $derived([
		...permissions.filter(
			(permission) =>
				permission.key !== '*' &&
				(hasPermission(access, permission.key) ||
					savedPermissions.includes(permission.key) ||
					draft.permissions.includes(permission.key))
		),
		...[...new Set([...savedPermissions, ...draft.permissions])]
			.filter((key) => key !== '*' && !known.has(key))
			.map((key) => ({ key, description: '' }))
	]);
	const canGiveAll = $derived(
		access.permissions.includes('*') ||
			savedPermissions.includes('*') ||
			draft.permissions.includes('*')
	);
	const all = $derived(draft.permissions.includes('*'));
	// With `*` chosen, only the permissions `*` does not cover (granted by exact name) stay listed.
	const groups = $derived(
		groupPermissions(
			all
				? offered.filter((permission) => isExactMatchOnlyAdminPermission(permission.key))
				: offered
		)
	);

	/** The choices of one resource, kept together with the rest of the role's permissions. */
	function selectedOf(keys: readonly string[]) {
		return draft.permissions.filter((permission) => keys.includes(permission));
	}
	function setSelected(keys: readonly string[], chosen: string[]) {
		draft.permissions = [
			...draft.permissions.filter((permission) => !keys.includes(permission)),
			...chosen
		];
	}
</script>

<Card title={t('tr.d.profile')}>
	<RowStack>
		{@render name?.()}
		<TextRow label={t('tr.new.displayName')} maxlength={100} bind:value={draft.display_name} />
		<TextAreaRow label={t('tr.new.description')} maxlength={500} bind:value={draft.description} />
		{#if inheritsFrom}
			<FieldRow label={t('tr.d.inherits')} align="text" plain>
				<p class="note"><code>{inheritsFrom}</code> — {t('tr.d.inheritsNote')}</p>
			</FieldRow>
		{/if}
		<FieldRow label={t('tr.new.rank')} plain>
			<NumberField
				label={t('tr.new.rank')}
				hideLabel
				min={0}
				max={1000}
				hint={t('tr.new.rankHint')}
				error={rankError}
				bind:invalid={rankInvalid}
				bind:value={() => draft.hierarchy_level, (value) => (draft.hierarchy_level = value ?? 0)}
			/>
		</FieldRow>
	</RowStack>
</Card>

<Card title={t('tr.new.permissions')} description={permissionsError ?? t('tr.new.permissionsHint')}>
	<RowStack>
		{#if canGiveAll}
			<Checkbox
				checked={all}
				onchange={(event) =>
					(draft.permissions = event.currentTarget.checked
						? ['*', ...draft.permissions.filter((permission) => permission !== '*')]
						: draft.permissions.filter((permission) => permission !== '*'))}
			>
				{t('tr.new.allPermissions')}
			</Checkbox>
		{/if}
		{#if groups.length > 0}
			{#each groups as group (group.resource)}
				{@const keys = group.items.map((item) => item.key)}
				<CheckboxGroup
					title={group.resource}
					options={group.items.map((item) => ({
						value: item.key,
						label: item.key.split(':').slice(2).join(':') || item.key,
						description: item.description
					}))}
					bind:selected={() => selectedOf(keys), (chosen) => setSelected(keys, chosen)}
				/>
			{/each}
		{/if}
	</RowStack>
</Card>

<style>
	.note {
		margin: 0;
		color: var(--text-muted);
	}
</style>
