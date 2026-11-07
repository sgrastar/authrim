<script lang="ts">
	import { untrack } from 'svelte';
	import type { TeamAccess } from '#lib/access/access.js';
	import type { AdminDetail, AdminTeamClient, HeldRole, RoleChoice } from '#lib/api/admin-team.js';
	import { ConflictError } from '#lib/api/api-error.js';
	import { teamErrorCode } from '#lib/api/admin-team.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import Card from '#lib/ui/patterns/Card.svelte';
	import CellText from '#lib/ui/patterns/CellText.svelte';
	import ConfirmDialog from '#lib/ui/patterns/ConfirmDialog.svelte';
	import DataTable from '#lib/ui/patterns/DataTable.svelte';
	import EmptyState from '#lib/ui/patterns/EmptyState.svelte';
	import FormDialog from '#lib/ui/patterns/FormDialog.svelte';
	import ActionMenu, { type MenuAction } from '#lib/ui/primitives/ActionMenu.svelte';
	import Badge from '#lib/ui/primitives/Badge.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import Link from '#lib/ui/primitives/Link.svelte';
	import RadioGroup from '#lib/ui/primitives/RadioGroup.svelte';
	import Select from '#lib/ui/primitives/Select.svelte';
	import TextField from '#lib/ui/primitives/TextField.svelte';
	import { toInputValue } from '#lib/ui/patterns/date-range.js';
	import DateTime from '#lib/ui/time/DateTime.svelte';
	import type { TimeZoneMode } from '#lib/ui/time/format-time.js';
	import { timePreference } from '#lib/ui/time/time-preference.svelte.js';
	import { toast } from '#lib/ui/toast/toast.svelte.js';
	import { teamErrorKey } from './team-errors';
	import { grantableRoles, inputTimeToMs, roleLabel } from './team-model';

	/**
	 * The roles an administrator holds: given to them directly, or through an admin group (marked
	 * with the group, and changed in the group). A direct one can have its end changed or be
	 * removed; "Give role" adds one. Every change reloads the administrator.
	 */
	interface Props {
		client: AdminTeamClient;
		admin: AdminDetail;
		access: TeamAccess;
		/** Roles for every tenant can be given to this administrator here (home is the default tenant). */
		globalHere: boolean;
		/** A group's page, once there is one; without it the group is named only. */
		groupHref?: (groupId: string) => string;
		onchanged: () => Promise<void>;
		/** Override the zone times are typed in (tests; normally the admin's choice). */
		zone?: TimeZoneMode;
	}

	let { client, admin, access, globalHere, groupHref, onchanged, zone }: Props = $props();

	// Times are typed in the zone fixed when the page opens (the fields say which).
	const inZone = untrack(() => zone ?? timePreference.zone);
	const zoneNote = t('range.zone', { zone: inZone === 'utc' ? 'UTC' : t('range.local') });

	let busy = $state(false);
	let error = $state('');

	// Give role
	let granting = $state(false);
	let roles = $state<RoleChoice[] | null>(null);
	let roleId = $state('');
	let scope = $state<'tenant' | 'global'>('tenant');
	let grantEnds = $state('');
	let grantEndsBad = $state(false);
	/** An ended assignment of the chosen role and scope: giving the role renews it instead. */
	let renewing = $state<{
		roleId: string;
		scope: 'tenant' | 'global';
		assignmentId: string;
	} | null>(null);

	/** Thrown when giving the role found an ended assignment to renew instead (asked first). */
	class RenewOffered extends Error {}

	// Change end / remove
	let changing = $state<HeldRole | null>(null);
	let changeEnds = $state('');
	let changeEndsBad = $state(false);
	let removing = $state<HeldRole | null>(null);

	const badInput = (event: Event & { currentTarget: HTMLInputElement }) =>
		event.currentTarget.validity.badInput;

	async function openGrant() {
		error = '';
		roleId = '';
		scope = 'tenant';
		grantEnds = '';
		grantEndsBad = false;
		renewing = null;
		granting = true;
		if (roles) return;
		try {
			roles = grantableRoles(await client.listRoles());
		} catch (failure) {
			error = t(teamErrorKey(failure, 'tm.new.loadFailed'));
		}
	}

	/** The end typed, or a message when it cannot be read or is not ahead. */
	function readEnd(text: string, bad: boolean): { ms?: number; problem?: string } {
		if (bad) return { problem: t('tm.new.roleEndsInvalid') };
		if (!text) return {};
		const ms = inputTimeToMs(text, inZone);
		if (ms === undefined) return { problem: t('tm.new.roleEndsInvalid') };
		if (ms <= Date.now()) return { problem: t('tm.new.roleEndsPast') };
		return { ms };
	}

	async function run(change: () => Promise<void>, done: string, conflict?: 'tm.error.roleHeld') {
		busy = true;
		error = '';
		try {
			await change();
			toast.success(done);
			granting = false;
			changing = null;
			removing = null;
			await onchanged();
		} catch (failure) {
			const message =
				failure instanceof RenewOffered
					? t('tm.d.grant.endedFound')
					: t(teamErrorKey(failure, 'tm.error.generic', conflict));
			// A dialog keeps the message (and what was typed); a confirmation closes and toasts.
			if (removing) {
				removing = null;
				toast.error(message);
			} else {
				error = message;
			}
		} finally {
			busy = false;
		}
	}

	function grant() {
		const role = roles?.find((item) => item.id === roleId);
		if (!role) {
			error = t('tm.new.roleRequired');
			return;
		}
		const end = readEnd(grantEnds, grantEndsBad);
		if (end.problem) {
			error = end.problem;
			return;
		}
		const scopeNow = globalHere ? scope : 'tenant';
		const renew = renewing;
		if (renew && renew.roleId === role.id && renew.scope === scopeNow) {
			void run(
				() => client.setAssignmentExpiry(role.id, renew.assignmentId, end.ms ?? null),
				t('tm.toast.granted', { role: roleLabel(role) })
			);
			return;
		}
		void run(
			async () => {
				try {
					await client.grantRole(admin.id, {
						role_id: role.id,
						scope_type: scopeNow,
						expires_at: end.ms
					});
				} catch (failure) {
					// The generic conflict: held already, or held before and ended (not listed).
					if (failure instanceof ConflictError && teamErrorCode(failure) === 'invalid_request') {
						const ended = await client.findEndedAssignment(role.id, admin.id, scopeNow);
						if (ended) {
							renewing = { roleId: role.id, scope: scopeNow, assignmentId: ended };
							throw new RenewOffered();
						}
					}
					throw failure;
				}
			},
			t('tm.toast.granted', { role: roleLabel(role) }),
			'tm.error.roleHeld'
		);
	}

	function openChange(role: HeldRole) {
		error = '';
		changeEnds = role.expires_at
			? toInputValue(new Date(role.expires_at).toISOString(), inZone)
			: '';
		changeEndsBad = false;
		changing = role;
	}

	function change() {
		const role = changing;
		if (!role?.assignment_id) return;
		const end = readEnd(changeEnds, changeEndsBad);
		if (end.problem) {
			error = end.problem;
			return;
		}
		void run(
			() => client.setAssignmentExpiry(role.role_id, role.assignment_id!, end.ms ?? null),
			t('tm.toast.expiryChanged', { role: roleLabel(role) })
		);
	}

	function remove() {
		const role = removing;
		if (!role?.assignment_id) return;
		void run(
			() => client.removeAssignment(admin.id, role.assignment_id!),
			t('tm.toast.removed', { role: roleLabel(role) })
		);
	}

	/** A role for every tenant is changed only with the authority to give one, as the API checks. */
	// A role for every tenant: its end changes only with the authority to give one; it is
	// removed with the roles' write permission from a global assignment (the API weighs rank).
	const canChangeEnd = (role: HeldRole) =>
		access.expiry && (role.scope_type !== 'global' || access.global);
	const canRemove = (role: HeldRole) =>
		access.revoke && (role.scope_type !== 'global' || access.revokeGlobal);

	const actionsOf = (role: HeldRole): MenuAction[] => [
		...(canChangeEnd(role)
			? [
					{
						label: t('tm.d.action.expiry'),
						icon: 'calendar' as const,
						disabled: busy,
						onselect: () => openChange(role)
					}
				]
			: []),
		...(canRemove(role)
			? [
					{
						label: t('tm.d.action.remove'),
						icon: 'trash' as const,
						danger: true,
						disabled: busy,
						onselect: () => (removing = role)
					}
				]
			: [])
	];
	const changeable = (role: HeldRole) =>
		role.source === 'direct' && !!role.assignment_id && actionsOf(role).length > 0;

	const columns = $derived([
		{ key: 'role', label: t('tm.d.roles.col.role') },
		{ key: 'source', label: t('tm.d.roles.col.source'), width: '24%' },
		{ key: 'scope', label: t('tm.d.roles.col.scope'), width: '16%' },
		{ key: 'ends', label: t('tm.d.roles.col.ends'), width: '20%' },
		...(access.expiry || access.revoke
			? [
					{
						key: 'actions',
						label: t('tm.d.roles.col.actions', { name: '' }),
						width: '56px',
						hideLabel: true
					}
				]
			: [])
	]);

	const roleOptions = $derived(
		(roles ?? []).map((role) => ({ value: role.id, label: roleLabel(role) }))
	);
	const scopeOptions = $derived([
		{ value: 'tenant', label: t('tm.d.scope.tenant'), description: t('tm.new.scope.tenantBody') },
		{ value: 'global', label: t('tm.d.scope.global'), description: t('tm.d.grant.globalBody') }
	]);
	const keyOf = (role: HeldRole) =>
		role.assignment_id ?? `group:${role.group?.id ?? ''}:${role.role_id}:${role.scope_type}`;
