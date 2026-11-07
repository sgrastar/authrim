<script lang="ts">
	import type { TeamAccess } from '#lib/access/access.js';
	import type {
		AdminGroupDetail,
		AdminGroupMember,
		AdminGroupsClient
	} from '#lib/api/admin-groups.js';
	import { teamErrorCode, type AdminTeamClient } from '#lib/api/admin-team.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import Card from '#lib/ui/patterns/Card.svelte';
	import CellText from '#lib/ui/patterns/CellText.svelte';
	import ConfirmDialog from '#lib/ui/patterns/ConfirmDialog.svelte';
	import DataTable from '#lib/ui/patterns/DataTable.svelte';
	import EmptyState from '#lib/ui/patterns/EmptyState.svelte';
	import EntityPicker, { type PickerItem } from '#lib/ui/patterns/EntityPicker.svelte';
	import FormDialog from '#lib/ui/patterns/FormDialog.svelte';
	import ActionMenu from '#lib/ui/primitives/ActionMenu.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import DateTime from '#lib/ui/time/DateTime.svelte';
	import { toast } from '#lib/ui/toast/toast.svelte.js';
	import { teamErrorKey } from './team-errors';

	/**
	 * A group's members: who holds its roles. "Add members" finds administrators by address and
	 * adds the ones picked, one after another (each is its own change, checked by the API); a
	 * row's menu removes one. A change someone else made first reloads the group.
	 */
	interface Props {
		groups: AdminGroupsClient;
		/** Finds the administrators to add. */
		team: AdminTeamClient;
		group: AdminGroupDetail;
		access: TeamAccess;
		/** Opens an administrator's page. */
		onopenadmin?: (adminId: string) => void;
		onchanged: () => Promise<void>;
	}

	let { groups, team, group, access, onopenadmin, onchanged }: Props = $props();

	let adding = $state(false);
	let picked = $state<PickerItem[]>([]);
	let removing = $state<AdminGroupMember | null>(null);
	let busy = $state(false);
	let error = $state('');

	const labelOf = (member: Pick<AdminGroupMember, 'name' | 'email' | 'admin_user_id'>) =>
		member.name?.trim() || member.email || member.admin_user_id;

	async function search(query: string, signal: AbortSignal): Promise<PickerItem[]> {
		const page = await team.listAdmins({ page: 1, limit: 20, email: query || undefined }, signal);
		const inGroup = new Set(group.members.map((member) => member.admin_user_id));
		return page.admins
			.filter((admin) => !inGroup.has(admin.id))
			.map((admin) => ({
				value: admin.id,
				label: admin.name?.trim() || admin.email,
				description: admin.name ? admin.email : undefined,
				icon: 'userCircle' as const
			}));
	}

	function openAdd() {
		picked = [];
		error = '';
		adding = true;
	}

	/** Reload after a refusal that means the group is not what was shown. */
	async function reloadIfChanged(failure: unknown) {
		if (teamErrorCode(failure) === 'admin_group_changed') await onchanged();
	}

	async function add() {
		if (picked.length === 0) {
			error = t('tg.members.add.none');
			return;
		}
		busy = true;
		error = '';
		let added = 0;
		try {
			for (const item of picked) {
				await groups.addMember(group.id, item.value);
				added += 1;
			}
			adding = false;
			toast.success(t('tg.toast.membersAdded', { count: added }));
			await onchanged();
		} catch (failure) {
			const stopped = picked[added];
			picked = picked.slice(added);
			const reason = t(teamErrorKey(failure));
			error =
				added > 0
					? t('tg.members.addedSome', { added, name: stopped?.label ?? '', reason })
					: reason;
			if (added > 0) await onchanged();
			else await reloadIfChanged(failure);
		} finally {
			busy = false;
		}
	}

	async function remove() {
		const member = removing;
		if (!member) return;
		busy = true;
		try {
			await groups.removeMember(group.id, member.admin_user_id);
			toast.success(t('tg.toast.memberRemoved', { name: labelOf(member) }));
			await onchanged();
		} catch (failure) {
			toast.error(t(teamErrorKey(failure)));
			await reloadIfChanged(failure);
		} finally {
			removing = null;
			busy = false;
		}
	}

	const columns = $derived([
		{ key: 'admin', label: t('tg.members.col.admin') },
		{ key: 'added', label: t('tg.members.col.added'), width: '26%' },
		...(access.groupsEdit
			? [
					{
						key: 'actions',
						label: t('tg.members.col.actions', { name: '' }),
						width: '56px',
						hideLabel: true
					}
				]
			: [])
	]);
</script>

<Card title={t('tg.members')} description={t('tg.members.desc')} flush>
	{#snippet actions()}
		{#if access.groupsEdit}
			<Button size="sm" icon="userPlus" onclick={openAdd}>{t('tg.members.add')}</Button>
		{/if}
	{/snippet}
	<DataTable
		caption={t('tg.members')}
		{columns}
		rows={group.members}
		rowKey={(row) => row.id}
		onrowopen={onopenadmin && ((row) => onopenadmin(row.admin_user_id))}
		rowOpenLabel={(row) => t('tm.list.open', { name: labelOf(row) })}
	>
		{#snippet cell(row, column)}
			{#if column.key === 'admin'}
				<CellText
					title={labelOf(row)}
					description={row.name ? (row.email ?? undefined) : undefined}
				/>
			{:else if column.key === 'added'}
				<DateTime value={row.created_at} stacked />
			{:else}
				<ActionMenu
					size="sm"
					label={t('tg.members.col.actions', { name: labelOf(row) })}
					actions={[
						{
							label: t('tg.members.remove'),
							icon: 'trash',
							danger: true,
							disabled: busy,
							onselect: () => (removing = row)
						}
					]}
				/>
			{/if}
		{/snippet}
		{#snippet empty()}
			<EmptyState icon="users" title={t('tg.members.empty')} />
		{/snippet}
	</DataTable>
</Card>

<FormDialog
	open={adding}
	title={t('tg.members.add.title')}
	description={t('tg.members.add.desc')}
	submitLabel={t('tg.members.add.submit')}
	{busy}
	{error}
	onsubmit={add}
	oncancel={() => (adding = false)}
>
	<EntityPicker
		label={t('tg.members.add.pick')}
		placeholder={t('tg.members.add.placeholder')}
		multiple
		{search}
		bind:items={picked}
	/>
</FormDialog>

<ConfirmDialog
	open={removing !== null}
	title={t('tg.members.remove.title', { name: removing ? labelOf(removing) : '' })}
	body={t('tg.members.remove.body')}
	confirmLabel={t('tg.members.remove')}
	tone="danger"
	{busy}
	onconfirm={remove}
	oncancel={() => (removing = null)}
/>
