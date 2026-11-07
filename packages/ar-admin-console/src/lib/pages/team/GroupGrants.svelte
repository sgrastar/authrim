<script lang="ts">
	import { untrack } from 'svelte';
	import type { TeamAccess } from '#lib/access/access.js';
	import type {
		AdminGroupDetail,
		AdminGroupGrant,
		AdminGroupsClient
	} from '#lib/api/admin-groups.js';
	import type { AdminTeamClient, RoleChoice } from '#lib/api/admin-team.js';
	import { ConflictError } from '#lib/api/api-error.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import Card from '#lib/ui/patterns/Card.svelte';
	import CellText from '#lib/ui/patterns/CellText.svelte';
	import ConfirmDialog from '#lib/ui/patterns/ConfirmDialog.svelte';
	import DataTable from '#lib/ui/patterns/DataTable.svelte';
	import { toInputValue } from '#lib/ui/patterns/date-range.js';
	import EmptyState from '#lib/ui/patterns/EmptyState.svelte';
	import FormDialog from '#lib/ui/patterns/FormDialog.svelte';
	import ActionMenu, { type MenuAction } from '#lib/ui/primitives/ActionMenu.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import Select from '#lib/ui/primitives/Select.svelte';
	import TextField from '#lib/ui/primitives/TextField.svelte';
	import DateTime from '#lib/ui/time/DateTime.svelte';
	import type { TimeZoneMode } from '#lib/ui/time/format-time.js';
	import { timePreference } from '#lib/ui/time/time-preference.svelte.js';
	import { toast } from '#lib/ui/toast/toast.svelte.js';
	import { teamErrorKey } from './team-errors';
	import { grantableRoles, readRoleEnd, roleLabel } from './team-model';

	/**
	 * The roles a group gives its members, in this tenant, each with an optional end. "Add role"
	 * gives one more; a row's menu changes its end or removes it. A change someone else made to
	 * the group first reloads it.
	 */
	interface Props {
		groups: AdminGroupsClient;
		/** Lists the roles to offer. */
		team: AdminTeamClient;
		group: AdminGroupDetail;
		access: TeamAccess;
		onchanged: () => Promise<void>;
		/** Override the zone times are typed in (tests; normally the admin's choice). */
		zone?: TimeZoneMode;
	}

	let { groups, team, group, access, onchanged, zone }: Props = $props();

	const inZone = untrack(() => zone ?? timePreference.zone);
	const zoneNote = t('range.zone', { zone: inZone === 'utc' ? 'UTC' : t('range.local') });

	let busy = $state(false);
	let error = $state('');
	let adding = $state(false);
	let roles = $state<RoleChoice[] | null>(null);
	let roleId = $state('');
	let addEnds = $state('');
	let addEndsBad = $state(false);
	let changing = $state<AdminGroupGrant | null>(null);
	let changeEnds = $state('');
	let changeEndsBad = $state(false);
	let removing = $state<AdminGroupGrant | null>(null);

	const label = (grant: AdminGroupGrant) =>
		roleLabel({ name: grant.role_name, display_name: grant.role_display_name });
	const badInput = (event: Event & { currentTarget: HTMLInputElement }) =>
		event.currentTarget.validity.badInput;

	async function openAdd() {
		error = '';
		roleId = '';
		addEnds = '';
		addEndsBad = false;
		adding = true;
		if (roles) return;
		try {
			roles = grantableRoles(await team.listRoles());
		} catch (failure) {
			error = t(teamErrorKey(failure, 'tm.new.loadFailed'));
		}
	}

	/** Runs a change; a refusal stays in the dialog (or a toast), a group changed meanwhile reloads. */
	async function run(change: () => Promise<void>, done: string, conflict?: 'tg.error.grantHeld') {
		busy = true;
		error = '';
		try {
			await change();
			toast.success(done);
			adding = false;
			changing = null;
			removing = null;
			await onchanged();
		} catch (failure) {
			const message = t(teamErrorKey(failure, 'tm.error.generic', conflict));
			if (removing) {
				removing = null;
				toast.error(message);
			} else {
				error = message;
			}
			// Any 409 (changed meanwhile, the role given by someone else first): load the group again,
			// and drop a pick that the group now gives.
			if (failure instanceof ConflictError) {
				await onchanged();
				if (group.grants.some((grant) => grant.role_id === roleId)) roleId = '';
			}
		} finally {
			busy = false;
		}
	}

	function add() {
		const role = roles?.find((item) => item.id === roleId);
		if (!role) {
			error = t('tm.new.roleRequired');
			return;
		}
		const end = readRoleEnd(addEnds, addEndsBad, inZone);
		if (end.problem) {
			error = t(end.problem);
			return;
		}
		void run(
			() => groups.addGrant(group.id, { role_id: role.id, expires_at: end.ms }),
			t('tg.toast.grantAdded', { role: roleLabel(role) }),
			'tg.error.grantHeld'
		);
	}

	function openChange(grant: AdminGroupGrant) {
		error = '';
		changeEnds = grant.expires_at
			? toInputValue(new Date(grant.expires_at).toISOString(), inZone)
			: '';
		changeEndsBad = false;
		changing = grant;
	}

	function change() {
		const grant = changing;
		if (!grant) return;
		const end = readRoleEnd(changeEnds, changeEndsBad, inZone);
		if (end.problem) {
			error = t(end.problem);
			return;
		}
		void run(
			() => groups.setGrantExpiry(group.id, grant.id, end.ms ?? null),
			t('tg.toast.grantExpiry', { role: label(grant) })
		);
	}

	function remove() {
		const grant = removing;
		if (!grant) return;
		void run(
			() => groups.removeGrant(group.id, grant.id),
			t('tg.toast.grantRemoved', { role: label(grant) })
		);
	}

	const actionsOf = (grant: AdminGroupGrant): MenuAction[] => [
		{
			label: t('tg.grants.expiry'),
			icon: 'calendar',
			disabled: busy,
			onselect: () => openChange(grant)
		},
		{
			label: t('tg.grants.remove'),
			icon: 'trash',
			danger: true,
			disabled: busy,
			onselect: () => (removing = grant)
		}
	];

	const given = $derived(new Set(group.grants.map((grant) => grant.role_id)));
	const roleOptions = $derived(
		(roles ?? [])
			.filter((role) => !given.has(role.id))
			.map((role) => ({ value: role.id, label: roleLabel(role) }))
	);
	const columns = $derived([
		{ key: 'role', label: t('tg.grants.col.role') },
		{ key: 'ends', label: t('tg.grants.col.ends'), width: '26%' },
		...(access.groupsEdit
			? [
					{
						key: 'actions',
						label: t('tg.grants.col.actions', { name: '' }),
						width: '56px',
						hideLabel: true
					}
				]
			: [])
	]);