</script>

<Card title={t('tm.d.roles')} description={t('tm.d.roles.desc')} flush>
	{#snippet actions()}
		{#if access.grant}
			<Button size="sm" icon="plus" onclick={openGrant}>{t('tm.d.grant')}</Button>
		{/if}
	{/snippet}
	<DataTable caption={t('tm.d.roles')} {columns} rows={admin.roles} rowKey={keyOf}>
		{#snippet cell(row, column)}
			{#if column.key === 'role'}
				<CellText title={roleLabel(row)} description={row.display_name ? row.name : undefined} />
			{:else if column.key === 'source'}
				{#if row.source === 'direct'}
					<Badge>{t('tm.d.source.direct')}</Badge>
				{:else if row.group && groupHref}
					<Link href={groupHref(row.group.id)}>
						{t('tm.d.source.group', { name: row.group.name ?? row.group.id })}
					</Link>
				{:else}
					<Badge tone="info">
						{row.group
							? t('tm.d.source.group', { name: row.group.name ?? row.group.id })
							: t('tm.d.source.groupUnnamed')}
					</Badge>
				{/if}
			{:else if column.key === 'scope'}
				{#if row.scope_type === 'global'}
					<Badge tone="warning">{t('tm.d.scope.global')}</Badge>
				{:else}
					{t('tm.d.scope.tenant')}
				{/if}
			{:else if column.key === 'ends'}
				{#if row.expires_at}
					<DateTime value={row.expires_at} stacked />
				{:else}
					{t('tm.d.noEnd')}
				{/if}
			{:else if changeable(row)}
				<ActionMenu
					size="sm"
					label={t('tm.d.roles.col.actions', { name: roleLabel(row) })}
					actions={actionsOf(row)}
				/>
			{/if}
		{/snippet}
		{#snippet empty()}
			<EmptyState
				icon="shield"
				title={t('tm.d.roles.empty')}
				description={t('tm.d.roles.emptyBody')}
			/>
		{/snippet}
	</DataTable>
</Card>

<FormDialog
	open={granting}
	title={t('tm.d.grant.title')}
	description={t('tm.d.grant.desc')}
	submitLabel={renewing && renewing.roleId === roleId
		? t('tm.d.grant.renew')
		: t('tm.d.grant.submit')}
	{busy}
	{error}
	onsubmit={grant}
	oncancel={() => (granting = false)}
>
	<Select
		label={t('tm.new.role')}
		options={roleOptions}
		placeholder
		required
		hint={t('tm.new.roleHint')}
		bind:value={roleId}
	/>
	{#if globalHere}
		<RadioGroup
			label={t('tm.new.scope')}
			options={scopeOptions}
			value={scope}
			onchange={(value) => (scope = value === 'global' ? 'global' : 'tenant')}
		/>
	{/if}
	<TextField
		label={t('tm.new.roleEnds')}
		type="datetime-local"
		hint={`${zoneNote} ${t('tm.new.roleEndsHint')}`}
		oninput={(event) => (grantEndsBad = badInput(event))}
		onblur={(event) => (grantEndsBad = badInput(event))}
		bind:value={grantEnds}
	/>
</FormDialog>

<FormDialog
	open={changing !== null}
	title={t('tm.d.expiry.title', { role: changing ? roleLabel(changing) : '' })}
	description={t('tm.d.expiry.desc')}
	submitLabel={t('tm.d.expiry.submit')}
	{busy}
	{error}
	onsubmit={change}
	oncancel={() => (changing = null)}
>
	<TextField
		label={t('tm.new.roleEnds')}
		type="datetime-local"
		hint={zoneNote}
		oninput={(event) => (changeEndsBad = badInput(event))}
		onblur={(event) => (changeEndsBad = badInput(event))}
		bind:value={changeEnds}
	/>
</FormDialog>

<ConfirmDialog
	open={removing !== null}
	title={t('tm.d.remove.title', { role: removing ? roleLabel(removing) : '' })}
	body={t('tm.d.remove.body')}
	confirmLabel={t('tm.d.action.remove')}
	tone="danger"
	{busy}
	onconfirm={remove}
	oncancel={() => (removing = null)}
/>
