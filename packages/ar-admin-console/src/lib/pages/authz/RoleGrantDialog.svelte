<script lang="ts">
	import { untrack } from 'svelte';
	import {
		ROLE_SCOPE_TYPES,
		type GroupRoleInput,
		type RoleScopeType
	} from '#lib/api/end-user-groups.js';
	import type { EndUserRole } from '#lib/api/end-user-roles.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import EntityPicker, { type PickerItem } from '#lib/ui/patterns/EntityPicker.svelte';
	import FormDialog from '#lib/ui/patterns/FormDialog.svelte';
	import Select from '#lib/ui/primitives/Select.svelte';
	import TextField from '#lib/ui/primitives/TextField.svelte';
	import type { TimeZoneMode } from '#lib/ui/time/format-time.js';
	import { timePreference } from '#lib/ui/time/time-preference.svelte.js';
	import { readRoleEnd } from '../team/team-model';
	import { refusalText } from './authz-errors';
	import { SCOPE_LABEL, scopeTarget, scopeTargetProblem } from './group-model';
	import { roleLabel, withinCeiling } from './role-model';
	import type { PickerSearch } from './user-picker';

	/**
	 * Give a role, to a group or to one user: which role (those within the admin's grant
	 * ceiling), where it holds (everywhere, this tenant, for one group's resources, for one
	 * resource) and, optionally, when it ends.
	 */
	interface Props {
		open: boolean;
		title: string;
		description?: string;
		/** Every role of the tenant; null while they load. */
		roles: readonly EndUserRole[] | null;
		ceiling: number;
		/** Finds the group a group scope names (by key or name). */
		groupSearch: PickerSearch;
		/** Roles already given with the same scope are still offered: the API says if it is a repeat. */
		onsubmit: (input: GroupRoleInput) => Promise<void>;
		oncancel: () => void;
		/** Override the zone the end is typed in (tests; normally the admin's choice). */
		zone?: TimeZoneMode;
	}

	let { open, title, description, roles, ceiling, groupSearch, onsubmit, oncancel, zone }: Props =
		$props();

	const inZone = untrack(() => zone ?? timePreference.zone);
	const zoneNote = t('range.zone', { zone: inZone === 'utc' ? 'UTC' : t('range.local') });

	let roleId = $state('');
	let scope = $state<RoleScopeType>('global');
	let groupTarget = $state<PickerItem[]>([]);
	let resourceTarget = $state('');
	let ends = $state('');
	let endsIncomplete = $state(false);
	let tried = $state(false);
	let busy = $state(false);
	let error = $state('');

	$effect(() => {
		if (!open) return;
		roleId = '';
		scope = 'global';
		groupTarget = [];
		resourceTarget = '';
		ends = '';
		endsIncomplete = false;
		tried = false;
		error = '';
	});

	const offered = $derived((roles ?? []).filter((role) => withinCeiling(role, ceiling)));
	const target = $derived(
		scopeTarget(
			scope,
			scope === 'group' ? (groupTarget[0]?.value ?? '') : scope === 'resource' ? resourceTarget : ''
		)
	);
	const targetProblem = $derived(scopeTargetProblem(scope, target));
	const end = $derived(readRoleEnd(ends, endsIncomplete, inZone));

	async function submit() {
		tried = true;
		error = '';
		if (!roleId || targetProblem || end.problem) return;
		busy = true;
		try {
			await onsubmit({
				role_id: roleId,
				scope_type: scope,
				scope_target: target,
				expires_at: end.ms ?? null
			});
		} catch (failure) {
			error = refusalText(failure, t);
		} finally {
			busy = false;
		}
	}

	const badInput = (event: Event & { currentTarget: HTMLInputElement }) =>
		event.currentTarget.validity.badInput;
</script>

<FormDialog
	{open}
	{title}
	description={description ?? t('az.grant.desc', { ceiling })}
	submitLabel={t('az.grant.submit')}
	{busy}
	{error}
	onsubmit={submit}
	{oncancel}
>
	<Select
		label={t('az.grant.role')}
		options={offered.map((role) => ({
			value: role.id,
			label: `${roleLabel(role)} (${t('eur.tier.short', { tier: role.grant_tier })})`,
			description: role.description ?? undefined
		}))}
		placeholder
		required
		hint={roles === null
			? t('common.loading')
			: offered.length < (roles ?? []).length
				? t('az.grant.roleHidden', { ceiling })
				: undefined}
		error={tried && !roleId ? t('az.grant.roleRequired') : undefined}
		bind:value={roleId}
	/>
	<Select
		label={t('az.grant.scope')}
		hint={t('az.grant.scopeHint')}
		options={ROLE_SCOPE_TYPES.map((value) => ({ value, label: t(SCOPE_LABEL[value]) }))}
		bind:value={() => scope, (value) => (scope = value as RoleScopeType)}
	/>
	{#if scope === 'group'}
		<EntityPicker
			label={t('az.grant.scopeGroup')}
			placeholder={t('az.picker.groupPlaceholder')}
			multiple={false}
			required
			search={groupSearch}
			error={tried && targetProblem ? t(targetProblem) : undefined}
			bind:items={groupTarget}
		/>
	{:else if scope === 'resource'}
		<TextField
			label={t('az.grant.scopeResource')}
			hint={t('az.grant.scopeResourceHint')}
			required
			error={tried && targetProblem ? t(targetProblem) : undefined}
			bind:value={resourceTarget}
		/>
	{/if}
	<TextField
		label={t('tm.new.roleEnds')}
		type="datetime-local"
		hint={`${zoneNote} ${t('tm.new.roleEndsHint')}`}
		error={tried && end.problem ? t(end.problem) : undefined}
		oninput={(event) => (endsIncomplete = badInput(event))}
		onblur={(event) => (endsIncomplete = badInput(event))}
		bind:value={ends}
	/>
</FormDialog>