</script>

<Card title={t('tg.grants')} description={t('tg.grants.desc')} flush>
	{#snippet actions()}
		{#if access.groupsGrant}
			<Button size="sm" icon="plus" onclick={openAdd}>{t('tg.grants.add')}</Button>
		{/if}
	{/snippet}
	<DataTable caption={t('tg.grants')} {columns} rows={group.grants} rowKey={(row) => row.id}>
		{#snippet cell(row, column)}
			{#if column.key === 'role'}
				<CellText
					title={label(row)}
					description={row.role_display_name ? row.role_name : undefined}
				/>
			{:else if column.key === 'ends'}
				{#if row.expires_at}
					<DateTime value={row.expires_at} stacked />
				{:else}
					{t('tm.d.noEnd')}
				{/if}
			{:else}
				<ActionMenu
					size="sm"
					label={t('tg.grants.col.actions', { name: label(row) })}
					actions={actionsOf(row)}
				/>
			{/if}
		{/snippet}
		{#snippet empty()}
			<EmptyState icon="shield" title={t('tg.grants.empty')} />
		{/snippet}
	</DataTable>
</Card>

<FormDialog
	open={adding}
	title={t('tg.grants.add.title')}
	description={t('tg.grants.add.desc')}
	submitLabel={t('tg.grants.add.submit')}
	{busy}
	{error}
	onsubmit={add}
	oncancel={() => (adding = false)}
>
	<Select
		label={t('tm.new.role')}
		options={roleOptions}
		placeholder
		required
		hint={t('tm.new.roleHint')}
		bind:value={roleId}
	/>
	<TextField
		label={t('tm.new.roleEnds')}
		type="datetime-local"
		hint={`${zoneNote} ${t('tm.new.roleEndsHint')}`}
		oninput={(event) => (addEndsBad = badInput(event))}
		onblur={(event) => (addEndsBad = badInput(event))}
		bind:value={addEnds}
	/>
</FormDialog>

<FormDialog
	open={changing !== null}
	title={t('tg.grants.expiry.title', { role: changing ? label(changing) : '' })}
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
	title={t('tg.grants.remove.title', { role: removing ? label(removing) : '' })}
	body={t('tg.grants.remove.body')}
	confirmLabel={t('tg.grants.remove')}
	tone="danger"
	{busy}
	onconfirm={remove}
	oncancel={() => (removing = null)}
/>
